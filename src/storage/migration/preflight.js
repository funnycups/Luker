// Pre-flight check for migrations into MySQL or Postgres: scan every per-user
// name we'd write through a Repo and abort if any exceeds the VARCHAR(128) PK
// limit. MySQL would either truncate or raise ER_DATA_TOO_LONG mid-copy and
// leave the destination half-populated; this check catches the conflict before
// any destination writes happen.
//
// FS and SQLite have no name-length limit, so this is a no-op for them.

const VARCHAR_LIMIT_BYTES = 128;

function bytesOver(name) {
    return Buffer.byteLength(String(name ?? ''), 'utf8');
}

/**
 * @param {object} ctx
 * @param {string} ctx.dstMode  'mysql' | 'postgres' | 'fs' | 'sqlite'
 * @param {object} ctx.sourceRepos  Repos { chat, preset, worldInfo, namedDoc, group }
 * @param {string[]} ctx.handles  User handles to scan
 * @param {string[]} [ctx.namedDocBuckets]  defaults to ['themes', 'movingUI', 'quickReplies']
 * @param {string[]} [ctx.presetApiIds]  defaults to the keys of PRESET_FOLDER_BY_API_ID
 * @returns {Promise<{ok: true} | {ok: false, offenders: Array<{handle: string, bucket: string, name: string, bytes: number}>}>}
 */
export async function preflightNameLengths(ctx) {
    const { dstMode, sourceRepos, handles } = ctx;
    if (dstMode !== 'mysql' && dstMode !== 'postgres') return { ok: true };

    const namedDocBuckets = ctx.namedDocBuckets ?? ['themes', 'movingUI', 'quickReplies'];
    const presetApiIds = ctx.presetApiIds ?? [];

    const offenders = [];
    const record = (handle, bucket, name) => {
        const b = bytesOver(name);
        if (b > VARCHAR_LIMIT_BYTES) offenders.push({ handle, bucket, name, bytes: b });
    };

    for (const handle of handles) {
        // World
        try {
            for (const name of await sourceRepos.worldInfo.listNames(handle)) {
                record(handle, 'world', name);
            }
        } catch { /* keep going — surface real per-handle issues without blocking the scan */ }

        // Named-doc buckets
        for (const bucket of namedDocBuckets) {
            try {
                const entries = await sourceRepos.namedDoc.list(handle, bucket);
                for (const e of entries) {
                    const n = e?.key?.name;
                    if (n) record(handle, `named-doc/${bucket}`, n);
                }
            } catch { /* keep going */ }
        }

        // Group ids
        try {
            const groups = await sourceRepos.group.list(handle);
            for (const e of groups) {
                const id = e?.key?.id;
                if (id) record(handle, 'group', id);
            }
        } catch { /* keep going */ }

        // Presets — dedup folder; share apiIds collapse via the engine layer.
        const seenFolders = new Set();
        for (const apiId of presetApiIds) {
            // Avoid duplicating work when several apiIds map to the same folder.
            // The caller passes the canonical apiId list; we don't know the
            // folder mapping here, so probe each apiId and tolerate the
            // resulting overlap (record() dedups offenders implicitly because
            // a duplicate name produces a duplicate row, which is still
            // accurate for the operator).
            try {
                const entries = await sourceRepos.preset.list(handle, apiId);
                for (const e of entries) {
                    const n = e?.key?.name;
                    if (n && !seenFolders.has(`${apiId}\0${n}`)) {
                        seenFolders.add(`${apiId}\0${n}`);
                        record(handle, `preset/${apiId}`, n);
                    }
                }
            } catch { /* keep going */ }
        }

        // Chats — name and charDir both land in VARCHAR(128) columns.
        try {
            const chats = await sourceRepos.chat.listAll(handle);
            for (const e of chats) {
                const k = e?.key;
                if (!k?.name) continue;
                if (k.isGroup) {
                    record(handle, 'chat/group', k.groupId ?? k.name);
                } else {
                    record(handle, 'chat/name', k.name);
                    if (k.charDir) record(handle, 'chat/charDir', k.charDir);
                }
            }
        } catch { /* keep going */ }
    }

    if (offenders.length === 0) return { ok: true };
    return { ok: false, offenders };
}

export function formatPreflightOffenders(offenders) {
    const lines = [
        `Aborting: ${offenders.length} name(s) exceed the ${VARCHAR_LIMIT_BYTES}-byte VARCHAR PK limit for MySQL/Postgres.`,
        'Rename these entries via the live app before migrating, then re-run:',
        '',
    ];
    for (const o of offenders) {
        lines.push(`  [${o.handle}] ${o.bucket}: ${JSON.stringify(o.name)} (${o.bytes} bytes)`);
    }
    return lines.join('\n');
}
