/**
 * Selection mapping helpers for cross-mode restore.
 *
 * The user-facing backup selection has 10 categories:
 *   settings, secrets, characters, chats, lorebooks, presets,
 *   assets, extensions, globalExtensions, vectors.
 *
 * MigrationRunner only knows about 7 repo-level categories:
 *   settings, presets, namedDocs, worlds, chats, groups, stats.
 *
 * The 4 categories that overlap have a non-trivial mapping (see §5.3 of
 * the design doc):
 *   - `presets`   gates BOTH the preset repo AND named-docs
 *                 (themes / movingUI / quickReplies are bundled with
 *                 presets in the UI, no separate checkbox).
 *   - `chats`     gates the chats repo PLUS group docs (group chats are
 *                 chats) PLUS stats (derived from chats).
 *   - `lorebooks` gates only the world-info repo.
 *   - `settings`  gates only the settings repo.
 *
 * The other 6 categories (secrets, characters, assets, extensions,
 * globalExtensions, vectors) are pure fs-tree categories — they live
 * only on disk, never in any engine. They're handled exclusively by
 * extractFsTreeCategories in the orchestrator and never touch the
 * MigrationRunner. The `FS_TREE_CATEGORIES` export below names them so
 * the orchestrator can iterate without re-listing.
 */

/** @type {ReadonlyArray<string>} */
export const FS_TREE_CATEGORIES = Object.freeze([
    'secrets',
    'characters',
    'assets',
    'extensions',
    'globalExtensions',
    'vectors',
]);

/**
 * Map a 10-key backup selection to the 7-key MigrationRunner categories
 * shape. All-true defaults are NOT applied here — missing or falsy
 * selection keys map to `false`, so the resulting object never enables a
 * category the user did not explicitly select.
 *
 * @param {Record<string, boolean>|null|undefined} selection
 * @returns {{ settings: boolean, presets: boolean, namedDocs: boolean,
 *            worlds: boolean, chats: boolean, groups: boolean, stats: boolean }}
 */
export function selectionToRunnerCategories(selection) {
    const sel = selection || {};
    return {
        settings: !!sel.settings,
        presets: !!sel.presets,
        // themes / movingUI / quickReplies travel with presets — no
        // separate UI checkbox, no separate runner toggle.
        namedDocs: !!sel.presets,
        worlds: !!sel.lorebooks,
        chats: !!sel.chats,
        // Group docs travel with chats — selecting chats also brings
        // groups; the standalone `groups` runner category does not
        // appear in the UI.
        groups: !!sel.chats,
        // Stats are derived from chats — selecting chats brings stats.
        stats: !!sel.chats,
    };
}
