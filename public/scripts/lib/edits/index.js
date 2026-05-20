/**
 * Luker Edits — public entry point.
 *
 * Wires lodash methods from `public/lib.js` into the engine and registers
 * the built-in op handlers. Re-exports the engine API for direct ESM use
 * and also installs a binding onto `lukerContext.edits` at load time.
 * `getContext().edits` is wired statically by `st-context.js` (no runtime
 * patching), so the namespace import there sees these exports directly.
 *
 * Three-layer exposure (per `feedback_api_layered_exposure` convention):
 *   1. ESM import — `import { applyEdits, ... } from '/scripts/lib/edits/index.js'`
 *   2. lukerContext — `lukerContext.edits.applyEdits(...)`
 *   3. getContext()  — `getContext().edits.applyEdits(...)`
 *
 * Custom op registration via `registerOp(name, handler)` is per-process,
 * not per-CPA-session — plugins should register on their own boot.
 */
import { lodash } from '../../../lib.js';
import { createEngine } from './engine.js';
import { showConflictResolution } from './conflict-ui.js';
import { createSetOp }         from './ops/set.js';
import { createUnsetOp }       from './ops/unset.js';
import { createStrReplaceOp }  from './ops/str-replace.js';
import { createStrInsertOp }   from './ops/str-insert.js';
import { createStrDeleteOp }   from './ops/str-delete.js';
import { createListInsertOp }  from './ops/list-insert.js';
import { createListRemoveOp }  from './ops/list-remove.js';
import { createListMoveOp }    from './ops/list-move.js';

const deps = {
    get:       lodash.get,
    set:       lodash.set,
    unset:     lodash.unset,
    isEqual:   lodash.isEqual,
    cloneDeep: lodash.cloneDeep,
};

const engine = createEngine(deps);

// Register built-ins (idempotent guards in case index.js is imported twice).
const BUILT_INS = [
    ['set',          createSetOp()],
    ['unset',        createUnsetOp()],
    ['str_replace',  createStrReplaceOp()],
    ['str_insert',   createStrInsertOp()],
    ['str_delete',   createStrDeleteOp()],
    ['list_insert',  createListInsertOp()],
    ['list_remove',  createListRemoveOp()],
    ['list_move',    createListMoveOp()],
];

for (const [name, handler] of BUILT_INS) {
    if (!engine.getRegisteredOp(name)) {
        engine.registerOp(name, handler);
    }
}

export const BUILT_IN_OPS = Object.freeze(BUILT_INS.map(([name]) => name));

export const {
    applyEdits,
    inverseEdit,
    registerOp,
    getRegisteredOp,
    listRegisteredOps,
} = engine;

export { showConflictResolution };

// Three-layer exposure:
//   1. ESM import     — this file's named exports
//   2. lukerContext   — installed below at load time
//   3. getContext()   — wired via st-context.js's `edits: EDITS_API` property
//                       (no runtime patching needed)
if (typeof globalThis.lukerContext === 'object' && globalThis.lukerContext) {
    globalThis.lukerContext.edits = {
        applyEdits, inverseEdit,
        registerOp, getRegisteredOp, listRegisteredOps,
        showConflictResolution,
        BUILT_IN_OPS,
    };
}
