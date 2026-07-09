import {
    createGenerationJob,
    subscribeToJob,
    appendGenerationEvent,
    getTaskByRequestId,
} from '../src/endpoints/backends/luker-generation.js';

describe('createGenerationJob owner field', () => {
    test('records request.user.profile.handle as owner', () => {
        const request = {
            user: { profile: { handle: 'alice' }, directories: {} },
            body: {},
        };
        const job = createGenerationJob(request, {
            job_id: 'test-job-owner-1',
            persist_target: null,
        });
        expect(job).not.toBeNull();
        expect(job.owner).toBe('alice');
        expect(job.handle).toBe('alice');  // 保留旧字段兼容
    });
});

test('subscribeToJob replays from fromSeq inclusive then subscribes', () => {
    const request = { user: { profile: { handle: 'bob' }, directories: {} }, body: {} };
    const job = createGenerationJob(request, { job_id: 'replay-test-1', persist_target: null });

    // Pre-populate 3 events
    appendGenerationEvent(job, { text: 'a' });
    appendGenerationEvent(job, { text: 'b' });
    appendGenerationEvent(job, { text: 'c' });

    const received = [];
    const unsub = subscribeToJob('replay-test-1', (msg) => {
        if (msg.type === 'event') received.push(msg.entry.seq);
    }, { fromSeq: 2 });

    // Should immediately replay seq 2 and 3
    expect(received).toEqual([2, 3]);

    // Future events should also arrive
    appendGenerationEvent(job, { text: 'd' });
    expect(received).toEqual([2, 3, 4]);

    unsub();
});

describe('getTaskByRequestId', () => {
    test('returns job for correct owner', () => {
        const request = { user: { profile: { handle: 'alice' }, directories: {} }, body: {} };
        const job = createGenerationJob(request, { job_id: 'auth-test-1', persist_target: null });
        expect(getTaskByRequestId('auth-test-1', 'alice')).toBe(job);
    });

    test('throws forbidden when owner mismatch', () => {
        const request = { user: { profile: { handle: 'alice' }, directories: {} }, body: {} };
        createGenerationJob(request, { job_id: 'auth-test-2', persist_target: null });
        expect(() => getTaskByRequestId('auth-test-2', 'mallory')).toThrow('forbidden');
    });

    test('returns null when not found', () => {
        expect(getTaskByRequestId('nonexistent-id', 'anyone')).toBeNull();
    });
});
