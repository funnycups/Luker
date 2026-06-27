/**
 * Typed Error subclasses raised by the cross-mode restore pipeline.
 * The route handler reads the class identity (instanceof checks) to map
 * each one to its HTTP status:
 *
 *   CrossModeScratchCredsRequiredError → 400 (operator forgot scratch URL)
 *   CrossModeScratchConnectionError    → 400 (scratch URL bad/unreachable)
 *   CrossModeConversionFailedError     → 500 (anything else inside crossModeRestore)
 *
 * The classes carry structured fields the UI needs to prompt for missing
 * data (`requiredCreds` for the creds-missing case) or to surface a
 * partial-rollback warning (`snapshotPath` for the conversion-failed
 * case). All three preserve the original error chain via `cause`.
 */

/**
 * Thrown when the uploaded backup ZIP declares a mysql/postgres source
 * engine but the request did not include the corresponding scratch DB
 * connection string. The UI translates this into a "please provide a
 * scratch <kind> connection URL" prompt, then re-submits.
 */
export class CrossModeScratchCredsRequiredError extends Error {
    /**
     * @param {'mysql'|'postgres'} kind  The engine kind that needs creds.
     */
    constructor(kind) {
        super(`Backup is from ${kind} engine; provide a scratch ${kind} connection string to convert.`);
        this.name = 'CrossModeScratchCredsRequiredError';
        this.kind = kind;
        this.requiredCreds = kind;
    }
}

/**
 * Thrown when the supplied scratch DB connection string cannot be reached
 * (auth failure, host unreachable, wrong port, schema bootstrap error).
 * The original driver error is preserved on `cause` so operators see the
 * underlying mysql2 / pg message verbatim — usually the actionable signal.
 */
export class CrossModeScratchConnectionError extends Error {
    /**
     * @param {'mysql'|'postgres'} kind
     * @param {unknown} cause           Original driver error.
     */
    constructor(kind, cause) {
        const inner = cause instanceof Error ? cause.message : String(cause);
        super(`Cannot connect to scratch ${kind} DB: ${inner}`);
        this.name = 'CrossModeScratchConnectionError';
        this.kind = kind;
        this.cause = cause;
    }
}

/**
 * Thrown when anything inside crossModeRestore fails after the creds
 * validation gate — snapshot, transient materialization, MigrationRunner
 * copy/verify, or the fs-tree extract.
 *
 * `rollback` carries the rollback outcome the orchestrator was able to
 * achieve before bubbling up:
 *  - `'ok'`            : snapshot was restored cleanly; live data is at
 *                        pre-restore state.
 *  - `'partial'`       : restoreFromSnapshot itself failed; live data may
 *                        be in a mid-restore state; `snapshotPath` tells
 *                        the operator where to manually recover from.
 *  - `'merge-no-snapshot'`: merge mode never took a snapshot, so nothing
 *                        to roll back — live data is whatever state the
 *                        partial restore left it in.
 *
 * `snapshotPath` is the absolute path to the preserved snapshot dir under
 * `_storage-migrations/` so operators can manually restore via
 * `restoreFromSnapshot` if needed.
 */
export class CrossModeConversionFailedError extends Error {
    /**
     * @param {unknown} cause
     * @param {{ rollback: 'ok'|'partial'|'merge-no-snapshot', rollbackError?: unknown, snapshotPath?: string|null }} info
     */
    constructor(cause, info) {
        const inner = cause instanceof Error ? cause.message : String(cause);
        let suffix;
        if (info.rollback === 'ok') {
            suffix = 'Live data restored from snapshot.';
        } else if (info.rollback === 'partial') {
            const rbInner = info.rollbackError instanceof Error
                ? info.rollbackError.message
                : String(info.rollbackError);
            suffix = `PARTIAL ROLLBACK: manual recovery required from ${info.snapshotPath || '(snapshot path unknown)'} (rollback error: ${rbInner})`;
        } else if (info.rollback === 'merge-no-snapshot') {
            suffix = 'Merge mode took no snapshot; live data may be in a partial state.';
        } else {
            suffix = `Unknown rollback state: ${info.rollback}`;
        }
        super(`Cross-mode conversion failed: ${inner}. ${suffix}`);
        this.name = 'CrossModeConversionFailedError';
        this.cause = cause;
        this.rollback = info.rollback;
        this.rollbackError = info.rollbackError ?? null;
        this.snapshotPath = info.snapshotPath ?? null;
    }
}
