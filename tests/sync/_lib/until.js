// Pause between polls, so a waiting test leaves the event loop to the
// code under test instead of spinning on it.
const POLL_INTERVAL_MS = 10;

/**
 * Resolve once `predicate` returns true. Work the code under test started
 * in the background finishes at an unknown point; the Jest test timeout
 * bounds how long a failing test waits.
 *
 * @param {() => boolean | Promise<boolean>} predicate
 * @returns {Promise<void>}
 */
export async function until(predicate) {
    while (!await predicate()) await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
}
