import _ from 'lodash';

import { assertWritable } from '../read-only-mode.js';
import { applyJsonPatch } from './json-patch.js';

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
        await this._engine.withTransaction(handle, (tx) => tx.putResource(this._key(handle, name), { doc }));
    }

    async delete(handle, name) {
        assertWritable();
        return this._engine.withTransaction(handle, (tx) => tx.deleteResource(this._key(handle, name)));
    }

    async exists(handle, name) {
        return this._engine.withTransaction(handle, async (tx) => {
            const canonical = await tx.resolveWorldName(this._key(handle, name));
            return canonical != null;
        });
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

    async resolveName(handle, requested) {
        return this._engine.withTransaction(handle, (tx) => tx.resolveWorldName(this._key(handle, requested)));
    }
}
