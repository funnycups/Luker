import { applyCommittedSnapshotOperations, compare as compareJsonPatch } from '../util/fast-json-patch.js';

export { applyCommittedSnapshotOperations };

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null || Object.prototype.toString.call(value) === '[object Object]';
}

function cloneAsJsonWire(value) {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
}

function decodeJsonPointerSegment(segment) {
    return String(segment || '').replace(/~1/g, '/').replace(/~0/g, '~');
}

function getJsonPointerValue(root, path) {
    if (path === '') {
        return { found: true, value: root };
    }
    if (typeof path !== 'string' || !path.startsWith('/')) {
        return { found: false, value: undefined };
    }

    const segments = path.slice(1).split('/').map(decodeJsonPointerSegment);
    let cursor = root;

    for (const segment of segments) {
        if (Array.isArray(cursor)) {
            if (segment === '-') {
                return { found: false, value: undefined };
            }
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
                return { found: false, value: undefined };
            }
            cursor = cursor[index];
            continue;
        }

        if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
            return { found: false, value: undefined };
        }
        cursor = cursor[segment];
    }

    return { found: true, value: cursor };
}

function attachObjectPatchTests(previousState, operations) {
    const sourceOperations = Array.isArray(operations)
        ? operations.filter(op => op && typeof op === 'object')
        : [];
    if (sourceOperations.length === 0) {
        return sourceOperations;
    }

    let lastTestedPath = null;
    const guardedOperations = [];

    for (const operation of sourceOperations) {
        const opName = String(operation.op || '').trim().toLowerCase();
        const path = typeof operation.path === 'string' ? operation.path : null;

        if (opName === 'test') {
            guardedOperations.push(operation);
            if (typeof path === 'string') {
                lastTestedPath = path;
            }
            continue;
        }

        const shouldAddTest = (opName === 'replace' || opName === 'remove')
            && typeof path === 'string'
            && path !== lastTestedPath;

        if (shouldAddTest) {
            const resolved = getJsonPointerValue(previousState, path);
            if (resolved.found) {
                guardedOperations.push({
                    op: 'test',
                    path,
                    value: cloneAsJsonWire(resolved.value),
                });
                lastTestedPath = path;
            }
        }

        guardedOperations.push(operation);

        if (opName === 'add' || opName === 'remove') {
            lastTestedPath = null;
        }
    }

    return guardedOperations;
}

function isDiffableContainer(value) {
    return isPlainObject(value) || Array.isArray(value);
}

function buildObjectPatchOperations(previousState, nextState, options = {}) {
    const maxOperations = Number.isInteger(options?.maxOperations) && options.maxOperations > 0
        ? options.maxOperations
        : 2000;
    const attachTests = options?.attachTests !== false;
    const alreadyNormalized = options?.alreadyNormalized === true;

    if (!isDiffableContainer(nextState)) {
        return [];
    }

    const previous = isDiffableContainer(previousState)
        ? previousState
        : (Array.isArray(nextState) ? [] : {});
    const operations = compareJsonPatch(previous, nextState, { alreadyNormalized });
    if (operations.length > maxOperations) {
        return [{ op: 'replace', path: '', value: alreadyNormalized ? nextState : cloneAsJsonWire(nextState) }];
    }

    return attachTests ? attachObjectPatchTests(previous, operations) : operations;
}

export function createObjectPatchWorkerState() {
    return {
        snapshots: new Map(),
        staged: new Map(),
    };
}

function clearStagedSnapshotsForKey(workerState, snapshotKey) {
    for (const [stageId, entry] of workerState.staged.entries()) {
        if (entry.snapshotKey === snapshotKey) {
            workerState.staged.delete(stageId);
        }
    }
}

export function handleObjectPatchWorkerMessage(workerState, data) {
    const action = typeof data?.action === 'string' ? data.action : '';

    if (action === 'setSnapshot') {
        const snapshotKey = String(data?.snapshotKey || '');
        if (!snapshotKey) {
            return null;
        }
        clearStagedSnapshotsForKey(workerState, snapshotKey);
        if (typeof data?.serialized === 'string') {
            const parsed = JSON.parse(data.serialized);
            if (isDiffableContainer(parsed)) {
                workerState.snapshots.set(snapshotKey, parsed);
            } else {
                workerState.snapshots.delete(snapshotKey);
            }
        } else if (isDiffableContainer(data?.state)) {
            workerState.snapshots.set(snapshotKey, data.state);
        } else {
            workerState.snapshots.delete(snapshotKey);
        }
        return null;
    }

    if (action === 'commitSnapshot') {
        const stageId = Number(data?.stageId);
        const staged = workerState.staged.get(stageId);
        if (staged) {
            workerState.staged.delete(stageId);
            workerState.snapshots.set(staged.snapshotKey, staged.state);
        }
        return null;
    }

    if (action === 'discardSnapshot') {
        const stageId = Number(data?.stageId);
        workerState.staged.delete(stageId);
        return null;
    }

    const id = Number(data?.id);
    if (!Number.isInteger(id)) {
        return null;
    }

    const maxOperations = Number(data?.maxOperations);
    const normalizedMaxOperations = Number.isInteger(maxOperations) && maxOperations > 0 ? maxOperations : 2000;
    const attachTests = data?.attachTests !== false;

    if (action === 'diffSerializedSnapshot') {
        try {
            const snapshotKey = String(data?.snapshotKey || '');
            if (!snapshotKey) {
                return { id, ok: false, error: 'Missing snapshotKey' };
            }
            if (!workerState.snapshots.has(snapshotKey) && typeof data?.previousSerialized === 'string') {
                const seeded = JSON.parse(data.previousSerialized);
                if (isDiffableContainer(seeded)) {
                    workerState.snapshots.set(snapshotKey, seeded);
                }
            }
            if (!workerState.snapshots.has(snapshotKey)) {
                return { id, ok: false, code: 'missing_snapshot', error: `Missing worker snapshot for ${snapshotKey}` };
            }
            const nextState = JSON.parse(String(data?.nextSerialized ?? 'null'));
            const operations = buildObjectPatchOperations(workerState.snapshots.get(snapshotKey), nextState, {
                maxOperations: normalizedMaxOperations,
                attachTests,
                alreadyNormalized: true,
            });
            workerState.staged.set(id, { snapshotKey, state: nextState });
            return { id, ok: true, operations };
        } catch (error) {
            return { id, ok: false, error: String(error?.message || error) };
        }
    }

    try {
        const operations = buildObjectPatchOperations(data?.previousState, data?.nextState, {
            maxOperations: normalizedMaxOperations,
            attachTests,
        });
        return { id, ok: true, operations };
    } catch (error) {
        return { id, ok: false, error: String(error?.message || error) };
    }
}

const defaultWorkerState = createObjectPatchWorkerState();

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
    self.addEventListener('message', (event) => {
        const reply = handleObjectPatchWorkerMessage(defaultWorkerState, event?.data);
        if (reply) {
            self.postMessage(reply);
        }
    });
}
