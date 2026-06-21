import { ConflictError, NotFoundError } from '../errors.js';
import { assertWritable } from '../read-only-mode.js';
import { applyJsonPatch } from './json-patch.js';

export const PRESET_FOLDER_BY_API_ID = Object.freeze({
    kobold: 'koboldAI_Settings',
    koboldhorde: 'koboldAI_Settings',
    novel: 'novelAI_Settings',
    textgenerationwebui: 'textGen_Settings',
    openai: 'openAI_Settings',
    instruct: 'instruct',
    context: 'context',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
});

export class PresetRepo {
    constructor({ engine }) { this._engine = engine; }

    _key(handle, apiId, name) {
        const dirKey = PRESET_FOLDER_BY_API_ID[apiId];
        if (!dirKey) throw new Error(`PresetRepo: invalid apiId ${apiId}`);
        return { kind: 'preset', handle, dirKey, name };
    }

    async get(handle, apiId, name) {
        return this._engine.withTransaction(handle, (tx) => tx.getResource(this._key(handle, apiId, name)));
    }

    async save(handle, apiId, name, doc) {
        assertWritable();
        await this._engine.withTransaction(handle, (tx) =>
            tx.putResource(this._key(handle, apiId, name), { doc }));
    }

    async delete(handle, apiId, name) {
        assertWritable();
        return this._engine.withTransaction(handle, (tx) => tx.deleteResource(this._key(handle, apiId, name)));
    }

    async exists(handle, apiId, name) {
        const got = await this._engine.withTransaction(handle, (tx) => tx.getResource(this._key(handle, apiId, name)));
        return got != null;
    }

    async patch(handle, apiId, name, ops) {
        assertWritable();
        return this._engine.withTransaction(handle, async (tx) => {
            const key = this._key(handle, apiId, name);
            const existing = await tx.getResource(key);
            if (existing == null) throw new NotFoundError('preset', { handle, apiId, name });
            const next = applyJsonPatch(existing, ops);
            await tx.putResource(key, { doc: next });
            return next;
        });
    }

    async getState(handle, apiId, name, namespace) {
        return this._engine.withTransaction(handle, (tx) =>
            tx.getPresetState(this._key(handle, apiId, name), namespace));
    }

    async setState(handle, apiId, name, namespace, doc) {
        assertWritable();
        await this._engine.withTransaction(handle, (tx) =>
            tx.putPresetState(this._key(handle, apiId, name), namespace, doc));
    }

    async deleteState(handle, apiId, name, namespace) {
        assertWritable();
        return this._engine.withTransaction(handle, (tx) =>
            tx.deletePresetState(this._key(handle, apiId, name), namespace));
    }

    async deleteAllStates(handle, apiId, name) {
        assertWritable();
        return this._engine.withTransaction(handle, async (tx) => {
            const key = this._key(handle, apiId, name);
            const namespaces = await tx.listPresetStateNamespaces(key);
            let deleted = 0;
            for (const ns of namespaces) {
                const removed = await tx.deletePresetState(key, ns);
                if (removed) deleted++;
            }
            return deleted;
        });
    }

    async renameStates(handle, apiId, oldName, newName) {
        assertWritable();
        return this._engine.withTransaction(handle, async (tx) => {
            const oldKey = this._key(handle, apiId, oldName);
            const newKey = this._key(handle, apiId, newName);
            const namespaces = await tx.listPresetStateNamespaces(oldKey);
            if (namespaces.length === 0) return 0;
            for (const ns of namespaces) {
                const conflict = await tx.getPresetState(newKey, ns);
                if (conflict != null) {
                    throw new ConflictError('preset_state_rename_collision', { newName, namespace: ns });
                }
            }
            let renamed = 0;
            for (const ns of namespaces) {
                const doc = await tx.getPresetState(oldKey, ns);
                await tx.putPresetState(newKey, ns, doc);
                await tx.deletePresetState(oldKey, ns);
                renamed++;
            }
            return renamed;
        });
    }

    async list(handle, apiId) {
        const dirKey = PRESET_FOLDER_BY_API_ID[apiId];
        if (!dirKey) throw new Error(`PresetRepo.list: invalid apiId ${apiId}`);
        // FS handler reads `apiId`; SQLite handler reads `dirKey`. Pass both so
        // each engine picks the one it needs.
        return this._engine.withTransaction(handle, (tx) =>
            tx.listResources({ kind: 'preset', handle, apiId, dirKey }));
    }

    // Like list(), but also fetches each preset's full doc in the same
    // transaction. Used by endpoints that need to ship preset *contents* to
    // the client (e.g. /api/settings/get and /api/settings/bootstrap). Doing
    // this in a single withTransaction means SQL engines reuse one connection
    // and FS mode opens each file once instead of round-tripping through the
    // Repo. Sorted by name ASC to match FS readdir's default presentation.
    async listWithDocs(handle, apiId) {
        const dirKey = PRESET_FOLDER_BY_API_ID[apiId];
        if (!dirKey) throw new Error(`PresetRepo.listWithDocs: invalid apiId ${apiId}`);
        return this._engine.withTransaction(handle, async (tx) => {
            const entries = await tx.listResources({ kind: 'preset', handle, apiId, dirKey });
            const out = [];
            for (const entry of entries) {
                const name = entry?.key?.name;
                if (!name) continue;
                const doc = await tx.getResource({ kind: 'preset', handle, dirKey, name });
                if (doc != null) out.push({ name, doc });
            }
            out.sort((a, b) => a.name.localeCompare(b.name));
            return out;
        });
    }

    async listStateNamespaces(handle, apiId, name) {
        return this._engine.withTransaction(handle, (tx) =>
            tx.listPresetStateNamespaces(this._key(handle, apiId, name)));
    }
}
