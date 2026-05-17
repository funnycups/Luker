import { describe, expect, test, jest } from '@jest/globals';
import { handleDirectorDispatch } from '../../../public/scripts/extensions/orchestrator/director-runtime.js';

function makeEvent({ type = 'normal' } = {}) {
    return {
        type,
        finalPrompt: 'p',
        generateData: {},
        takeoverHandle: null,
        abortSignal: new AbortController().signal,
    };
}

// Tests use a fixed-slot acquirer: production main.js wiring pushes a new
// chat entry + renders a DOM bubble, but for unit tests it is enough to
// point the kernel handle at an existing chat[0] slot — the dispatch
// claim policy + lifecycle contract are what we are verifying here.
const stubAcquirer = () => 0;

describe('handleDirectorDispatch — claim policy', () => {
    test('does not claim when profile.mode !== director', async () => {
        const ev = makeEvent();
        await handleDirectorDispatch(ev, {
            profile: { mode: 'spec' },
            chat: [{ mes: '', extra: { reasoning: '' }, is_user: false }],
            emit: jest.fn(),
            acquirePlaceholderMessageId: stubAcquirer,
            runMainLoop: jest.fn(),
        });
        expect(ev.takeoverHandle).toBeNull();
    });

    test('does not claim for quiet / impersonate', async () => {
        for (const type of ['quiet', 'impersonate']) {
            const ev = makeEvent({ type });
            await handleDirectorDispatch(ev, {
                profile: { mode: 'director', director: { mainAgent: {}, subAgents: [] } },
                chat: [{ mes: '', extra: { reasoning: '' }, is_user: false }],
                emit: jest.fn(),
                acquirePlaceholderMessageId: stubAcquirer,
                runMainLoop: jest.fn(),
            });
            expect(ev.takeoverHandle).toBeNull();
        }
    });

    test('claims handle for normal, runs main loop, commits', async () => {
        const ev = makeEvent();
        const chat = [{ mes: '', extra: { reasoning: '' }, is_user: false }];
        const runMainLoop = jest.fn(async ({ handle }) => {
            handle.setText('done');
            await handle.commit();
        });
        await handleDirectorDispatch(ev, {
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [] } },
            chat,
            emit: jest.fn(async () => {}),
            acquirePlaceholderMessageId: stubAcquirer,
            runMainLoop,
        });
        expect(ev.takeoverHandle).not.toBeNull();
        const outcome = await ev.takeoverHandle.complete;
        expect(outcome.status).toBe('committed');
        expect(outcome.finalText).toBe('done');
    });

    test('runMainLoop throw invokes deps.notifyError so the user gets a visible toast (or whatever sink the host wires)', async () => {
        const ev = makeEvent();
        const notifyError = jest.fn();
        const runMainLoop = jest.fn(async () => { throw new Error('backend 500'); });
        await handleDirectorDispatch(ev, {
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [] } },
            chat: [{ mes: '', extra: { reasoning: '' }, is_user: false }],
            emit: jest.fn(async () => {}),
            acquirePlaceholderMessageId: stubAcquirer,
            runMainLoop,
            notifyError,
        });
        await ev.takeoverHandle.complete;
        expect(notifyError).toHaveBeenCalledTimes(1);
        const [msg, errArg] = notifyError.mock.calls[0];
        expect(msg).toBe('backend 500');
        expect(errArg).toBeInstanceOf(Error);
    });

    test('runMainLoop throw commits the in-flight draft with an error marker so the user keeps the progress they were watching', async () => {
        const ev = makeEvent();
        const chat = [{ mes: 'partial draft', extra: { reasoning: '### [main]\nsome reasoning' }, is_user: false }];
        // Simulate a runtime that wrote some draft + reasoning before
        // the backend died mid-loop. The wrapper must NOT roll those
        // bytes back to pre-takeover state — losing minutes of streamed
        // sub-agent output on a transient 500 is a worse UX than
        // surfacing whatever made it through plus the error message.
        const runMainLoop = jest.fn(async () => { throw new Error('blew up'); });
        await handleDirectorDispatch(ev, {
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [] } },
            chat,
            emit: jest.fn(async () => {}),
            acquirePlaceholderMessageId: stubAcquirer,
            runMainLoop,
        });
        const outcome = await ev.takeoverHandle.complete;
        expect(outcome.status).toBe('committed');
        // The handle's complete outcome is the source of truth — the
        // kernel uses `outcome.finalText` / `outcome.finalReasoning`
        // when it writes the chat slot in production via setOnUpdate +
        // saveReply. We assert on the outcome rather than chat[] because
        // director-runtime no longer mutates chat directly (buffer-only
        // handle). originalText / originalReasoning seed the buffer at
        // claim time, so the pre-existing draft is preserved and the
        // error marker is appended to the reasoning before commit.
        expect(outcome.finalText).toBe('partial draft');
        expect(outcome.finalReasoning).toContain('### [main]\nsome reasoning');
        expect(outcome.finalReasoning).toContain('### [error]');
        expect(outcome.finalReasoning).toContain('blew up');
    });

    test('user-aborted runMainLoop → committed with [aborted] marker (handle.complete must settle for the kernel awaiting)', async () => {
        // Per the architecture, the kernel awaits handle.complete
        // unconditionally — a hanging handle would freeze the entire
        // takeover branch. Director-runtime guarantees settlement: any
        // error from runMainLoop is caught and translated into either
        // a commit (preserving in-flight work) or a discard. For user-
        // initiated aborts we commit with an [aborted] marker so the
        // user keeps whatever sub-agent output they were watching.
        const ev = makeEvent();
        const ac = new AbortController();
        ev.abortSignal = ac.signal;
        const chat = [{ mes: '', extra: { reasoning: '' }, is_user: false }];
        const runMainLoop = jest.fn(async () => {
            ac.abort();
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        });
        await handleDirectorDispatch(ev, {
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [] } },
            chat,
            emit: jest.fn(async () => {}),
            acquirePlaceholderMessageId: stubAcquirer,
            runMainLoop,
        });
        const outcome = await ev.takeoverHandle.complete;
        expect(outcome.status).toBe('committed');
        expect(outcome.finalReasoning).toContain('### [aborted]');
    }, 10000);

    test('does not claim when no acquirer is provided', async () => {
        // Production safety check: without an acquirer, runtime cannot
        // know which chat slot to write into, so it must refuse to claim
        // (rather than crash by passing undefined to createMessageEditorHandle).
        const ev = makeEvent();
        await handleDirectorDispatch(ev, {
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [] } },
            chat: [{ mes: '', extra: { reasoning: '' }, is_user: false }],
            emit: jest.fn(),
            // no acquirePlaceholderMessageId
            runMainLoop: jest.fn(),
        });
        expect(ev.takeoverHandle).toBeNull();
    });

    test('does not claim when acquirer returns an invalid id', async () => {
        const ev = makeEvent();
        await handleDirectorDispatch(ev, {
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [] } },
            chat: [{ mes: '', extra: { reasoning: '' }, is_user: false }],
            emit: jest.fn(),
            acquirePlaceholderMessageId: () => -1,
            runMainLoop: jest.fn(),
        });
        expect(ev.takeoverHandle).toBeNull();
    });
});
