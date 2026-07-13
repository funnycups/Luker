/**
 * loop-tools/lorebook-force-activate.js — Layer-1 builtin that injects
 * a normally-dormant World Info entry into the in-flight wiFinalizedPayload
 * before `script.js` joins it into the main model's prompt for THIS turn.
 *
 * Why it works (timing):
 *   `GENERATION_WORLD_INFO_FINALIZED` is fired with `await eventSource.emit`,
 *   which serially awaits every listener. The orchestrator's
 *   `onWorldInfoFinalized` is one of those listeners, and the entire
 *   orchestration run (loop / spec / agenda) runs inside it — see
 *   `main.js:1183`'s `Promise.race([orchestrationTask, stopRequestPromise])`.
 *   After emit returns, `script.js:7729` calls
 *   `joinWorldInfoEntries(worldInfoBeforeEntries)` on the *same array
 *   reference* the payload carries — so anything pushed into
 *   `payload.worldInfoBeforeEntries` / `.worldInfoAfterEntries` /
 *   `.worldInfoDepth[i].entries` during the orchestration's tool calls
 *   lands in the main model's `<world_info>` channel verbatim,
 *   indistinguishable from a naturally-activated entry.
 *
 * Mode applicability:
 *   - loop: full support. The loop agent runs inside emit.
 *   - spec: full support. Each node runs inside emit. Sharp edge: spec
 *     nodes that already ran in the same turn will NOT see your forced
 *     entries — their per-node prompts were already assembled. Only the
 *     final main-model generation reads the appended <world_info>.
 *   - agenda: full support. Same model as spec for sibling timing.
 *   - director: NOT SUPPORTED. Director's main agent runs in the
 *     GENERATE_TAKEOVER_DISPATCH handler (script.js:8495), which fires
 *     AFTER the WI payload has been joined into the prompt strings.
 *     Calling from director cleanly returns LOREBOOK_FORCE_NO_PAYLOAD
 *     because the takeover handler does not receive the WI payload —
 *     `ctx.__lukerRun.wiFinalizedPayload` is undefined.
 *
 * Sharp edges (also called out in the tool description for the LLM):
 *   - Bypasses token-budget tracking. Forced entries don't pay into the
 *     budget WI scan computed, so pushing too much will silently evict
 *     chat history. Force only what the turn actually needs.
 *   - No recursive key scanning. A forced entry's content does NOT trigger
 *     scan of secondary entries — only what you forced lands.
 *   - constant:true entries are already always-on; forcing them is a no-op
 *     duplicate at best.
 *
 * Returns per-uid status so the LLM can pivot if any uid was rejected.
 */

import { ToolError } from '../loop-runtime.js';
import { compileLorebookFilter } from '../lorebook-filter.js';

const POSITION_BEFORE = 0;
const POSITION_AFTER = 1;
const POSITION_AN_TOP = 2;
const POSITION_AN_BOTTOM = 3;
const POSITION_AT_DEPTH = 4;
const POSITION_EM_TOP = 5;
const POSITION_EM_BOTTOM = 6;

function findOrCreateDepthBucket(payload, depth, role) {
    if (!Array.isArray(payload.worldInfoDepth)) {
        payload.worldInfoDepth = [];
    }
    const wantDepth = Math.max(0, Math.floor(Number(depth) || 0));
    const wantRole = Number.isFinite(Number(role)) ? Number(role) : 0;
    let bucket = payload.worldInfoDepth.find(b =>
        Math.max(0, Math.floor(Number(b?.depth) || 0)) === wantDepth
        && Number(b?.role ?? 0) === wantRole
    );
    if (!bucket) {
        bucket = { depth: wantDepth, role: wantRole, entries: [] };
        payload.worldInfoDepth.push(bucket);
    } else if (!Array.isArray(bucket.entries)) {
        bucket.entries = [];
    }
    return bucket;
}

function describeRoute(position) {
    switch (Number(position)) {
        case POSITION_BEFORE: return 'before-char';
        case POSITION_AFTER: return 'after-char';
        case POSITION_AT_DEPTH: return 'at-depth';
        case POSITION_AN_TOP: return 'AN-top';
        case POSITION_AN_BOTTOM: return 'AN-bottom';
        case POSITION_EM_TOP: return 'EM-top';
        case POSITION_EM_BOTTOM: return 'EM-bottom';
        default: return `unknown(${position})`;
    }
}

/**
 * Loader hook — production reads from `Luker.getContext().loadWorldInfo`,
 * tests inject `context.__loadWorldInfoFn` to avoid pulling the build-only
 * `lib.js` bundle into the Jest runner.
 */
async function loadBookSafe(context, bookName) {
    if (typeof context?.__loadWorldInfoFn === 'function') {
        return context.__loadWorldInfoFn(bookName);
    }
    const loader = Luker.getContext()?.loadWorldInfo;
    if (typeof loader !== 'function') return null;
    return loader(bookName);
}

/**
 * @param {{ book_name: string, uids: number[] }} args
 * @param {object} context
 * @returns {Promise<{ok: true, activated: Array<object>, skipped: Array<object>}>}
 */
export async function execLorebookForceActivate(args, context) {
    const bookName = String(args?.book_name ?? '').trim();
    if (!bookName) {
        throw new ToolError(
            'lorebook_force_activate: book_name is required.',
            'LOREBOOK_FORCE_BOOK_MISSING',
            'Pass the world book name (as seen in world_book_list / lorebook_list output).',
        );
    }
    const uids = Array.isArray(args?.uids) ? args.uids.map(Number).filter(Number.isFinite) : [];
    if (uids.length === 0) {
        throw new ToolError(
            'lorebook_force_activate: uids must be a non-empty array of numeric uids.',
            'LOREBOOK_FORCE_UIDS_MISSING',
            'Pass the uids you got from lorebook_list output for the same book.',
        );
    }

    const payload = context?.__lukerRun?.wiFinalizedPayload;
    if (!payload || typeof payload !== 'object') {
        throw new ToolError(
            'lorebook_force_activate: no in-flight World Info payload on this run.',
            'LOREBOOK_FORCE_NO_PAYLOAD',
            'This tool only works in loop / spec / agenda — those modes run inside the GENERATION_WORLD_INFO_FINALIZED frame that owns the WI payload. Director\'s main agent runs in the takeover handler that fires AFTER WI is baked into the prompt; force-activation is too late there.',
        );
    }

    const book = await loadBookSafe(context, bookName);
    if (!book || !book.entries || typeof book.entries !== 'object') {
        throw new ToolError(
            `lorebook_force_activate: world book '${bookName}' not found or empty.`,
            'LOREBOOK_FORCE_BOOK_NOT_FOUND',
            'Verify the name via world_book_list. Names are case-sensitive.',
        );
    }

    // Source-side filter: a book-pattern match makes the whole book
    // invisible — throw the same error a genuinely absent book would.
    // An entry-pattern match makes the specific uid invisible — the
    // per-uid loop below reports it as `uid_not_found`, indistinguishable
    // from a uid that never existed in the book. Zero side channel.
    const compiled = compileLorebookFilter(context?.__lukerRun?.lorebookFilter || { bookPattern: '', entryPattern: '' });
    if (compiled.test(bookName, '')) {
        throw new ToolError(
            `lorebook_force_activate: world book '${bookName}' not found or empty.`,
            'LOREBOOK_FORCE_BOOK_NOT_FOUND',
            'Verify the name via world_book_list. Names are case-sensitive.',
        );
    }

    // Ensure the before/after arrays exist so push() is safe.
    if (!Array.isArray(payload.worldInfoBeforeEntries)) payload.worldInfoBeforeEntries = [];
    if (!Array.isArray(payload.worldInfoAfterEntries)) payload.worldInfoAfterEntries = [];

    const activated = [];
    const skipped = [];
    const activatedSet = context?.__lukerRun?.activatedEntryKeys instanceof Set
        ? context.__lukerRun.activatedEntryKeys
        : null;

    for (const uid of uids) {
        const entry = book.entries[uid] || book.entries[String(uid)];
        if (!entry) {
            skipped.push({ uid, reason: 'uid_not_found' });
            continue;
        }
        // Entry-pattern filter: report as uid_not_found so a filtered
        // entry looks identical to one that simply doesn't exist.
        if (!compiled.isEmpty && compiled.test(entry.world, entry.comment)) {
            skipped.push({ uid, reason: 'uid_not_found' });
            continue;
        }
        if (entry.disable) {
            skipped.push({ uid, reason: 'entry_disabled' });
            continue;
        }
        const content = String(entry.content || '').trim();
        if (!content) {
            skipped.push({ uid, reason: 'empty_content' });
            continue;
        }
        const key = `${bookName}.${uid}`;
        if (activatedSet && activatedSet.has(key)) {
            skipped.push({ uid, reason: 'already_activated' });
            continue;
        }
        const position = Number(entry.position);
        let route;
        switch (position) {
            case POSITION_BEFORE:
                payload.worldInfoBeforeEntries.push(content);
                route = 'before-char';
                break;
            case POSITION_AFTER:
                payload.worldInfoAfterEntries.push(content);
                route = 'after-char';
                break;
            case POSITION_AT_DEPTH: {
                const bucket = findOrCreateDepthBucket(payload, entry.depth, entry.role);
                bucket.entries.push(content);
                route = `at-depth(d=${bucket.depth},r=${bucket.role})`;
                break;
            }
            // AN-top / AN-bottom / EM-top / EM-bottom: these positions feed
            // dedicated buckets (anBefore/anAfter/worldInfoExamples) that
            // the main pipeline reshapes. We deliberately don't support
            // those routes in the first cut — pushing into them safely
            // would require deeper knowledge of how the AN-builder merges
            // entries with the author note text. Surface a clear skip so
            // the LLM picks a different uid.
            default:
                skipped.push({
                    uid,
                    reason: `unsupported_position(${describeRoute(position)})`,
                });
                continue;
        }
        if (activatedSet) activatedSet.add(key);
        activated.push({
            uid,
            comment: String(entry.comment || ''),
            route,
            chars: content.length,
        });
    }

    return { ok: true, book: bookName, activated, skipped };
}
