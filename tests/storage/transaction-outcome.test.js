import { TransactionOutcomeUnknownError, completeTransaction } from '../../src/storage/transaction-outcome.js';

describe('transaction outcome diagnostics', () => {
    test.each(['COMMIT', 'ROLLBACK'])('%s diagnostics preserve the original cause and operation', operation => {
        const cause = new Error('Connection ended before acknowledgement');
        const error = new TransactionOutcomeUnknownError(operation, cause);

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(TransactionOutcomeUnknownError);
        expect(error.name).toBe('TransactionOutcomeUnknownError');
        expect(error.code).toBe('transaction_outcome_unknown');
        expect(error.operation).toBe(operation);
        expect(error.message).toBe(`Cannot confirm storage ${operation} outcome: Connection ended before acknowledgement. Reload persisted state before retrying.`);
        expect(error.cause).toBe(cause);
        expect(Object.keys(error).sort()).toEqual(['code', 'name', 'operation']);
    });

    test('rollback diagnostics retain the separate rollback failure', () => {
        const cause = new Error('Work was refused');
        const rollbackError = new Error('Rollback acknowledgement was lost');
        const error = new TransactionOutcomeUnknownError('ROLLBACK', cause, rollbackError);

        expect(error.operation).toBe('ROLLBACK');
        expect(error.cause).toBe(cause);
        expect(error.rollbackError).toBe(rollbackError);
        expect(error.message).toBe('Cannot confirm storage ROLLBACK outcome: Work was refused. Reload persisted state before retrying.');
        expect(Object.keys(error).sort()).toEqual(['code', 'name', 'operation', 'rollbackError']);
    });
});

describe('transaction completion contract', () => {
    test('returns the original result only after commit acknowledgement', async () => {
        const calls = [];
        const result = { retained: ['result'] };
        let enterCommit;
        const enteredCommit = new Promise(resolve => { enterCommit = resolve; });
        let acknowledge;
        const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
        const transaction = completeTransaction(
            async () => { calls.push('work'); return result; },
            async () => { calls.push('commit'); enterCommit(); await acknowledgement; calls.push('acknowledged'); },
            async () => { calls.push('rollback'); },
        ).then(value => { calls.push('returned'); return value; });

        await enteredCommit;
        expect(calls).toEqual(['work', 'commit']);
        acknowledge();
        expect(await transaction).toBe(result);
        expect(calls).toEqual(['work', 'commit', 'acknowledged', 'returned']);
    });

    test('a work failure rolls back without replacing the original error', async () => {
        const calls = [];
        const cause = new Error('Work was refused');
        const transaction = completeTransaction(
            async () => { calls.push('work'); throw cause; },
            async () => { calls.push('commit'); },
            async () => { calls.push('rollback'); },
        );

        await expect(transaction).rejects.toBe(cause);
        expect(calls).toEqual(['work', 'rollback']);
    });

    test.each(['40001', '40P01', 'ER_LOCK_DEADLOCK'])('confirmed %s rollback preserves the retryable error', async code => {
        const calls = [];
        const cause = Object.assign(new Error('Transaction was rolled back'), { code });
        const transaction = completeTransaction(
            async () => { calls.push('work'); },
            async () => { calls.push('commit'); throw cause; },
            async () => { calls.push('rollback'); },
        );

        await expect(transaction).rejects.toBe(cause);
        expect(calls).toEqual(['work', 'commit', 'rollback']);
    });

    test('unknown commit outcome does not roll back or retry completed work', async () => {
        const calls = [];
        const cause = new Error('Commit acknowledgement was lost');
        const transaction = completeTransaction(
            async () => { calls.push('work'); },
            async () => { calls.push('commit'); throw cause; },
            async () => { calls.push('rollback'); },
        );

        await expect(transaction).rejects.toMatchObject({
            name: 'TransactionOutcomeUnknownError', code: 'transaction_outcome_unknown', operation: 'COMMIT', cause,
            message: 'Cannot confirm storage COMMIT outcome: Commit acknowledgement was lost. Reload persisted state before retrying.',
        });
        expect(calls).toEqual(['work', 'commit']);
    });

    test('a failed rollback retains both errors and never commits or retries work', async () => {
        const calls = [];
        const cause = new Error('Work was refused');
        const rollbackError = new Error('Rollback acknowledgement was lost');
        const transaction = completeTransaction(
            async () => { calls.push('work'); throw cause; },
            async () => { calls.push('commit'); },
            async () => { calls.push('rollback'); throw rollbackError; },
        );

        await expect(transaction).rejects.toMatchObject({
            name: 'TransactionOutcomeUnknownError', code: 'transaction_outcome_unknown', operation: 'ROLLBACK', cause, rollbackError,
            message: 'Cannot confirm storage ROLLBACK outcome: Work was refused. Reload persisted state before retrying.',
        });
        expect(calls).toEqual(['work', 'rollback']);
    });
});
