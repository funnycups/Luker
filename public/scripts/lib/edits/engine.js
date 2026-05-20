/**
 * Edits engine — pure functional core.
 *
 * Designed for dependency injection so the same module is testable in
 * Node (with lodash from npm) and usable in the browser (with lodash
 * from public/lib.js's bundle).
 *
 * @param {object} deps
 * @param {Function} deps.get        lodash.get(obj, path) → value
 * @param {Function} deps.set        lodash.set(obj, path, value) → obj (mutates)
 * @param {Function} deps.unset      lodash.unset(obj, path) → boolean (mutates)
 * @param {Function} deps.isEqual    lodash.isEqual(a, b) → boolean (deep)
 * @param {Function} deps.cloneDeep  lodash.cloneDeep(obj) → obj
 */
import { createRegistry } from './registry.js';

export function createEngine(deps) {
    if (!deps || typeof deps !== 'object') {
        throw new Error('createEngine: deps required');
    }
    for (const fn of ['get', 'set', 'unset', 'isEqual', 'cloneDeep']) {
        if (typeof deps[fn] !== 'function') {
            throw new Error(`createEngine: deps.${fn} must be a function`);
        }
    }

    const registry = createRegistry();

    function applyEdits(edits, live) {
        if (!Array.isArray(edits)) {
            throw new Error('applyEdits: edits must be an array');
        }

        let workingLive = deps.cloneDeep(live);
        const clean = [];
        const conflicts = [];
        const alreadyDone = [];

        for (const edit of edits) {
            const opName = edit && edit.op;
            const handler = registry.getRegisteredOp(opName);
            if (!handler) {
                throw new Error(`applyEdits: unknown op: ${opName}`);
            }

            const conflict = handler.detectConflict(deps, edit, workingLive);
            if (conflict) {
                if (conflict.reason === 'already_done') {
                    alreadyDone.push(edit);
                    continue;
                }
                conflicts.push({ edit, ...conflict });
                continue;
            }

            workingLive = handler.apply(deps, edit, workingLive);
            clean.push(edit);
        }

        return { newLive: workingLive, clean, conflicts, alreadyDone };
    }

    function inverseEdit(edit) {
        const handler = registry.getRegisteredOp(edit && edit.op);
        if (!handler) {
            throw new Error(`inverseEdit: unknown op: ${edit && edit.op}`);
        }
        return handler.inverse(edit);
    }

    return {
        applyEdits,
        inverseEdit,
        registerOp:        registry.registerOp,
        getRegisteredOp:   registry.getRegisteredOp,
        listRegisteredOps: registry.listRegisteredOps,
    };
}
