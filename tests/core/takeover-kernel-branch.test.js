import { describe, test } from '@jest/globals';

/**
 * Kernel takeover-branch tests.
 *
 * The kernel branch lives in `public/script.js` which carries hundreds of
 * side-effecting imports (DOM, jQuery, audio, sandbox iframes…). Spinning
 * up a full ESM mock graph just to drive the takeover branch costs more
 * than it returns — the plan explicitly downgrades verification mode to
 * manual smoke testing here.
 *
 * What we keep as automated coverage:
 *   - The buffer-only handle is exhaustively covered in
 *     `tests/message-takeover.test.js`.
 *   - The kernel branch's behavioural contract is captured as `test.todo`
 *     entries below so it shows up in the test run as "not yet
 *     implemented" rather than a silent `expect(true).toBe(true)` pass.
 *     If/when we extract `runTakeoverBranch(...)` into its own module the
 *     todos convert into real assertions one-for-one.
 *
 * Manual smoke matrix (run after changes to the branch):
 *   1. Director normal generate → assistant message appears, refresh persists.
 *   2. Director generate, click stop mid-stream → message cleanly removed,
 *      no UI lock (send button reactivates), no "leave page?" warning.
 *   3. Swipe over takeover output → swipes[] populated, swipe arrows work.
 *   4. Continue over takeover output → text extended, no duplicate slot.
 *   5. Regenerate over takeover output → previous replaced, no orphan slot.
 *
 * Abort policy reminder: there is no time-based watchdog in the kernel.
 * If a plugin never settles its handle, the user clicks stop; the kernel
 * does not time-trigger an abort. A plugin that ignores the abort signal
 * is a plugin bug — not something the kernel masks with a timeout.
 */
describe('kernel takeover branch — contract (smoke-tested manually)', () => {
    test.todo('committed path: kernel pushes placeholder, subscribes onUpdate, awaits complete, calls saveReply, emits MESSAGE_RECEIVED + CHARACTER_MESSAGE_RENDERED');
    test.todo('discarded path: rollbackTakeoverPlaceholder removes (normal/regenerate) or restores (swipe/continue), emits GENERATION_STOPPED, unblocks UI');
    test.todo('discarded path: rollback failure is logged but does not prevent GENERATION_STOPPED + unblockGeneration');
    test.todo('committed path: setOnUpdate(null) called after handle.complete settles so a stray onUpdate cannot overwrite cleanedText');
});
