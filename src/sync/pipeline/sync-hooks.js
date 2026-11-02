/**
 * @typedef {{ handle: string, displayName: string, userRoot: string, directories: Record<string, string>, engine?: object, selfCallback?: () => ({ scheme: string, port: number, baseUrls: string[] }) | null, getCurrentProfile: () => Promise<{enabled?: boolean, admin?: boolean}|null> }} SyncOwner
 * @typedef {{ beforeSnapshot?: (owner: SyncOwner) => unknown, afterReconcile?: (owner: SyncOwner, report: object) => unknown }} SyncHooks
 */

/** @type {Set<SyncHooks>} */
const HOOKS = new Set();

/**
 * Register hooks that run around every sync cycle. `afterReconcile` runs
 * under the shadow and writer locks, so it must not take either.
 *
 * @param {SyncHooks} hooks
 * @returns {() => void} unregisters the hooks
 */
export function registerSyncHooks(hooks) {
    const entry = { ...hooks };
    HOOKS.add(entry);
    return () => { HOOKS.delete(entry); };
}

async function runEach(name, args) {
    for (const hooks of [...HOOKS]) {
        if (typeof hooks[name] !== 'function') continue;
        try {
            await hooks[name](...args);
        } catch (error) {
            console.error('[sync] sync hook failed', error);
        }
    }
}

/**
 * @param {SyncOwner} owner
 */
export function runBeforeSnapshot(owner) {
    return runEach('beforeSnapshot', [owner]);
}

/**
 * @param {SyncOwner} owner
 * @param {object} report
 */
export function runAfterReconcile(owner, report) {
    return runEach('afterReconcile', [owner, report]);
}
