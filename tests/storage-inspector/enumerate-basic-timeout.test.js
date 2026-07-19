// Deterministic replacement for the walk-timeout propagation test that used
// to live in enumerate-basic.test.js. The old test set the soft-timeout to
// 1ms and depended on the real event loop losing a race — flaky under group
// runs. Here we use jest fake timers so the setTimeout inside
// computeCategorySizeWithTimeout fires (or doesn't) under our control,
// verifying the wrapper contract deterministically:
//   error === 'timeout' → sizeBytes:null / note about time / canDrill:false
//   walk finishes first → real sizeBytes / note:null / canDrill:true
//
// The inspector module uses a module-local binding for
// computeCategorySizeWithTimeout, so ESM export mocking cannot intercept the
// call from enumerateRoot. Fake timers are the only reliable deterministic
// route without touching production code.
import { jest } from '@jest/globals';
import { makeFixtureUser } from './_fixture-helper.js';
import {
    enumerateRoot,
    __setCategoryWalkSoftTimeoutForTest,
} from '../../src/storage/inspector.js';

const FAKE_USER = { handle: 'default-user', storageQuotaBytes: -1 };
const FAKE_ADMIN_SETTINGS = { storage: { defaultUserQuotaBytes: -1 } };

describe('enumerateRoot — timeout contract (deterministic via fake timers)', () => {
    beforeEach(() => {
        // Fake only setTimeout / clearTimeout / setImmediate so that libuv-
        // backed fs I/O still runs on real timers. This lets the walkP
        // promise stay pending on real fs work while we control when (or
        // whether) the wrapper's setTimeout fires — Promise.race
        // deterministically picks the branch we want.
        jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    });

    afterEach(() => {
        jest.useRealTimers();
        __setCategoryWalkSoftTimeoutForTest(30_000);
    });

    test('all categories time out → every entry has sizeBytes:null, note about time, canDrill:false', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({
            worlds: true, extensions: true, vectors: true,
        });
        try {
            __setCategoryWalkSoftTimeoutForTest(1);
            const p = enumerateRoot(userRoot, FAKE_USER, FAKE_ADMIN_SETTINGS);
            // Fire the wrapper's setTimeout(...1ms) synchronously. walkP is
            // still pending on real fs I/O (libuv has not had a chance to
            // deliver readdir/stat completions because we have not yielded
            // to the event loop for a full turn). Loop a few iterations to
            // cover cascading microtasks; cheap.
            for (let i = 0; i < 5; i++) {
                jest.advanceTimersByTime(10);
                await Promise.resolve();
            }
            const res = await p;

            // Every category should have hit the timeout branch.
            expect(res.entries.length).toBe(10);
            for (const e of res.entries) {
                expect(e.sizeBytes).toBeNull();
                expect(e.note).toMatch(/time/i);
                expect(e.canDrill).toBe(false);
            }
            // usedBytes sum should be 0 because all null → treated as 0
            expect(res.quota.usedBytes).toBe(0);
        } finally {
            await cleanup();
        }
    });

    test('walk finishes before timeout → every entry has note:null, canDrill:true', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({
            worlds: true, extensions: true, vectors: true,
        });
        try {
            // Timeout is 30s; we never advance fake timers, so the wrapper's
            // setTimeout can never win the race. Real fs I/O (still on real
            // timers because we did not fake libuv) completes normally.
            __setCategoryWalkSoftTimeoutForTest(30_000);
            const res = await enumerateRoot(userRoot, FAKE_USER, FAKE_ADMIN_SETTINGS);

            expect(res.entries.length).toBe(10);
            for (const e of res.entries) {
                expect(e.sizeBytes).not.toBeNull();
                expect(e.note).toBeNull();
                expect(e.canDrill).toBe(true);
            }
        } finally {
            await cleanup();
        }
    });
});
