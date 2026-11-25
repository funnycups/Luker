/**
 * Pure Layer 1 Activity Guard lease registry.
 *
 * Tracks active background/foreground leases via unique Symbol tokens so
 * unload protection, mobile keep-alive, and chat-switch confirmation share
 * one source of truth without DOM or application-module dependencies.
 */

const VALID_SCOPES = new Set(['global', 'chat']);

/**
 * Create an isolated Activity Guard lease registry instance.
 */
export function createActivityGuardRegistry() {
    /** @type {Map<symbol, object>} */
    const entries = new Map();
    /** @type {Set<Function>} */
    const subscribers = new Set();

    function notifySubscribers() {
        const snapshot = [...subscribers];
        for (const listener of snapshot) {
            try {
                listener();
            } catch (err) {
                console.error('[activity-guard] subscriber threw:', err);
            }
        }
    }

    /**
     * Acquire a guard lease and return an idempotent release function.
     * @param {object} options
     * @returns {() => void}
     */
    function acquireActivityLease(options) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('acquireActivityLease: options must be an object');
        }

        const source = typeof options.source === 'string' ? options.source.trim() : '';
        if (!source) {
            throw new TypeError('acquireActivityLease: source must be a non-empty string');
        }

        const scope = options.scope === undefined ? 'global' : options.scope;
        if (!VALID_SCOPES.has(scope)) {
            throw new TypeError('acquireActivityLease: scope must be "global" or "chat"');
        }

        const onCancel = options.onCancel === undefined ? null : options.onCancel;
        if (onCancel !== null && typeof onCancel !== 'function') {
            throw new TypeError('acquireActivityLease: onCancel must be a function or null');
        }

        const entry = {
            source,
            label: options.label == null ? '' : String(options.label),
            scope,
            guardUnload: options.guardUnload === undefined ? true : Boolean(options.guardUnload),
            guardChatSwitch: options.guardChatSwitch === undefined ? (scope === 'chat') : Boolean(options.guardChatSwitch),
            keepAlive: options.keepAlive === undefined ? true : Boolean(options.keepAlive),
            ambient: options.ambient === undefined ? false : Boolean(options.ambient),
            startedAt: Date.now(),
            onCancel,
        };

        const token = Symbol(source);
        entries.set(token, entry);
        notifySubscribers();

        let released = false;
        return function release() {
            if (released) {
                return;
            }
            released = true;
            if (entries.delete(token)) {
                notifySubscribers();
            }
        };
    }

    /**
     * Execute a callback while holding an activity lease, releasing in finally.
     * @template T
     * @param {object} options
     * @param {() => T | Promise<T>} fn
     * @returns {Promise<T>}
     */
    async function withActivityLease(options, fn) {
        if (typeof fn !== 'function') {
            throw new TypeError('withActivityLease: fn must be a function');
        }
        const release = acquireActivityLease(options);
        try {
            return await fn();
        } finally {
            release();
        }
    }

    /**
     * @returns {boolean}
     */
    function hasUnloadGuard() {
        for (const entry of entries.values()) {
            if (entry.guardUnload) {
                return true;
            }
        }
        return false;
    }

    /**
     * @returns {boolean}
     */
    function hasChatSwitchGuard() {
        for (const entry of entries.values()) {
            if (entry.guardChatSwitch) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.excludeAmbient=false]
     * @param {Iterable<string>} [options.excludeSources=[]]
     * @returns {boolean}
     */
    function hasKeepAliveHold(options = {}) {
        const { excludeAmbient = false, excludeSources = [] } = (options && typeof options === 'object') ? options : {};
        const rawExcluded = excludeSources && typeof excludeSources !== 'string' && typeof excludeSources[Symbol.iterator] === 'function'
            ? excludeSources
            : [];
        const excludedSet = new Set();
        for (const source of rawExcluded) {
            if (typeof source === 'string') {
                const normalized = source.trim();
                if (normalized) {
                    excludedSet.add(normalized);
                }
            }
        }

        for (const entry of entries.values()) {
            if (!entry.keepAlive) {
                continue;
            }
            if (excludeAmbient && entry.ambient) {
                continue;
            }
            if (excludedSet.has(entry.source)) {
                continue;
            }
            return true;
        }
        return false;
    }

    /**
     * @param {string} source
     * @returns {boolean}
     */
    function hasActiveSource(source) {
        if (typeof source !== 'string') {
            return false;
        }
        const normalized = source.trim();
        if (!normalized) {
            return false;
        }
        for (const entry of entries.values()) {
            if (entry.source === normalized) {
                return true;
            }
        }
        return false;
    }

    /**
     * Return shallow-frozen snapshots of active leases without internal hooks or tokens.
     * @returns {Array<object>}
     */
    function getActiveActivities() {
        const snapshots = [];
        for (const entry of entries.values()) {
            snapshots.push(Object.freeze({
                source: entry.source,
                label: entry.label,
                scope: entry.scope,
                guardUnload: entry.guardUnload,
                guardChatSwitch: entry.guardChatSwitch,
                keepAlive: entry.keepAlive,
                ambient: entry.ambient,
                startedAt: entry.startedAt,
            }));
        }
        return snapshots;
    }

    /**
     * Collect deduplicated non-empty labels for active chat-switch-guarded leases.
     * Suppresses ambient labels when any non-ambient chat-switch-guarded lease is active.
     * @returns {string[]}
     */
    function getChatSwitchBlockingLabels() {
        const blockingEntries = [];
        let hasNonAmbient = false;
        for (const entry of entries.values()) {
            if (!entry.guardChatSwitch) {
                continue;
            }
            if (!entry.ambient && entry.label.trim().length > 0) {
                hasNonAmbient = true;
            }
            blockingEntries.push(entry);
        }

        const seen = new Set();
        const labels = [];
        for (const entry of blockingEntries) {
            if (hasNonAmbient && entry.ambient) {
                continue;
            }
            const label = entry.label.trim();
            if (!label || seen.has(label)) {
                continue;
            }
            seen.add(label);
            labels.push(label);
        }
        return labels;
    }

    /**
     * Invoke onCancel hooks for all active chat-switch-guarded leases without deleting entries.
     */
    function cancelChatSwitchActivities() {
        const snapshot = [];
        for (const entry of entries.values()) {
            if (entry.guardChatSwitch) {
                snapshot.push(entry);
            }
        }

        for (const entry of snapshot) {
            if (typeof entry.onCancel !== 'function') {
                continue;
            }
            try {
                entry.onCancel();
            } catch (err) {
                console.error('[activity-guard] onCancel hook threw:', err);
            }
        }
    }

    /**
     * Subscribe to acquire/release state changes and return an idempotent unsubscribe callback.
     * @param {() => void} listener
     * @returns {() => void}
     */
    function subscribeActivityGuard(listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('subscribeActivityGuard: listener must be a function');
        }
        subscribers.add(listener);

        let unsubscribed = false;
        return function unsubscribe() {
            if (unsubscribed) {
                return;
            }
            unsubscribed = true;
            subscribers.delete(listener);
        };
    }

    return {
        acquireActivityLease,
        withActivityLease,
        hasUnloadGuard,
        hasChatSwitchGuard,
        hasKeepAliveHold,
        hasActiveSource,
        getActiveActivities,
        getChatSwitchBlockingLabels,
        cancelChatSwitchActivities,
        subscribeActivityGuard,
    };
}

const defaultRegistry = createActivityGuardRegistry();

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Resolve normalized activity-lease options for core LLM request entrypoints.
 * Returns `null` when `activity === false` so callers can opt out cleanly.
 *
 * @param {boolean|object} [activity=true]
 * @param {string} defaultSource
 * @param {{ defaultLabel?: string }} [options]
 * @returns {object|null}
 */
export function resolveRequestActivityLeaseOptions(activity, defaultSource, options = {}) {
    if (activity === false) {
        return null;
    }
    const defaultLabel = options?.defaultLabel;
    const resolvedDefaultLabel = (typeof defaultLabel === 'string' && defaultLabel.trim())
        ? defaultLabel
        : (globalThis.Luker?.getContext?.()?.translate?.('Background AI request') || 'Background AI request');
    const overrides = isPlainObject(activity)
        ? Object.fromEntries(Object.entries(activity).filter(([, value]) => value !== undefined))
        : {};
    return {
        source: defaultSource,
        label: resolvedDefaultLabel,
        scope: 'global',
        ambient: true,
        guardUnload: true,
        keepAlive: true,
        ...overrides,
    };
}

export const acquireActivityLease = defaultRegistry.acquireActivityLease;
export const withActivityLease = defaultRegistry.withActivityLease;
export const hasUnloadGuard = defaultRegistry.hasUnloadGuard;
export const hasChatSwitchGuard = defaultRegistry.hasChatSwitchGuard;
export const hasKeepAliveHold = defaultRegistry.hasKeepAliveHold;
export const hasActiveSource = defaultRegistry.hasActiveSource;
export const getActiveActivities = defaultRegistry.getActiveActivities;
export const getChatSwitchBlockingLabels = defaultRegistry.getChatSwitchBlockingLabels;
export const cancelChatSwitchActivities = defaultRegistry.cancelChatSwitchActivities;
export const subscribeActivityGuard = defaultRegistry.subscribeActivityGuard;

/**
 * Collect deduplicated blocking reason labels for an in-app chat switch.
 *
 * @param {object} [options]
 * @param {string[]} [options.activityLabels=[]] Labels from getChatSwitchBlockingLabels()
 * @param {boolean} [options.hasChatSwitchActivity=false] Whether any guardChatSwitch lease is active
 * @param {string} [options.activityFallbackLabel='Background task'] Fallback label when guardChatSwitch lease has no label
 * @param {boolean} [options.isGenerating=false] Whether core/group generation flags are active
 * @param {boolean} [options.hasGenerationLease=false] Whether core:generation or core:group-generation lease is active
 * @param {string} [options.generationFallbackLabel='Message generation'] Fallback label when generating without lease
 * @param {boolean} [options.hasUnsavedEdit=false] Whether an inline message editor is open
 * @param {string} [options.unsavedEditLabel='Unsaved message edit'] Label for unsaved message edits
 * @returns {string[]}
 */
export function buildChatSwitchBlockingReasons({
    activityLabels = [],
    hasChatSwitchActivity = false,
    activityFallbackLabel = 'Background task',
    isGenerating = false,
    hasGenerationLease = false,
    generationFallbackLabel = 'Message generation',
    hasUnsavedEdit = false,
    unsavedEditLabel = 'Unsaved message edit',
} = {}) {
    const seen = new Set();
    const reasons = [];

    const addReason = (label) => {
        const normalized = typeof label === 'string' ? label.trim() : '';
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        reasons.push(normalized);
    };

    if (Array.isArray(activityLabels)) {
        for (const label of activityLabels) {
            addReason(label);
        }
    }
    if (hasChatSwitchActivity && reasons.length === 0) {
        addReason(activityFallbackLabel);
    }
    if (isGenerating && !hasGenerationLease) {
        addReason(generationFallbackLabel);
    }
    if (hasUnsavedEdit) {
        addReason(unsavedEditLabel);
    }

    return reasons;
}

/**
 * Create a re-entrancy-safe confirmation coordinator for in-app chat switches.
 *
 * @param {object} deps
 * @param {() => string[]} deps.getBlockingReasons
 * @param {() => boolean} [deps.isGenerating]
 * @param {(reasons: string[]) => Promise<boolean>|boolean} deps.confirmDialog
 * @param {() => void} deps.onEpochBump
 * @param {() => void} deps.onStopGeneration
 * @param {() => void} deps.onCancelActivities
 * @returns {(options?: { skipConfirmation?: boolean }) => Promise<boolean>}
 */
export function createChatSwitchConfirmRunner(deps) {
    if (!deps || typeof deps !== 'object') {
        throw new TypeError('createChatSwitchConfirmRunner: deps must be an object');
    }

    const {
        getBlockingReasons,
        isGenerating = () => false,
        confirmDialog,
        onEpochBump,
        onStopGeneration,
        onCancelActivities,
    } = deps;

    if (typeof getBlockingReasons !== 'function') {
        throw new TypeError('createChatSwitchConfirmRunner: getBlockingReasons must be a function');
    }
    if (typeof isGenerating !== 'function') {
        throw new TypeError('createChatSwitchConfirmRunner: isGenerating must be a function');
    }
    if (typeof confirmDialog !== 'function') {
        throw new TypeError('createChatSwitchConfirmRunner: confirmDialog must be a function');
    }
    if (typeof onEpochBump !== 'function') {
        throw new TypeError('createChatSwitchConfirmRunner: onEpochBump must be a function');
    }
    if (typeof onStopGeneration !== 'function') {
        throw new TypeError('createChatSwitchConfirmRunner: onStopGeneration must be a function');
    }
    if (typeof onCancelActivities !== 'function') {
        throw new TypeError('createChatSwitchConfirmRunner: onCancelActivities must be a function');
    }

    let inFlight = false;

    return async function runChatSwitchConfirm({ skipConfirmation = false } = {}) {
        if (inFlight) {
            return false;
        }

        const reasons = getBlockingReasons();
        if (!Array.isArray(reasons) || reasons.length === 0) {
            return true;
        }

        const runCleanup = () => {
            onEpochBump();
            if (isGenerating()) {
                onStopGeneration();
            }
            onCancelActivities();
        };

        if (skipConfirmation) {
            runCleanup();
            return true;
        }

        inFlight = true;
        try {
            const confirmed = await confirmDialog(reasons);
            if (!confirmed) {
                return false;
            }
            runCleanup();
            return true;
        } finally {
            inFlight = false;
        }
    };
}
