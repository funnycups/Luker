let current;

/** Set the scope available to allocating storage harnesses for the active case. */
export function setCurrentResourceScope(scope) {
    current = scope;
}

/** Clear the active case scope after its owner has disposed it. */
export function clearCurrentResourceScope(scope) {
    if (scope === undefined || current === scope) current = undefined;
}

/** The scope installed for the current storage case. */
export function currentScopeForResources() {
    if (!current) throw new Error('Storage resources require a managed resource scope; no case scope is active');
    return current;
}
