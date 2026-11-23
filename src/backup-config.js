import { promises as fsPromises } from 'node:fs';
import yaml from 'yaml';
import { getConfigEnvKeys, getConfigValue } from './util.js';

export const BACKUP_CONFIG_DEFAULTS = Object.freeze({
    allowFullDataBackup: true,
    common: Object.freeze({
        numberOfBackups: 50,
    }),
    chat: Object.freeze({
        enabled: true,
        checkIntegrity: true,
        maxTotalBackups: -1,
        throttleInterval: 10000,
    }),
});

/**
 * Metadata describing every supported key under `backups` in `config.yaml`.
 * @type {ReadonlyArray<{ dotKey: string, path: string[], type: 'boolean'|'number', defaultValue: boolean|number }>}
 */
const BACKUP_FIELDS = Object.freeze([
    { dotKey: 'backups.allowFullDataBackup', path: ['allowFullDataBackup'], type: 'boolean', defaultValue: BACKUP_CONFIG_DEFAULTS.allowFullDataBackup },
    { dotKey: 'backups.common.numberOfBackups', path: ['common', 'numberOfBackups'], type: 'number', defaultValue: BACKUP_CONFIG_DEFAULTS.common.numberOfBackups },
    { dotKey: 'backups.chat.enabled', path: ['chat', 'enabled'], type: 'boolean', defaultValue: BACKUP_CONFIG_DEFAULTS.chat.enabled },
    { dotKey: 'backups.chat.checkIntegrity', path: ['chat', 'checkIntegrity'], type: 'boolean', defaultValue: BACKUP_CONFIG_DEFAULTS.chat.checkIntegrity },
    { dotKey: 'backups.chat.maxTotalBackups', path: ['chat', 'maxTotalBackups'], type: 'number', defaultValue: BACKUP_CONFIG_DEFAULTS.chat.maxTotalBackups },
    { dotKey: 'backups.chat.throttleInterval', path: ['chat', 'throttleInterval'], type: 'number', defaultValue: BACKUP_CONFIG_DEFAULTS.chat.throttleInterval },
]);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function coerceConfigScalar(raw, defaultValue, type) {
    if (raw === undefined || raw === null) {
        return defaultValue;
    }
    if (type === 'boolean') {
        if (typeof raw === 'boolean') return raw;
        const lower = String(raw).trim().toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
        return defaultValue;
    }
    if (type === 'number') {
        const parsed = parseFloat(raw);
        return Number.isNaN(parsed) ? defaultValue : parsed;
    }
    return raw;
}

function getNested(obj, pathParts) {
    let cursor = obj;
    for (const part of pathParts) {
        if (!isPlainObject(cursor)) return undefined;
        cursor = cursor[part];
    }
    return cursor;
}

function setNested(obj, pathParts, value) {
    let cursor = obj;
    for (let i = 0; i < pathParts.length - 1; i++) {
        const part = pathParts[i];
        if (!isPlainObject(cursor[part])) {
            cursor[part] = {};
        }
        cursor = cursor[part];
    }
    cursor[pathParts[pathParts.length - 1]] = value;
}

/**
 * Strictly validates a backup configuration payload submitted by the admin UI.
 * Rejects invalid types, non-integers, and out-of-range values with actionable
 * error messages instead of silently coercing or clamping.
 *
 * @param {unknown} raw Request body
 * @returns {{ ok: true, value: typeof BACKUP_CONFIG_DEFAULTS } | { ok: false, error: string }}
 */
export function validateBackupConfigPayload(raw) {
    if (!isPlainObject(raw)) {
        return { ok: false, error: 'Backup configuration payload must be an object.' };
    }
    if (!isPlainObject(raw.common)) {
        return { ok: false, error: 'Field "common" must be an object.' };
    }
    if (!isPlainObject(raw.chat)) {
        return { ok: false, error: 'Field "chat" must be an object.' };
    }

    if (typeof raw.allowFullDataBackup !== 'boolean') {
        return { ok: false, error: 'Field "allowFullDataBackup" must be a boolean.' };
    }

    const { numberOfBackups } = raw.common;
    if (typeof numberOfBackups !== 'number' || !Number.isInteger(numberOfBackups) || numberOfBackups < 0) {
        return { ok: false, error: 'Field "common.numberOfBackups" must be an integer >= 0.' };
    }

    const { enabled, checkIntegrity, maxTotalBackups, throttleInterval } = raw.chat;
    if (typeof enabled !== 'boolean') {
        return { ok: false, error: 'Field "chat.enabled" must be a boolean.' };
    }
    if (typeof checkIntegrity !== 'boolean') {
        return { ok: false, error: 'Field "chat.checkIntegrity" must be a boolean.' };
    }
    if (typeof maxTotalBackups !== 'number' || !Number.isInteger(maxTotalBackups) || maxTotalBackups < -1) {
        return { ok: false, error: 'Field "chat.maxTotalBackups" must be -1 (unlimited) or an integer >= 0.' };
    }
    if (typeof throttleInterval !== 'number' || !Number.isInteger(throttleInterval) || throttleInterval < 0) {
        return { ok: false, error: 'Field "chat.throttleInterval" must be an integer >= 0.' };
    }

    return {
        ok: true,
        value: {
            allowFullDataBackup: raw.allowFullDataBackup,
            common: {
                numberOfBackups,
            },
            chat: {
                enabled,
                checkIntegrity,
                maxTotalBackups,
                throttleInterval,
            },
        },
    };
}

/**
 * Ensures a YAML map node exists at `pathParts` inside `doc`, replacing null
 * or scalar placeholders so nested `setIn` calls never fail.
 * @param {import('yaml').Document} doc
 * @param {string[]} pathParts
 */
function ensureYamlMap(doc, pathParts) {
    const existing = doc.getIn(pathParts, true);
    if (!yaml.isMap(existing)) {
        doc.setIn(pathParts, doc.createNode({}));
    }
}

/**
 * Rewrites only the `backups` keys inside a YAML string while preserving all
 * comments, formatting, and unrelated keys.
 *
 * @param {string} yamlContent Existing `config.yaml` text
 * @param {{
 *   allowFullDataBackup: boolean,
 *   common: { numberOfBackups: number },
 *   chat: { enabled: boolean, checkIntegrity: boolean, maxTotalBackups: number, throttleInterval: number },
 * }} config Validated backup configuration
 * @returns {string} Updated YAML text
 */
export function rewriteBackupConfigBlock(yamlContent, config) {
    const doc = yaml.parseDocument(yamlContent);
    if (!yaml.isMap(doc.contents)) {
        doc.contents = doc.createNode({});
    }

    ensureYamlMap(doc, ['backups']);
    ensureYamlMap(doc, ['backups', 'common']);
    ensureYamlMap(doc, ['backups', 'chat']);

    doc.setIn(['backups', 'allowFullDataBackup'], config.allowFullDataBackup);
    doc.setIn(['backups', 'common', 'numberOfBackups'], config.common.numberOfBackups);
    doc.setIn(['backups', 'chat', 'enabled'], config.chat.enabled);
    doc.setIn(['backups', 'chat', 'checkIntegrity'], config.chat.checkIntegrity);
    doc.setIn(['backups', 'chat', 'maxTotalBackups'], config.chat.maxTotalBackups);
    doc.setIn(['backups', 'chat', 'throttleInterval'], config.chat.throttleInterval);

    return doc.toString();
}

/**
 * Reads backup config state from `config.yaml` together with live effective
 * values and any active environment variable overrides.
 *
 * @param {string} configPath Absolute path to `config.yaml`
 * @returns {Promise<{
 *   fileConfig: typeof BACKUP_CONFIG_DEFAULTS,
 *   effectiveConfig: typeof BACKUP_CONFIG_DEFAULTS,
 *   envOverrides: Record<string, { envKey: string, value: boolean|number }>,
 * }>}
 */
export async function readBackupConfigState(configPath) {
    const rawContent = await fsPromises.readFile(configPath, 'utf8');
    const parsed = yaml.parse(rawContent);
    const parsedBackups = isPlainObject(parsed?.backups) ? parsed.backups : {};

    const fileConfig = { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } };
    const effectiveConfig = { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } };
    const envOverrides = {};

    for (const field of BACKUP_FIELDS) {
        const fileVal = coerceConfigScalar(getNested(parsedBackups, field.path), field.defaultValue, field.type);
        const effectiveVal = getConfigValue(field.dotKey, field.defaultValue, field.type);

        setNested(fileConfig, field.path, fileVal);
        setNested(effectiveConfig, field.path, effectiveVal);

        const activeEnvKey = getConfigEnvKeys(field.dotKey).find(envKey => envKey in process.env);
        if (activeEnvKey) {
            envOverrides[field.dotKey] = {
                envKey: activeEnvKey,
                value: effectiveVal,
            };
        }
    }

    return {
        fileConfig,
        effectiveConfig,
        envOverrides,
    };
}

/**
 * Persists a validated backup configuration into `config.yaml`, preserving
 * comments and unrelated keys, and refusing to write if `safetyCheck` fails.
 *
 * @param {object} opts
 * @param {string} opts.configPath Absolute path to `config.yaml`
 * @param {(parsed: unknown) => { codes: string[], errors: string[] }} opts.safetyCheck Safety validator
 * @param {typeof BACKUP_CONFIG_DEFAULTS} opts.config Validated backup config
 * @returns {Promise<{ ok: true } | { ok: false, error: string, codes?: string[] }>}
 */
export async function persistBackupConfig(opts) {
    const { configPath, safetyCheck, config } = opts;
    if (typeof configPath !== 'string' || !configPath) {
        return { ok: false, error: 'Config path not initialized.' };
    }
    if (typeof safetyCheck !== 'function') {
        return { ok: false, error: 'Config safety check is required.' };
    }

    try {
        const content = await fsPromises.readFile(configPath, 'utf8');
        const updatedContent = rewriteBackupConfigBlock(content, config);

        const parsedAfter = yaml.parse(updatedContent);
        const { codes, errors } = safetyCheck(parsedAfter);
        if (codes.length > 0) {
            return { ok: false, error: errors.join(' '), codes };
        }

        await fsPromises.writeFile(configPath, updatedContent, 'utf8');
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error?.message || error) };
    }
}
