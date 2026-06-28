import { applyPatch, compare } from '../../util/fast-json-patch.js';
import { STATE_ERROR_REASONS } from '../../state-errors.js';

export class PatchConflictError extends Error {
    constructor({ targetType, targetName = null, opIndex, jsonPath, reason: legacyReason, reasonCode = STATE_ERROR_REASONS.CONFLICT, hint = null }) {
        const computedHint = hint != null ? String(hint) : String(legacyReason || 'patch conflict');
        super(`patch conflict at ${jsonPath || '(root)'}: ${computedHint}`);
        this.name = 'PatchConflictError';
        this.targetType = targetType;
        this.targetName = targetName;
        this.opIndex = opIndex;
        this.jsonPath = jsonPath;
        this.reason = reasonCode;
        this.hint = String(computedHint).slice(0, 120);
        this.legacyReason = legacyReason;
    }
}

// RFC 6901 path-exists check — codec-side because the vendored lib's remove is too permissive
function jsonPointerExists(doc, pointer) {
    if (pointer === '' || pointer == null) return true;
    if (typeof pointer !== 'string' || pointer.charCodeAt(0) !== 47) return false;
    const parts = pointer.slice(1).split('/').map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
    let node = doc;
    for (const seg of parts) {
        if (node === null || node === undefined) return false;
        if (Array.isArray(node)) {
            if (!/^(0|[1-9][0-9]*)$/.test(seg)) return false;
            const idx = Number(seg);
            if (idx >= node.length) return false;
            node = node[idx];
        } else if (typeof node === 'object') {
            if (!Object.prototype.hasOwnProperty.call(node, seg)) return false;
            node = node[seg];
        } else {
            return false;
        }
    }
    return true;
}

export function encodeInverse(before, after) {
    return compare(after, before);
}
// op-by-op so PatchConflictError carries the precise opIndex; bulk applyPatch would lose it
export function decodeBackward(currentState, inversePatch, ctx = {}) {
    if (!Array.isArray(inversePatch)) {
        throw new PatchConflictError({
            targetType: ctx.targetType || 'unknown',
            targetName: ctx.targetName || null,
            opIndex: -1,
            jsonPath: '',
            reason: 'inverse patch must be an array',
        });
    }
    for (let i = 0; i < inversePatch.length; i++) {
        const op = inversePatch[i];
        if (op && (op.op === 'remove' || op.op === 'replace') && !jsonPointerExists(currentState, op.path)) {
            throw new PatchConflictError({
                targetType: ctx.targetType || 'unknown',
                targetName: ctx.targetName || null,
                opIndex: i,
                jsonPath: String(op.path),
                reason: 'path missing: ' + String(op.path),
            });
        }
        try {
            const result = applyPatch(currentState, [op], true, false);
            currentState = result.newDocument;
        } catch (err) {
            throw new PatchConflictError({
                targetType: ctx.targetType || 'unknown',
                targetName: ctx.targetName || null,
                opIndex: i,
                jsonPath: String(op?.path || ''),
                reason: String(err?.message || err || 'patch op failed'),
            });
        }
    }
    return currentState;
}
export function deriveForward(before, after) {
    return compare(before, after);
}
// caller passes [oldest..newest]; we walk newest→oldest to reconstruct backwards
export function replayBackward(currentState, inversePatches) {
    if (!Array.isArray(inversePatches) || inversePatches.length === 0) {
        return { state: currentState, appliedCount: 0 };
    }
    let state = currentState;
    let appliedCount = 0;
    for (let i = inversePatches.length - 1; i >= 0; i--) {
        try {
            state = decodeBackward(state, inversePatches[i]);
            appliedCount += 1;
        } catch {
            return { state, appliedCount };
        }
    }
    return { state, appliedCount };
}
// alias: same wrapping as decodeBackward — used in bus.approve to apply forward ops
export const applyOps = decodeBackward;
