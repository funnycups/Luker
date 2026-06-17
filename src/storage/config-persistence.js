import { promises as fsPromises } from 'node:fs';
import yaml from 'yaml';

/**
 * Resolve a mysql/postgres backend's connection settings from two sources:
 * a request body (or any caller-supplied object) and an existing config
 * snapshot (or any caller-supplied object) read from config.yaml.
 *
 * Inline values win field-by-field. The returned `inlineFields` object names
 * the fields the caller typed — `persistStorageBackendToConfig` writes only
 * those back to config.yaml, so URL-only inputs don't clobber an existing
 * poolSize and vice versa.
 *
 * @param {object} opts
 * @param {object | null | undefined} opts.inline   Body-supplied object (may be partial).
 * @param {object | null | undefined} opts.fromConfig  Config snapshot for the same mode.
 * @returns {{ engine: { url: string, poolSize?: number }, inlineFields: { url?: string, poolSize?: number } | null } | null}
 *          Returns null when neither source supplied a non-empty URL.
 */
export function resolveStorageDbConfig({ inline, fromConfig }) {
    const inlineObj = (inline && typeof inline === 'object') ? inline : null;
    const inlineUrl = (inlineObj && typeof inlineObj.url === 'string' && inlineObj.url) ? inlineObj.url : null;
    const inlinePoolSize = (inlineObj && Number.isFinite(inlineObj.poolSize)) ? inlineObj.poolSize : null;

    const configObj = (fromConfig && typeof fromConfig === 'object') ? fromConfig : null;
    const configUrl = (configObj && typeof configObj.url === 'string' && configObj.url) ? configObj.url : null;
    const configPoolSize = (configObj && Number.isFinite(configObj.poolSize)) ? configObj.poolSize : null;

    const url = inlineUrl ?? configUrl;
    if (!url) return null;

    const engine = { url };
    const effectivePoolSize = inlinePoolSize ?? configPoolSize;
    if (effectivePoolSize !== null) engine.poolSize = effectivePoolSize;

    const inlineFields = {};
    if (inlineUrl) inlineFields.url = inlineUrl;
    if (inlinePoolSize !== null) inlineFields.poolSize = inlinePoolSize;

    return {
        engine,
        inlineFields: Object.keys(inlineFields).length > 0 ? inlineFields : null,
    };
}

/**
 * Rewrite the `storage` block of a config.yaml file to reflect the choice
 * just committed by the admin migration endpoint, preserving every other
 * key, comment, and whitespace decision in the file.
 *
 * The function only mutates keys it has a concrete new value for:
 *   - `storage.mode` is always written (every migration changes it).
 *   - `storage.mysql.url` / `storage.mysql.poolSize` are written only if
 *     `mysqlInline` carries that field. Same for postgres.
 *
 * That asymmetry is intentional: credentials sourced from config.yaml at
 * resolve time are already in the file; rewriting them would lose useful
 * formatting (line wrapping, surrounding comments) for zero gain. Inline
 * credentials, by contrast, came from the admin panel and need to land in
 * the file or they're lost on restart.
 *
 * Returns `{ ok: false, error }` rather than throwing so the caller can
 * include the failure in the migration response without aborting it — the
 * data has already moved by the time we get here.
 *
 * @param {object} opts
 * @param {string} opts.configPath Absolute path to config.yaml.
 * @param {(parsed: unknown) => { codes: string[], errors: string[] }} opts.safetyCheck
 *        Same safety gate /config/save runs. Wired in by the caller so this
 *        module doesn't depend on the users-admin layer.
 * @param {'fs'|'sqlite'|'mysql'|'postgres'} opts.targetMode
 * @param {{ url?: string, poolSize?: number } | null} [opts.mysqlInline]
 * @param {{ url?: string, poolSize?: number } | null} [opts.postgresInline]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function persistStorageBackendToConfig(opts) {
    const { configPath, safetyCheck, targetMode, mysqlInline = null, postgresInline = null } = opts;
    if (typeof configPath !== 'string' || !configPath) {
        return { ok: false, error: 'config_path_missing' };
    }
    if (typeof safetyCheck !== 'function') {
        return { ok: false, error: 'safety_check_missing' };
    }
    try {
        const content = await fsPromises.readFile(configPath, 'utf8');
        const newContent = rewriteStorageBlock(content, {
            targetMode,
            mysqlInline,
            postgresInline,
        });

        const parsedAfter = yaml.parse(newContent);
        const { codes, errors } = safetyCheck(parsedAfter);
        if (codes.length > 0) {
            return { ok: false, error: `config_safety: ${errors.join(' ')}` };
        }

        await fsPromises.writeFile(configPath, newContent, 'utf8');
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/**
 * Pure (no IO) variant exported for testing: takes a YAML string, returns
 * the rewritten YAML string. Comment-preserving via `yaml.parseDocument`.
 *
 * @param {string} content
 * @param {{
 *     targetMode: 'fs'|'sqlite'|'mysql'|'postgres',
 *     mysqlInline: { url?: string, poolSize?: number } | null,
 *     postgresInline: { url?: string, poolSize?: number } | null,
 * }} opts
 * @returns {string}
 */
export function rewriteStorageBlock(content, opts) {
    const { targetMode, mysqlInline, postgresInline } = opts;
    const doc = yaml.parseDocument(content);
    doc.setIn(['storage', 'mode'], targetMode);
    if (targetMode === 'mysql' && mysqlInline) {
        if (typeof mysqlInline.url === 'string' && mysqlInline.url) {
            doc.setIn(['storage', 'mysql', 'url'], mysqlInline.url);
        }
        if (Number.isFinite(mysqlInline.poolSize)) {
            doc.setIn(['storage', 'mysql', 'poolSize'], mysqlInline.poolSize);
        }
    }
    if (targetMode === 'postgres' && postgresInline) {
        if (typeof postgresInline.url === 'string' && postgresInline.url) {
            doc.setIn(['storage', 'postgres', 'url'], postgresInline.url);
        }
        if (Number.isFinite(postgresInline.poolSize)) {
            doc.setIn(['storage', 'postgres', 'poolSize'], postgresInline.poolSize);
        }
    }
    return doc.toString();
}
