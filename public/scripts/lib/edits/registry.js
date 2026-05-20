/**
 * Op registry — standalone helper, used both by the engine and by
 * tests that want to inspect handler registration directly.
 *
 * An op handler is `{ apply, inverse, detectConflict, renderConflict? }`.
 * `apply` and `detectConflict` receive `(deps, edit, live)` where `deps`
 * holds lodash methods; `inverse` receives `(edit)` only (no env access
 * needed, returns a new Edit); `renderConflict` is optional and receives
 * `(entry)` returning an HTMLElement.
 */
export function createRegistry() {
    const ops = new Map();

    function registerOp(name, handler) {
        if (typeof name !== 'string' || !name.trim()) {
            throw new Error('registerOp: name must be a non-empty string');
        }
        if (!handler || typeof handler !== 'object') {
            throw new Error('registerOp: handler must be an object');
        }
        for (const required of ['apply', 'inverse', 'detectConflict']) {
            if (typeof handler[required] !== 'function') {
                throw new Error(`registerOp: missing required callback: ${required}`);
            }
        }
        if (ops.has(name)) {
            throw new Error(`registerOp: already registered: ${name}`);
        }
        ops.set(name, handler);
    }

    function getRegisteredOp(name) {
        return ops.get(name) || null;
    }

    function listRegisteredOps() {
        return [...ops.keys()].sort();
    }

    return { registerOp, getRegisteredOp, listRegisteredOps, _opsMap: ops };
}
