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

    // Migration needs to enumerate + read named-docs cross-engine. Earlier
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

    // Like list(), but also fetches each doc's body in the same transaction.
    // Used by endpoints that need to ship named-doc contents to the client
    // (e.g. /api/settings/get and /api/settings/bootstrap surface themes /
    // movingUI / quickReplies as full objects, not just names).
    async listWithDocs(handle, bucket) {
        this._key(handle, bucket, '__list__');
        return this._engine.withTransaction(handle, async (tx) => {
            const entries = await tx.listResources({ kind: 'named-doc', handle, bucket });
            const out = [];
            for (const entry of entries) {
                const name = entry?.key?.name;
                if (!name) continue;
                const doc = await tx.getResource({ kind: 'named-doc', handle, bucket, name });
                if (doc != null) out.push({ name, doc });
            }
            out.sort((a, b) => a.name.localeCompare(b.name));
            return out;
        });
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
