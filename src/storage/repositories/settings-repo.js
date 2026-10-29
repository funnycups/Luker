import { NotFoundError } from '../errors.js';
import { assertWritable } from '../read-only-mode.js';
import { decodeJsonPointer } from '../json-pointer.js';
import { applyJsonPatch } from './json-patch.js';

export class SettingsRepo {
    constructor({ engine }) { this._engine = engine; }
    _key(handle) { return { kind: 'settings', handle }; }

    async get(handle) {
        return this._engine.withTransaction(handle, (tx) => tx.getResource(this._key(handle)));
    }

    /**
     * Reads one JSON Pointer value without materializing the settings document.
     * @param {string} handle
     * @param {string} pointer RFC 6901 JSON Pointer
     * @returns {Promise<{exists: boolean, value?: unknown, type?: string}>}
     */
    async getField(handle, pointer) {
        const segments = decodeJsonPointer(pointer);
        return this._engine.withTransaction(handle, (tx) => tx.getResourceField(this._key(handle), segments));
    }

    async getFieldType(handle, pointer) {
        const segments = decodeJsonPointer(pointer);
        return this._engine.withTransaction(handle, (tx) => tx.getResourceFieldType(this._key(handle), segments));
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
