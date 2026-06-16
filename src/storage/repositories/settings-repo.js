import { NotFoundError } from '../errors.js';
import { assertWritable } from '../read-only-mode.js';
import { applyJsonPatch } from './json-patch.js';

export class SettingsRepo {
    constructor({ engine }) { this._engine = engine; }
    _key(handle) { return { kind: 'settings', handle }; }

    async get(handle) {
        return this._engine.withTransaction(handle, (tx) => tx.getResource(this._key(handle)));
    }

    async save(handle, doc) {
        assertWritable();
        await this._engine.withTransaction(handle, (tx) => tx.putResource(this._key(handle), { doc }));
    }

    async patch(handle, ops) {
        assertWritable();
        return this._engine.withTransaction(handle, async (tx) => {
            const existing = await tx.getResource(this._key(handle));
            if (existing == null) throw new NotFoundError('settings', { handle });
            const next = applyJsonPatch(existing, ops);
            await tx.putResource(this._key(handle), { doc: next });
            return next;
        });
    }
}
