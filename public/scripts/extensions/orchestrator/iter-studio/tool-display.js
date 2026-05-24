// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator tool-display map — feeds renderToolCallChip's `opts.toolDisplay`.
 *
 * Keys are the `luker_orch_*` tool names registered in
 * `orchestrator/main.js#buildAiIterationToolSet` (one catalog per mode:
 * director / agenda / loop / spec), plus the four control tools that
 * `iter-studio/studio.js` splices into every catalog
 * (`luker_orch_continue_iteration`, `luker_orch_finalize_iteration`,
 * `luker_orch_reset_live_to_blank`, `luker_orch_reset_live_to_global`).
 *
 * Each value is `{ icon, label, type, summarize?(args, result, i18n) }`:
 *   - `type: 'edit'`    — mutates the working profile (sandbox-diff
 *                          normalizes these to one coarse
 *                          `{op:'set', path:'', oldValue, newValue}` edit per
 *                          turn; per-leaf splitting happens in the shared
 *                          `iteration-library/ui/diff` renderer).
 *   - `type: 'read'`    — reads the working profile / runs a simulation
 *                          (currently just `luker_orch_simulate`); the
 *                          shared message renderer surfaces a read-only-round
 *                          hint when every tool call in a turn is read-type.
 *   - `type: 'remove'`  — drops a sub-agent / agenda agent / stage /
 *                          node / preset by id (visually distinct icon
 *                          but routes through the same sandbox-diff
 *                          normalizer as the `set_*` tools).
 *   - `type: 'control'` — popup-flow control tools (continue / finalize /
 *                          reset). These never reach the sandbox
 *                          executor; the runner routes them through
 *                          `onControlCall` in `iter-studio/studio.js`.
 *
 * `summarize(args, result, i18n)` produces a one-line digest shown next
 * to the chip label so the user doesn't have to expand the args block
 * for the common case. We return either the targeted id/path (for
 * upsert / remove tools) or an empty string (for control tools that
 * don't have meaningful args).
 *
 * Both `label` and the templates inside `summarize` are the English
 * source strings. `renderToolCallChip` threads the popup's runtime
 * `i18n` translator into both — into `label` via a direct lookup and
 * into `summarize` via the third callback argument — so this file
 * declares the i18n keys, never the localized text.
 */

function fmt(i18n, template, ...values) {
    const translated = (typeof i18n === 'function' ? i18n(template) : template) || template;
    return String(translated).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

export const ORCH_TOOL_DISPLAY = {
    // ── Director mode ───────────────────────────────────────────────
    luker_orch_set_director_main_agent: {
        icon: '✏️',
        label: 'Update director main agent',
        type: 'edit',
        summarize: (a, r, i18n) => (typeof i18n === 'function' ? i18n('main agent') : 'main agent'),
    },
    luker_orch_set_director_subagent: {
        icon: '✏️',
        label: 'Upsert director sub-agent',
        type: 'edit',
        summarize: (a) => String(a?.id || ''),
    },
    luker_orch_remove_director_subagent: {
        icon: '🗑️',
        label: 'Remove director sub-agent',
        type: 'remove',
        summarize: (a) => String(a?.id || ''),
    },
    luker_orch_set_director_limits: {
        icon: '✏️',
        label: 'Update director limits',
        type: 'edit',
        summarize: (a, r, i18n) => (typeof i18n === 'function' ? i18n('limits') : 'limits'),
    },
    luker_orch_set_director_tools: {
        icon: '✏️',
        label: 'Update director tools',
        type: 'edit',
        summarize: (a, r, i18n) => (typeof i18n === 'function' ? i18n('tools') : 'tools'),
    },

    // ── Loop mode ───────────────────────────────────────────────────
    luker_orch_set_loop_profile: {
        icon: '✏️',
        label: 'Update loop profile',
        type: 'edit',
        summarize: (a, r, i18n) => (typeof i18n === 'function' ? i18n('loop profile') : 'loop profile'),
    },

    // ── Agenda mode ─────────────────────────────────────────────────
    luker_orch_set_agenda_planner: {
        icon: '✏️',
        label: 'Update agenda planner',
        type: 'edit',
        summarize: (a, r, i18n) => (typeof i18n === 'function' ? i18n('planner') : 'planner'),
    },
    luker_orch_set_agenda_agent: {
        icon: '✏️',
        label: 'Upsert agenda agent',
        type: 'edit',
        summarize: (a) => String(a?.id || ''),
    },
    luker_orch_remove_agenda_agent: {
        icon: '🗑️',
        label: 'Remove agenda agent',
        type: 'remove',
        summarize: (a) => String(a?.id || ''),
    },
    luker_orch_set_agenda_final_agent: {
        icon: '✏️',
        label: 'Set agenda final agent',
        type: 'edit',
        summarize: (a) => String(a?.id || ''),
    },
    luker_orch_set_agenda_limits: {
        icon: '✏️',
        label: 'Update agenda limits',
        type: 'edit',
        summarize: (a, r, i18n) => (typeof i18n === 'function' ? i18n('limits') : 'limits'),
    },

    // ── Spec mode ───────────────────────────────────────────────────
    luker_orch_set_stage: {
        icon: '✏️',
        label: 'Upsert pipeline stage',
        type: 'edit',
        summarize: (a) => String(a?.id || ''),
    },
    luker_orch_remove_stage: {
        icon: '🗑️',
        label: 'Remove pipeline stage',
        type: 'remove',
        summarize: (a) => String(a?.id || ''),
    },
    luker_orch_set_node: {
        icon: '✏️',
        label: 'Upsert stage node',
        type: 'edit',
        summarize: (a) => `${a?.stage_id || '?'} / ${a?.id || '?'}`,
    },
    luker_orch_remove_node: {
        icon: '🗑️',
        label: 'Remove stage node',
        type: 'remove',
        summarize: (a) => `${a?.stage_id || '?'} / ${a?.id || '?'}`,
    },
    luker_orch_set_preset: {
        icon: '✏️',
        label: 'Upsert preset',
        type: 'edit',
        summarize: (a) => String(a?.id || ''),
    },
    luker_orch_remove_preset: {
        icon: '🗑️',
        label: 'Remove preset',
        type: 'remove',
        summarize: (a) => String(a?.id || ''),
    },

    // ── Read tools (any mode that exposes them) ────────────────────
    luker_orch_simulate: {
        icon: '🧪',
        label: 'Simulate orchestration',
        type: 'read',
        summarize: (a) => {
            const input = String(a?.input || '');
            return input ? input.slice(0, 60) : '';
        },
    },

    // ── Control tools (every mode) ─────────────────────────────────
    luker_orch_continue_iteration: {
        icon: '➡️',
        label: 'Continue iteration',
        type: 'control',
    },
    luker_orch_finalize_iteration: {
        icon: '✅',
        label: 'Finalize iteration',
        type: 'control',
    },
    luker_orch_reset_live_to_blank: {
        icon: '♻️',
        label: 'Reset working profile to blank',
        type: 'control',
    },
    luker_orch_reset_live_to_global: {
        icon: '⬇️',
        label: 'Reset working profile to global',
        type: 'control',
    },

    // ── Lorebook read tools (borrowed surface from the CEA editor) ──
    // Spliced into the catalog by iter-studio/studio.js#buildToolCatalog
    // only when the popup is scoped to a character with an avatar — the
    // legacy helper-tool dispatcher is per-character. Summarize functions
    // mirror the CEA editor's tool-display so a future shared module can
    // collapse the duplication.
    world_book_list: {
        icon: '📚',
        label: 'List world books',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const count = Array.isArray(r.books) ? r.books.length : Number(r.count || 0);
                return fmt(i18n, '${0} books', count);
            }
            return '';
        },
    },
    lorebook_list: {
        icon: '📋',
        label: 'List lorebook entries',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const count = Array.isArray(r.entries) ? r.entries.length : Number(r.count || 0);
                return fmt(i18n, '${0} entries', count);
            }
            return a?.book_name ? String(a.book_name) : '';
        },
    },
    lorebook_query: {
        icon: '🔍',
        label: 'Search lorebook',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const count = Array.isArray(r.matches) ? r.matches.length : Number(r.count || 0);
                return fmt(i18n, '${0} hits', count);
            }
            const book = a?.book_name ? String(a.book_name) : '';
            const text = a?.text ? String(a.text) : (a?.query ? String(a.query) : '');
            return [book, text].filter(Boolean).join(' ');
        },
    },
    lorebook_get: {
        icon: '📖',
        label: 'Read lorebook entries',
        type: 'read',
        summarize: (a, r, i18n) => {
            if (r && typeof r === 'object') {
                const count = Array.isArray(r.entries) ? r.entries.length : 1;
                return fmt(i18n, '${0} entries', count);
            }
            const uids = Array.isArray(a?.uids) ? a.uids.join(',') : '';
            const book = a?.book_name ? String(a.book_name) : '';
            return [book, uids].filter(Boolean).join(' ');
        },
    },
};
