import _ from 'lodash';

/**
 * Strip the chat record fields whose values are engine-internal and not part
 * of the user payload, so two chat records from different engines compare
 * equal under deep-equality.
 *
 * Stripped fields:
 *   - `integrity` (rotated by ChatRepo.save in EACH engine)
 *   - `updatedAt` / `createdAt` (engine-specific clock resolution)
 *   - `key` (engine fills this from the lookup key)
 *   - `header.chat_metadata.integrity` (both engines write the rotated
 *     integrity into chat_metadata on save and read it back out on get — so
 *     post-rotation the value differs across engines)
 *
 * What remains — `header` (minus the embedded integrity) and `body` — is what
 * must round-trip identically.
 *
 * Shared between `round-trip.test.js` and `MigrationRunner._copyAll`'s inline verify.
 */
export function stripChatEngineMeta(record) {
    if (record == null) return record;
    const { integrity: _i, updatedAt: _u, createdAt: _c, key: _k, header, ...rest } = record;
    const headerOut = { ...(header || {}) };
    if (headerOut.chat_metadata) {
        const { integrity: _hi, ...cm } = headerOut.chat_metadata;
        headerOut.chat_metadata = cm;
    }
    return { ...rest, header: headerOut };
}

/**
 * Deep-equal check that ignores engine metadata for chat records and is exact
 * for everything else. The `kind` discriminator lets callers be explicit about
 * what shape they're comparing, which keeps the per-kind tolerance localized.
 */
export function recordsEqual(kind, a, b) {
    if (kind === 'chat') return _.isEqual(stripChatEngineMeta(a), stripChatEngineMeta(b));
    return _.isEqual(a, b);
}
