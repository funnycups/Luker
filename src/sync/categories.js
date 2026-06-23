import path from 'node:path';

/**
 * Single source-of-truth registry for LAN-sync content categories.
 *
 * Each entry declares one logical area of user data (chats, characters,
 * presets, ...), the live filesystem paths that belong to it, and the
 * default sync policy plus any user-facing warnings the UI must surface.
 *
 * See `docs/superpowers/specs/lan-sync.md` §3 for the canonical
 * classification table this registry implements, and §7.1 for the
 * field-by-field shape contract. The registry is pure data: it performs no
 * I/O and depends on nothing outside `node:path`.
 *
 * Conflict modes:
 *   - 'file'     : per-file pick-one-side at conflict time
 *   - 'whole-db' : binary-blob category whose only resolvable unit is the
 *                  whole file (currently used by the SQLite mode storage
 *                  blob; reserved here for symmetry even though no fs-mode
 *                  category uses it).
 *   - 'none'     : informational only; never participates in conflict UI
 *                  because it is never synced.
 *
 * Sync defaults:
 *   - 'on'       : included unless the user opts out
 *   - 'opt-in'   : excluded unless the user opts in (warnings are shown
 *                  on the opt-in toggle)
 *   - 'never'    : not surfaced as a toggle; documented for transparency
 *
 * @module sync/categories
 */

/**
 * Mapping of a single live filesystem target inside a sync category.
 *
 * `from(directories)` MUST return a string. Returning anything else (a
 * `undefined` from a typo'd property, an object, etc.) indicates a bug in
 * the resolver and is rejected by `resolveCategoryPaths` so the failure
 * surfaces at the boundary instead of silently producing garbage paths
 * that escape the user root.
 *
 * @typedef {Object} SyncPath
 * @property {'file' | 'directory'} kind
 * @property {(directories: import('../users.js').UserDirectoryList) => string} from
 */

/**
 * One row of the sync-classification table (spec §3).
 *
 * `displayKey` and `descriptionKey` are i18n keys consumed by the sync
 * settings panel. `warnings[]` are additional i18n keys surfaced inline
 * next to the toggle for opt-in / cautionary categories.
 *
 * @typedef {Object} SyncCategory
 * @property {string} id
 * @property {string} displayKey
 * @property {string} descriptionKey
 * @property {SyncPath[]} paths
 * @property {'file' | 'whole-db' | 'none'} conflictMode
 * @property {'on' | 'opt-in' | 'never'} syncDefault
 * @property {boolean} [requiresAdmin]
 * @property {string[]} warnings
 */

/**
 * Resolved view of a single SyncPath after `directories` is applied.
 *
 * @typedef {Object} ResolvedSyncPath
 * @property {'file' | 'directory'} kind
 * @property {string} absolutePath
 */

// Helpers --------------------------------------------------------------------
//
// The `directory` / `file` helpers reduce per-entry boilerplate. They wrap a
// resolver function in a SyncPath descriptor so the registry below reads as
// a declarative table rather than a sea of duplicated `{ kind, from }` literals.

/**
 * Declares a directory-kind sync path.
 * @param {(directories: import('../users.js').UserDirectoryList) => string} resolver
 * @returns {SyncPath}
 */
function directory(resolver) {
    return { kind: 'directory', from: resolver };
}

/**
 * Declares a file-kind sync path.
 * @param {(directories: import('../users.js').UserDirectoryList) => string} resolver
 * @returns {SyncPath}
 */
function file(resolver) {
    return { kind: 'file', from: resolver };
}

/**
 * Skills live at `<user-root>/skills/`. The skills repository
 * (`src/skills/repository.js` `createSkillRepository`) constructs this
 * path itself instead of going through `UserDirectoryList`, so the field
 * is not present on `directories`. Resolved manually here for symmetry
 * with every other category.
 */
const skillsDirectory = directories => path.join(directories.root, 'skills');

/** Top-level file convenience: `<root>/<name>`. */
const rootFile = name => directories => path.join(directories.root, name);

// Registry -------------------------------------------------------------------

/** @type {SyncCategory[]} */
export const SYNC_CATEGORIES = [
    // ── §3.1 Default-on ────────────────────────────────────────────────────
    {
        id: 'characters',
        displayKey: 'sync.category.characters',
        descriptionKey: 'sync.category.characters.desc',
        paths: [directory(d => d.characters)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'chats',
        displayKey: 'sync.category.chats',
        descriptionKey: 'sync.category.chats.desc',
        paths: [
            directory(d => d.chats),
            directory(d => d.groups),
            directory(d => d.groupChats),
        ],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'worlds',
        displayKey: 'sync.category.worlds',
        descriptionKey: 'sync.category.worlds.desc',
        paths: [directory(d => d.worlds)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'card-apps',
        displayKey: 'sync.category.card-apps',
        descriptionKey: 'sync.category.card-apps.desc',
        paths: [directory(d => d.cardApps)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'skills',
        displayKey: 'sync.category.skills',
        descriptionKey: 'sync.category.skills.desc',
        paths: [directory(skillsDirectory)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'openai-presets',
        displayKey: 'sync.category.openai-presets',
        descriptionKey: 'sync.category.openai-presets.desc',
        paths: [directory(d => d.openAI_Settings)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'novelai-presets',
        displayKey: 'sync.category.novelai-presets',
        descriptionKey: 'sync.category.novelai-presets.desc',
        paths: [directory(d => d.novelAI_Settings)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'koboldai-presets',
        displayKey: 'sync.category.koboldai-presets',
        descriptionKey: 'sync.category.koboldai-presets.desc',
        paths: [directory(d => d.koboldAI_Settings)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'textgen-presets',
        displayKey: 'sync.category.textgen-presets',
        descriptionKey: 'sync.category.textgen-presets.desc',
        paths: [directory(d => d.textGen_Settings)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'instruct',
        displayKey: 'sync.category.instruct',
        descriptionKey: 'sync.category.instruct.desc',
        paths: [directory(d => d.instruct)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'context',
        displayKey: 'sync.category.context',
        descriptionKey: 'sync.category.context.desc',
        paths: [directory(d => d.context)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'sysprompt',
        displayKey: 'sync.category.sysprompt',
        descriptionKey: 'sync.category.sysprompt.desc',
        paths: [directory(d => d.sysprompt)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'reasoning',
        displayKey: 'sync.category.reasoning',
        descriptionKey: 'sync.category.reasoning.desc',
        paths: [directory(d => d.reasoning)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'themes',
        displayKey: 'sync.category.themes',
        descriptionKey: 'sync.category.themes.desc',
        paths: [directory(d => d.themes)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'movingUI',
        displayKey: 'sync.category.movingUI',
        descriptionKey: 'sync.category.movingUI.desc',
        paths: [directory(d => d.movingUI)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'quickreplies',
        displayKey: 'sync.category.quickreplies',
        descriptionKey: 'sync.category.quickreplies.desc',
        paths: [directory(d => d.quickreplies)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'assets',
        displayKey: 'sync.category.assets',
        descriptionKey: 'sync.category.assets.desc',
        paths: [directory(d => d.assets)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'backgrounds',
        displayKey: 'sync.category.backgrounds',
        descriptionKey: 'sync.category.backgrounds.desc',
        paths: [directory(d => d.backgrounds)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'avatars',
        displayKey: 'sync.category.avatars',
        descriptionKey: 'sync.category.avatars.desc',
        paths: [directory(d => d.avatars)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'user-files',
        displayKey: 'sync.category.user-files',
        descriptionKey: 'sync.category.user-files.desc',
        paths: [directory(d => d.files)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        // ComfyUI workflow JSON node graphs. Tiny configuration files
        // (typically 1–5 KB) that name the user's saved Comfy pipelines.
        // Lives under `user/workflows/` per `directories.comfyWorkflows`.
        // Sync-default-on for symmetry with the other small JSON config
        // categories (themes, presets, quickreplies); the spec §6.5
        // caveat about "category later added with large binaries"
        // applies if someone bundles model assets here, which is not
        // the current shape of the data.
        id: 'comfy-workflows',
        displayKey: 'sync.category.comfy-workflows',
        descriptionKey: 'sync.category.comfy-workflows.desc',
        paths: [directory(d => d.comfyWorkflows)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'user-images',
        displayKey: 'sync.category.user-images',
        descriptionKey: 'sync.category.user-images.desc',
        paths: [directory(d => d.userImages)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        // Per spec §3.1: keyed to user/images and must travel together.
        id: 'image-metadata',
        displayKey: 'sync.category.image-metadata',
        descriptionKey: 'sync.category.image-metadata.desc',
        paths: [file(rootFile('image-metadata.json'))],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'vectors',
        displayKey: 'sync.category.vectors',
        descriptionKey: 'sync.category.vectors.desc',
        paths: [directory(d => d.vectors)],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },
    {
        id: 'stats',
        displayKey: 'sync.category.stats',
        descriptionKey: 'sync.category.stats.desc',
        paths: [file(rootFile('stats.json'))],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: [],
    },

    // ── §3.2 Opt-in or on-with-warning ─────────────────────────────────────
    {
        // Default-on but warns: the single big file conflicts often. See
        // spec §6.2 for the textual-merge findings.
        id: 'settings',
        displayKey: 'sync.category.settings',
        descriptionKey: 'sync.category.settings.desc',
        paths: [file(rootFile('settings.json'))],
        conflictMode: 'file',
        syncDefault: 'on',
        warnings: ['sync.warning.settings_single_file_conflict'],
    },
    {
        id: 'secrets',
        displayKey: 'sync.category.secrets',
        descriptionKey: 'sync.category.secrets.desc',
        paths: [file(rootFile('secrets.json'))],
        conflictMode: 'file',
        syncDefault: 'opt-in',
        warnings: ['sync.warning.secrets_plaintext_transport'],
    },
    {
        id: 'extensions',
        displayKey: 'sync.category.extensions',
        descriptionKey: 'sync.category.extensions.desc',
        paths: [directory(d => d.extensions)],
        conflictMode: 'file',
        syncDefault: 'opt-in',
        warnings: ['sync.warning.extensions_version_drift'],
    },

    // ── §6.3 SQLite-mode whole-DB blob ────────────────────────────────────
    {
        // The SQLite engine's running database lives at
        // `<root>/luker-storage.sqlite`. Spec §3.3 marks the raw file as
        // "never synced" because a literal byte-copy of an open WAL'd DB
        // corrupts the snapshot; this category routes around that by
        // VACUUM-INTO'ing a consistent copy into the shadow workdir BEFORE
        // the file walk runs (see `src/sync/orchestrator.js` `runPull`).
        // `snapshotLiveToShadow` is taught to special-case this id so its
        // `from` resolver returns the shadow workdir path — the standard
        // walk then picks up the already-staged snapshot without
        // re-reading (and corrupting) the live DB.
        //
        // Only synced when the storage mode is `sqlite`: the orchestrator
        // gates the VACUUM step on `engine.kind === 'sqlite'`, and in
        // `fs` mode the live DB file does not exist, so the snapshot's
        // existence check (`fs.existsSync` on the source path) is a
        // self-healing no-op.
        //
        // Conflict mode is `whole-db`: there is no row-level merge in
        // v1. If both peers wrote to their DBs between syncs the user
        // picks one full database and the other side's writes are
        // discarded. Surface this loudly in the UI via the warning.
        id: 'database',
        displayKey: 'sync.category.database',
        descriptionKey: 'sync.category.database.desc',
        paths: [file(rootFile('luker-storage.sqlite'))],
        conflictMode: 'whole-db',
        syncDefault: 'on',
        warnings: ['sync.warning.database_whole_db_replace'],
    },
];

// Public API -----------------------------------------------------------------

/**
 * Look up a category by id.
 *
 * Returns the category object on hit, or `null` on miss. `null` (not
 * `undefined`) is the documented miss value so callers can use
 * straightforward `if (cat)` checks without conflating "category absent"
 * with "category present but falsy somewhere downstream".
 *
 * @param {string} id
 * @returns {SyncCategory | null}
 */
export function getCategoryById(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    return SYNC_CATEGORIES.find(cat => cat.id === id) || null;
}

/**
 * Resolve a category's path templates against a concrete UserDirectoryList.
 *
 * Each entry in `category.paths` is invoked with `directories`. The result
 * MUST be a non-empty string; anything else (typo'd field returning
 * `undefined`, accidental object, etc.) throws so the bug surfaces at the
 * registry boundary instead of producing a garbage absolute path that
 * could escape the user root. Callers should rely on this — they don't
 * have to re-validate.
 *
 * The returned array preserves declaration order, so multi-target
 * categories like `chats` resolve in (`chats`, `groups`, `groupChats`) order.
 *
 * @param {SyncCategory} category
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {ResolvedSyncPath[]}
 */
export function resolveCategoryPaths(category, directories) {
    if (!category || !Array.isArray(category.paths)) {
        throw new TypeError(`resolveCategoryPaths: invalid category ${category && category.id}`);
    }
    return category.paths.map((p, index) => {
        const result = p.from(directories);
        if (typeof result !== 'string' || result.length === 0) {
            throw new TypeError(
                `resolveCategoryPaths: category "${category.id}" path[${index}] resolver returned ${typeof result === 'string' ? 'empty string' : typeof result}; check the directories field referenced by this resolver`,
            );
        }
        return { kind: p.kind, absolutePath: result };
    });
}
