import { AsyncLocalStorage } from 'node:async_hooks';
import { ConflictError } from './errors.js';
import { TransactionOutcomeUnknownError } from './transaction-outcome.js';

// Character files and auxiliary settings share this in-process boundary with
// conditional deletion, including asynchronous query execution and commit.
const engines = new WeakMap();
const context = new AsyncLocalStorage();
const WORLD_LOCATOR_RESOLVER = Symbol('worldLocatorResolver');

/**
 * Wrap a captured world-info catalog in a semantic-name callback while
 * preserving exact storage locator identity for internal adoption checks.
 */
export function createWorldIdentityResolver(catalog) {
    const resolveName = async name => (await catalog.resolve(name))?.name ?? null;
    Object.defineProperty(resolveName, WORLD_LOCATOR_RESOLVER, {
        value: async name => (await catalog.resolve(name))?.locator ?? null,
    });
    return resolveName;
}

/** Resolve the exact storage locator when carried by a captured catalog callback. */
export async function resolveWorldIdentityKey(resolveName, name) {
    const resolveLocator = resolveName?.[WORLD_LOCATOR_RESOLVER];
    return resolveLocator ? await resolveLocator(name) : await resolveName(name);
}

function userState(engine, handle) {
    let users = engines.get(engine);
    if (!users) { users = new Map(); engines.set(engine, users); }
    let state = users.get(handle);
    if (!state) {
        state = { tail: Promise.resolve(), pending: 0, deletions: new Set(), operations: new Set() };
        users.set(handle, state);
    }
    return { users, state };
}

function releaseIdle(users, handle, state) {
    if (state.pending === 0 && state.deletions.size === 0 && state.operations.size === 0) users.delete(handle);
}

function enqueue(users, handle, state, task) {
    state.pending++;
    // The caller keeps the original rejection. A failed predecessor only
    // releases ordering; it does not turn this operation into a success.
    const next = state.tail.then(task, task);
    state.tail = next;
    const settled = () => { state.pending--; releaseIdle(users, handle, state); };
    next.then(settled, settled);
    return next;
}

/** Admission lasts through source preparation, including work after a client disconnect. */
export async function withWorldReferenceOperation(engine, handle, prepare) {
    const current = context.getStore();
    if (current?.operation.engine === engine && current.operation.handle === handle) return prepare();
    const { users, state } = userState(engine, handle);
    const operation = { engine, handle, users, state, deletions: new Set(state.deletions) };
    state.operations.add(operation);
    try {
        return await context.run({ operation }, prepare);
    } finally {
        state.operations.delete(operation);
        releaseIdle(users, handle, state);
    }
}

export function withWorldReferenceWrite(engine, handle, write) {
    return withWorldReferenceOperation(engine, handle, () => {
        const current = context.getStore();
        if (current.mutating) return write(current.assertReferences);
        const { operation } = current;
        const assertReferences = async names => {
            for (const deletion of operation.deletions) {
                if (deletion.target === null || (deletion.outcome !== 'deleted' && deletion.outcome !== 'unknown')) continue;
                for (const name of names.filter(name => typeof name === 'string' && name.trim())) {
                    if ((await deletion.catalog.resolve(name))?.locator === deletion.target.locator) {
                        throw new ConflictError(deletion.outcome === 'deleted' ? 'world_deleted' : 'world_deletion_unknown', { name: deletion.name });
                    }
                }
            }
        };
        return enqueue(operation.users, handle, operation.state, () => context.run({ operation, mutating: true, assertReferences }, () => write(assertReferences)));
    });
}

export function withWorldDeletion(engine, handle, name, remove, beforeDelete) {
    const { users, state } = userState(engine, handle);
    const deletion = { name, outcome: 'preparing' };
    state.deletions.add(deletion);
    for (const operation of state.operations) operation.deletions.add(deletion);
    return enqueue(users, handle, state, async () => {
        try {
            deletion.catalog = await engine.withTransaction(handle, tx => tx.captureWorldInfoIdentity(handle));
            deletion.target = await deletion.catalog.resolve(name);
            deletion.name = deletion.target?.name ?? null;
            await beforeDelete?.(createWorldIdentityResolver(deletion.catalog));
            deletion.outcome = 'pending';
            const deleted = await remove(deletion.target);
            deletion.outcome = deleted ? 'deleted' : 'refused';
            return deleted;
        } catch (error) {
            deletion.outcome = deletion.outcome === 'pending' && error instanceof TransactionOutcomeUnknownError ? 'unknown' : 'refused';
            // Inspect the captured locator without changing the original error's
            // enumerable contract or driver cause. Name resolution could retarget.
            if (deletion.target !== undefined) Object.defineProperty(error, 'worldDeletionExists', { value: async () => {
                if (deletion.target === null) return false;
                const catalog = await engine.withTransaction(handle, tx => tx.captureWorldInfoIdentity(handle));
                return catalog.has(deletion.target.locator);
            } });
            throw error;
        }
    }).finally(() => {
        state.deletions.delete(deletion);
        releaseIdle(users, handle, state);
    });
}

/** Match the current and supported older settings document representations. */
export function getAuxiliaryWorldReferences(settings) {
    const worldInfo = settings?.world_info_settings?.world_info ?? settings?.world_info;
    const entries = Array.isArray(worldInfo?.charLore) ? worldInfo.charLore : [];
    return entries.flatMap(entry => Array.isArray(entry?.extraBooks) ? entry.extraBooks : []);
}
