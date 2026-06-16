import { assertWritable } from '../read-only-mode.js';

export class StatsRepo {
    constructor({ engine }) { this._engine = engine; }
    _key(handle) { return { kind: 'stats', handle }; }

    async get(handle) {
        return this._engine.withTransaction(handle, (tx) => tx.getResource(this._key(handle)));
    }

    async save(handle, doc) {
        assertWritable();
        await this._engine.withTransaction(handle, (tx) => tx.putResource(this._key(handle), { doc }));
    }
}
