import { NotFoundError } from '../errors.js';
import { assertWritable } from '../read-only-mode.js';

export const BUCKET_TO_DIR = Object.freeze({
    themes: 'themes',
    movingUI: 'movingUI',
    quickReplies: 'quickreplies',
});

export class NamedDocRepo {
    constructor({ engine }) { this._engine = engine; }

    _key(handle, bucket, name) {
        if (!Object.prototype.hasOwnProperty.call(BUCKET_TO_DIR, bucket)) {
            throw new Error(`NamedDocRepo: invalid bucket ${bucket}`);
        }
        return { kind: 'named-doc', handle, bucket, name };
    }

    async save(handle, bucket, name, doc) {
        assertWritable();
        await this._engine.withTransaction(handle, (tx) =>
            tx.putResource(this._key(handle, bucket, name), { doc }));
    }

    // Migration needs to enumerate + read named-docs cross-engine. The Phase 1b
    // cleanup removed get/list as speculative API; restoring them now that
    // MigrationRunner is a real caller.
    async get(handle, bucket, name) {
        return this._engine.withTransaction(handle, (tx) =>
            tx.getResource(this._key(handle, bucket, name)));
    }

    async list(handle, bucket) {
        // _key validates bucket — call it for the side effect to fail fast on
        // unknown buckets, then drop the per-name field for the filter.
        this._key(handle, bucket, '__list__');
        return this._engine.withTransaction(handle, (tx) =>
            tx.listResources({ kind: 'named-doc', handle, bucket }));
    }

    async delete(handle, bucket, name, { strict = false } = {}) {
        assertWritable();
        const removed = await this._engine.withTransaction(handle, (tx) =>
            tx.deleteResource(this._key(handle, bucket, name)));
        if (!removed && strict) {
            throw new NotFoundError('named-doc', { handle, bucket, name });
        }
        return removed;
    }
}
