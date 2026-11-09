// SPDX-License-Identifier: AGPL-3.0-or-later
//
// tag filter dialog (opened from the memory structure bar): on/off, presets, black /
// white lists with quick-add tags, AI diagnosis and a before / after preview.
// Edits stay in the dialog until save.

import { h, clear, put } from '../../../lens-shared/util.js';
import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { button, switchControl, checkRow } from '../ui/components.js';
import { COMMON_BLACK, commonWhiteTags, addToList, filterText, invalidTokens, planWarnings, parseTagList } from './tag-filter.js';

let presetCounter = 0;
const newId = () => `p${Date.now().toString(36)}${++presetCounter}`;

/**
 * @param {{ access, aiAccess, confirmModal, showToast }} deps
 */
export function openFilterDialog({ access, aiAccess, confirmModal, showToast }) {
    let state;
    try { state = structuredClone(access.read()); } catch (err) { showToast(i18nFormat('Tag filter error: ${0}', String(err?.message || err))); return; }
    const replies = (() => { try { return access.recentReplies?.(8) || []; } catch { return []; } })();
    let sampleIndex = 0;
    const count = (text) => String(text ?? '').replace(/\s+/g, '').length;
    // Text memory-graph really reads (whitespace collapsed + the user's own
    // plugin-lane regex); falls back to the raw reply in the preview build.
    const readFor = (i, plan) => {
        const reply = replies[i];
        if (!reply) return null;
        if (access.preview) {
            try { return access.preview(reply.floor, plan); } catch { /* fall back */ }
        }
        return { before: reply.text, after: filterText(reply.text, plan), real: false };
    };
    const planNow = () => ({ ...current(), mirrorPrompt: state.mirrorPrompt !== false });
    const lensText = (i) => readFor(i, { black: '', white: '' })?.before || '';
    let diagnosis = null;
    let busy = false;
    const current = () => state.presets.find(p => p.id === state.active) || state.presets[0];

    const root = h('div', { class: 'ml-filter' });
    const presetBox = h('section', { class: 'ml-filter-presets' });
    const listsBox = h('div', { class: 'ml-filter-lists' });
    const aiBox = h('div', { class: 'ml-filter-ai' });
    const previewBox = h('section', { class: 'ml-filter-preview' });
    const blackInput = h('textarea', { class: 'ml-schema-input ml-filter-input', rows: 1, placeholder: i18n('For example: think, details, !--'), 'aria-label': i18n('Blacklist') });
    const whiteInput = h('textarea', { class: 'ml-schema-input ml-filter-input', rows: 1, placeholder: i18n('For example: content, [time]'), 'aria-label': i18n('Whitelist') });
    const blackHint = h('p', { class: 'ml-filter-bad', hidden: true });
    const whiteHint = h('p', { class: 'ml-filter-bad', hidden: true });
    const whiteWarn = h('p', { class: 'ml-filter-warn', hidden: true });

    const onListInput = () => {
        const preset = current();
        preset.black = blackInput.value;
        preset.white = whiteInput.value;
        paintHints();
        paintPreview();
    };
    blackInput.addEventListener('input', onListInput);
    whiteInput.addEventListener('input', onListInput);

    // ----- Presets ---------------------------------------------------------
    function paintPresets() {
        clear(presetBox);
        const select = h('select', { class: 'ml-select', 'aria-label': i18n('Filter profile'), onChange: (e) => { state.active = e.target.value; diagnosis = null; paintAll(); } },
            state.presets.map(p => h('option', { value: p.id, text: p.name || i18n('Unnamed profile') })));
        select.value = current().id;
        const name = h('input', {
            type: 'text', class: 'ml-schema-input ml-filter-name', value: current().name, maxlength: 30,
            placeholder: i18n('Give this profile a name'), 'aria-label': i18n('Profile name'),
            onInput: (e) => {
                current().name = e.target.value;
                const option = select.querySelector(`option[value="${CSS.escape(current().id)}"]`);
                if (option) option.textContent = e.target.value.trim() || i18n('Unnamed profile');
            },
        });
        put(presetBox,
            h('div', { class: 'ml-filter-label', text: i18n('Filter profile') }),
            h('div', { class: 'ml-filter-presetrow' },
                select,
                name,
                button(i18n('New'), () => {
                    const preset = { id: newId(), name: i18nFormat('Profile ${0}', state.presets.length + 1), black: '', white: '' };
                    state.presets.push(preset);
                    state.active = preset.id;
                    diagnosis = null;
                    paintAll();
                }, { iconName: 'plus', className: 'ml-btn-sm ml-btn-ghost' }),
                button(i18n('Delete'), () => {
                    if (state.presets.length <= 1) {
                        Object.assign(current(), { black: '', white: '' });
                    } else {
                        state.presets = state.presets.filter(p => p.id !== state.active);
                        state.active = state.presets[0].id;
                    }
                    diagnosis = null;
                    paintAll();
                }, { iconName: 'trash', className: 'ml-btn-sm ml-btn-ghost ml-filter-del' })));
    }

    // ----- Lists -----------------------------------------------------------
    function chips(tags, input) {
        return h('div', { class: 'ml-filter-chips' },
            h('span', { class: 'ml-filter-chips-label', text: i18n('Common') }),
            tags.map(tag => h('button', {
                type: 'button', class: 'ml-filter-chip', text: tag,
                onClick: () => { input.value = addToList(input.value, tag); onListInput(); },
            })));
    }

    function listBlock(kind) {
        const black = kind === 'black';
        return h('section', { class: 'ml-filter-list', dataset: { kind } },
            h('div', { class: 'ml-filter-label' },
                h('span', { text: black ? i18n('Blacklist') : i18n('Whitelist') }),
                h('span', { class: 'ml-filter-label-note', text: black ? i18n('Remove these tags and their contents, keep the rest') : i18n('Keep only the contents of these tags, remove everything else') })),
            black ? blackInput : whiteInput,
            black ? blackHint : whiteHint,
            chips(black ? COMMON_BLACK : commonWhiteTags(), black ? blackInput : whiteInput),
            black ? null : h('p', { class: 'ml-filter-tip', text: i18n('Do not use a whitelist when the story is not wrapped in a tag, or the whole story will be removed. The blacklist runs first, then the whitelist.') }),
            black ? null : whiteWarn);
    }

    function paintHints() {
        for (const [input, hint] of [[blackInput, blackHint], [whiteInput, whiteHint]]) {
            const bad = invalidTokens(input.value);
            hint.hidden = !bad.length;
            hint.textContent = bad.length ? i18nFormat('Could not understand these, ignored: ${0}', bad.join(listSeparator())) : '';
        }
        const r = readFor(sampleIndex, planNow());
        const warn = r && parseTagList(current().white).length && count(r.before) && !count(r.after) ? ['empty']
            : planWarnings(current(), lensText(sampleIndex));
        whiteWarn.hidden = !warn.length;
        whiteWarn.textContent = warn.includes('empty') ? i18n('With the current whitelist this reply would be removed entirely. The story may not be wrapped in a tag; a blacklist is recommended.') : warn.includes('tiny') ? i18n('With the current whitelist very little of this reply remains. Check the preview below to make sure the story was not removed.') : '';
    }

    // ----- AI diagnosis ---------------------------------------------------------
    function paintAi() {
        clear(aiBox);
        if (!aiAccess?.diagnoseFilter) return;
        const sample = lensText(0);
        const btn = button(busy ? i18n('Diagnosing…') : i18n('AI diagnosis'), async () => {
            if (busy || !sample) return;
            busy = true;
            paintAi();
            try {
                diagnosis = await aiAccess.diagnoseFilter(sample);
                blackInput.value = diagnosis.black;
                whiteInput.value = diagnosis.white;
                sampleIndex = 0;
                onListInput();
            } catch (err) {
                diagnosis = null;
                showToast(i18nFormat('Something went wrong: ${0}', String(err?.message || err)));
            } finally {
                busy = false;
                paintAi();
            }
        }, { iconName: 'sparkle', className: 'ml-btn-sm', disabled: busy || !sample, title: i18n('Let the AI read the latest reply and decide between a blacklist and a whitelist') });
        put(aiBox,
            h('div', { class: 'ml-filter-ai-row' }, btn,
                h('span', { class: 'ml-filter-ai-note', text: sample ? i18n('Let the AI read the latest reply and decide between a blacklist and a whitelist') : i18n('This chat has no AI replies yet') })),
            diagnosis ? h('div', { class: 'ml-filter-diag', role: 'status' },
                h('div', { class: 'ml-filter-diag-head' },
                    h('span', { class: 'ml-filter-diag-tag', text: diagnosis.body === 'wrapped' ? i18n('The story is wrapped in a tag') : i18n('The story is bare text') }),
                    h('span', { text: diagnosis.white ? i18n('Whitelist recommended') : i18n('Blacklist recommended') })),
                diagnosis.reason ? h('p', { text: diagnosis.reason }) : null,
                diagnosis.notes.map(note => h('p', { class: 'ml-filter-warn', text: note })),
                h('p', { class: 'ml-filter-tip', text: i18n('Filled into the boxes above. Check the preview, then save if it looks right.') })) : null);
    }

    // ----- Preview ---------------------------------------------------------
    function paintPreview() {
        clear(previewBox);
        put(previewBox, h('div', { class: 'ml-filter-label' },
            h('span', { text: i18n('Preview') }),
            replies.length ? (() => {
                const select = h('select', { class: 'ml-select ml-filter-sample', 'aria-label': i18n('Pick a reply'), onChange: (e) => { sampleIndex = Number(e.target.value); paintHints(); paintPreview(); } },
                    replies.map((r, i) => h('option', { value: String(i), text: i === 0 ? i18nFormat('Latest (floor ${0})', r.floor) : i18nFormat('Floor ${0}', r.floor) })));
                select.value = String(sampleIndex);
                return select;
            })() : null));
        const result = readFor(sampleIndex, planNow());
        if (!result?.before && !replies[sampleIndex]) {
            put(previewBox, h('p', { class: 'ml-filter-tip', text: i18n('This chat has no AI replies yet') }));
            return;
        }
        const { before, after } = result;
        put(previewBox,
            h('p', { class: 'ml-filter-tip', text: result.real ? i18n('Same as how the memory graph reads: line breaks collapse to spaces, then your "plugin only" rules, the reused "prompt only" rules and this tag filter run in turn.') : i18n('The preview uses the original text (Luker\'s regex engine is not connected).') }),
            h('div', { class: 'ml-filter-compare' },
                pane(i18n('Before filtering (with your own "plugin only" regexes applied)'), before, count(before), !count(before)),
                pane(i18n('After filtering (what the memory graph reads)'), after, count(after), !count(after))));
    }
    const pane = (title, text, n, empty = false) => h('div', { class: `ml-filter-pane ${empty ? 'is-empty' : ''}`.trim() },
        h('div', { class: 'ml-filter-pane-head' }, h('span', { text: title }), h('span', { class: 'ml-filter-count', text: i18nFormat('${0} characters', n) })),
        h('pre', { class: 'ml-filter-text', text: empty ? i18n('(everything was removed)') : text }));

    // ----- Assemble --------------------------------------------------------
    function paintAll() {
        blackInput.value = current().black || '';
        whiteInput.value = current().white || '';
        paintPresets();
        paintHints();
        paintAi();
        paintPreview();
    }

    const toggle = h('div', { class: 'ml-filter-toggle' });
    const statusLine = () => {
        let st = null;
        try { st = access.status?.() || null; } catch { st = null; }
        if (!st) return null;
        if (!st.registered) return h('p', { class: 'ml-filter-bad', text: i18n('The tag filter failed to register, the Luker version may be incompatible. Check the console for [memory-graph/lens] errors.') });
        const names = (list) => list.slice(0, 4).join(listSeparator()) + (list.length > 4 ? i18n(' and more') : '');
        return h('div', { class: 'ml-filter-status' },
            h('p', { class: st.active || st.mirrored.length ? '' : 'ml-filter-tip', text: st.active || st.mirrored.length ? i18nFormat('Active: ${0} filter rules apply to what the memory graph reads.', st.active + st.mirrored.length) : i18n('No filter rules are running (not enabled, or the lists are empty). Changes take effect after saving.') }),
            st.mirrored.length ? h('p', { class: 'ml-filter-tip', text: i18nFormat('Reusing ${0} "prompt only" rules: ${1}', st.mirrored.length, names(st.mirrored)) }) : null,
            st.userRules.length ? h('p', { class: 'ml-filter-tip', text: i18nFormat('${0} of your own "plugin only" regex rules also apply here: ${1}', st.userRules.length, names(st.userRules)) }) : null);
    };
    const paintToggle = () => put(clear(toggle),
        switchControl(i18n('Enable tag filter'), state.enabled, (v) => { state.enabled = v; paintToggle(); }),
        checkRow({
            checked: state.mirrorPrompt !== false,
            label: i18n('Reuse "prompt only" regex rules'),
            note: i18n('Regexes in a preset or character that remove thinking only affect the main generation by default, so the memory graph never sees them. When ticked they also run when the memory graph reads (except "hide old floors" rules that blank the whole text).'),
            onChange: (v) => { state.mirrorPrompt = v; paintHints(); paintPreview(); },
        }),
        statusLine());
    paintToggle();

    put(listsBox, listBlock('black'), listBlock('white'));
    put(root,
        h('p', { class: 'ml-filter-intro', text: i18n('Before the memory graph reads an AI reply, it runs these rules first to remove what should not be remembered, such as thinking blocks and status bars. What is shown in the chat is not affected.') }),
        toggle,
        h('p', { class: 'ml-filter-scope', text: i18n('Note: the orchestrator, preset assistant and character editor assistant read chat history through the same lane and get filtered too. Only AI replies are filtered, never your own messages.') }),
        presetBox,
        listsBox,
        aiBox,
        previewBox);
    paintAll();

    confirmModal({
        title: i18n('Tag filter'),
        content: root,
        className: 'is-xwide',
        okLabel: i18n('Save'),
        onOk: () => {
            for (const p of state.presets) {
                p.name = String(p.name || '').trim() || i18n('Unnamed profile');
                p.black = String(p.black || '').trim();
                p.white = String(p.white || '').trim();
            }
            try { access.write(state); showToast(state.enabled ? i18n('Tag filter saved and active') : i18n('Saved (the filter is not enabled)'), { tone: 'ok' }); } catch (err) { showToast(i18nFormat('Tag filter error: ${0}', String(err?.message || err))); }
        },
    });
}
