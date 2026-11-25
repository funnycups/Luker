/** A missing transaction acknowledgement does not establish rollback. */
export class TransactionOutcomeUnknownError extends Error {
    constructor(operation, cause, rollbackError) {
        super(`Cannot confirm storage ${operation} outcome: ${cause.message}. Reload persisted state before retrying.`, { cause });
        this.name = 'TransactionOutcomeUnknownError';
        this.code = 'transaction_outcome_unknown';
        this.operation = operation;
        if (rollbackError) this.rollbackError = rollbackError;
    }
}

// These server replies explicitly report transaction rollback, including at COMMIT.
const ROLLED_BACK_CODES = new Set(['40001', '40P01', 'ER_LOCK_DEADLOCK']);

export async function completeTransaction(work, commit, rollback) {
    let committing = false;
    try {
        const result = await work();
        committing = true;
        await commit();
        return result;
    } catch (error) {
        if (committing && !ROLLED_BACK_CODES.has(error.code)) throw new TransactionOutcomeUnknownError('COMMIT', error);
        try {
            await rollback();
        } catch (rollbackError) {
            throw new TransactionOutcomeUnknownError('ROLLBACK', error, rollbackError);
        }
        throw error;
    }
}
