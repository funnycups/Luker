import _ from 'lodash';

import { assertWritable } from '../read-only-mode.js';
import { applyJsonPatch } from './json-patch.js';
import { withWorldDeletion, createWorldIdentityResolver } from '../world-reference-coordination.js';

export class WorldInfoRepo {
    constructor({ engine }) { this._engine = engine; }

    _key(handle, name) { return { kind: 'world', handle, name }; }

    async get(handle, name) {
        return this._engine.withTransaction(handle, (tx) => tx.getResource(this._key(handle, name)));
    }

    async save(handle, name, doc) {
        assertWritable();
        if (!_.isObjectLike(doc) || Array.isArray(doc) || !_.isObjectLike(doc.entries) || Array.isArray(doc.entries)) {
            throw new Error('WorldInfoRepo.save: doc must be an object with an entries object');
        }
        return this._engine.withTransaction(handle, (tx) => tx.putResource(this._key(handle, name), { doc }));
    }

    async getVersion(handle, name) {
        return this._engine.withTransaction(handle, (tx) => tx.getWorldInfoVersion(this._key(handle, name)));
    }

    async delete(handle, name, { expectedVersion, beforeDelete } = {}) {
        assertWritable();
        const remove = resolvedTarget => this._engine.withTransaction(handle, (tx) => tx.deleteResource(this._key(handle, name), { expectedVersion, resolvedTarget }));
        return expectedVersion !== undefined || beforeDelete
            ? withWorldDeletion(this._engine, handle, name, remove, beforeDelete)
            : remove();
    }

    async exists(handle, name) {
        return this._engine.withTransaction(handle, async (tx) => {
            const canonical = await tx.resolveWorldName(this._key(handle, name));
            return canonical != null;
        });
    }

    async captureIdentity(handle) {
        const catalog = await this._engine.withTransaction(handle, tx => tx.captureWorldInfoIdentity(handle));
        return createWorldIdentityResolver(catalog);
    }

    async patch(handle, name, ops) {
        assertWritable();
        return this._engine.withTransaction(handle, async (tx) => {
            const key = this._key(handle, name);
            const existing = await tx.getResource(key);
            const seed = (_.isObjectLike(existing) && !Array.isArray(existing)) ? existing : { entries: {} };
            const next = applyJsonPatch(seed, ops);
            if (!_.isObjectLike(next) || Array.isArray(next)) {
                throw new Error('World info patch must produce an object root.');
            }
            if (!('entries' in next) || !_.isObjectLike(next.entries) || Array.isArray(next.entries)) {
                throw new Error('World info patch must keep a valid entries object.');
            }
            await tx.putResource(key, { doc: next });
            return next;
        });
    }

    async list(handle) {
        return this._engine.withTransaction(handle, (tx) => tx.listResources({ kind: 'world', handle }));
    }

    // Convenience: just the canonical names, sorted. Used by buildSettingsResponse
    // and the resource directory. Reads names without opening or parsing every book.
    async listNames(handle) {
        const names = await this._engine.withTransaction(handle, (tx) => tx.listWorldNames(handle));
        return names
            .filter((name) => typeof name === 'string' && name.length > 0)
            .sort((a, b) => a.localeCompare(b));
    }

    async resolveName(handle, requested) {
        return this._engine.withTransaction(handle, (tx) => tx.resolveWorldName(this._key(handle, requested)));
    }
}
