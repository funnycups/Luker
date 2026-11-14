// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings: AI connections (connection profile and generation preset chosen
// separately, a default row plus one row per workbench), Ask sources,
// window, and the suggestions rules with their conditions.

import { i18n, i18nFormat } from '../i18n.js';
import { h, put, clear } from '../../lens-shared/util.js';
import { button, link, dot, checkRow, select, sectionTitle, loading } from '../ui/components.js';
import { RULES } from '../model/suggest.js';

const ROWS = [
    { key: 'ask', label: i18n('Q&A'), tone: 'other' },
    { key: 'memory', label: i18n('Memory graph'), tone: 'memory' },
    { key: 'orch', label: i18n('Orchestration'), tone: 'orch' },
    { key: 'preset', label: i18n('Preset'), tone: 'preset' },
    { key: 'card', label: i18n('Character card'), tone: 'card' },
    { key: 'world', label: i18n('World book'), tone: 'world' },
];
const SOURCES = [
    { key: 'inspector', name: i18n('Request inspector'), note: i18n('Full content, duration and status of the last 200 requests') },
    { key: 'frontLogs', name: i18n('Frontend logs'), note: i18n('Browser console output, cleared on reload') },
    { key: 'serverLogs', name: i18n('Server logs'), note: i18n('Only admins can read these in multi-user mode') },
    { key: 'content', name: i18n('Current content'), note: i18n('Chat, character card, world books, preset, connection profile') },
    { key: 'plugins', name: i18n('Installed extensions'), note: i18n('Memory graph, orchestration, token records, suggestions') },
];

export function createSettingsPage(app) {
    const el = h('div', { class: 'wb-page' });
    let choices = null;
    let testing = '';

    async function ensureChoices() {
        if (choices) return;
        try { choices = await app.source.listAiChoices(); } catch { choices = { connections: [], presets: [] }; }
        paint();
    }

    function edit(mutate) {
        const next = structuredClone(app.settings());
        mutate(next);
        app.saveSettings(next);
    }

    function aiTable() {
        const s = app.settings();
        if (!choices) return loading(i18n('Reading connection profiles…'));
        const opts = (list, first) => [{ value: '', label: first }, ...list.map(name => ({ value: name, label: name }))];
        const nativeLabel = (key, field) => {
            const n = choices.native?.[key]?.[field];
            return n ? i18nFormat('Follow extension (${0})', n) : i18n('Follow default');
        };
        const row = (key, label, tone, isDefault = false) => {
            const cur = s.ai?.[key] || {};
            const first = (field) => (isDefault
                ? (field === 'preset' ? (choices.hasPluginOnly ? i18n('plugin-only (recommended by Luker)') : i18n('Use what Luker has selected')) : i18n('Use Luker\'s current one'))
                : nativeLabel(key, field));
            return h('tr', null,
                h('td', null, tone ? dot(tone) : null, isDefault ? h('b', { text: label }) : h('span', { text: label })),
                h('td', null, select(opts(choices.connections, first('connection')), cur.connection || '', (v) => edit(n => { n.ai[key].connection = v; }), { ariaLabel: i18nFormat('${0} connection profile', label), follow: true })),
                h('td', null, select(opts(choices.presets, first('preset')), cur.preset || '', (v) => edit(n => { n.ai[key].preset = v; }), { ariaLabel: i18nFormat('${0} generation preset', label), follow: true })));
        };
        return h('div', { class: 'wb-list' }, h('table', { class: 'wb-api' },
            h('thead', null, h('tr', null, h('th'), h('th', { text: i18n('Connection profile') }), h('th', { text: i18n('Generation preset') }))),
            h('tbody', null, row('default', i18n('Default'), '', true), ROWS.map(r => row(r.key, r.label, r.tone)))));
    }

    async function test() {
        testing = 'running';
        paint();
        try {
            const ms = await app.source.aiTest('ask');
            app.toast(i18nFormat('Connection OK, took ${0}s', (ms / 1000).toFixed(1)));
        } catch (err) {
            app.toast(i18nFormat('Connection failed: ${0}', err?.message || err), { error: true, duration: 6000 });
        }
        testing = '';
        paint();
    }

    function paint() {
        clear(el);
        const s = app.settings();
        put(el,
            h('div', null, h('h2', { class: 'wb-h2', text: i18n('Settings') }), h('p', { class: 'wb-sub', text: i18n('Pick the AI connection once for Ask and all workbenches, or change it for one of them.') })),
            h('section', null,
                sectionTitle(i18n('AI connection'), testing ? h('span', { class: 'wb-note', text: i18n('Testing…') }) : link(i18n('Test default'), () => test())),
                aiTable(),
                h('p', { class: 'wb-note wb-api-note', text: i18n('The connection profile decides which model and address are used; the generation preset decides the prompts wrapped around the request (jailbreak text lives there and is sent as usual). With no default preset picked, Luker\'s bundled plugin-only is used. "Follow extension" uses the iteration AI set in Memory Graph, Orchestrator, Preset Assistant or Character Assistant settings. Both lists come from Luker itself; the workbench only picks from them and never changes them.') }),
                presetHint(),
                h('div', { class: 'wb-checks' },
                    checkRow({ checked: s.reviewChanges, label: i18n('Show me the changes first; do not apply them directly'), onChange: (v) => edit(n => { n.reviewChanges = v; }) }))),
            promptSection(),
            h('section', null,
                sectionTitle(i18n('Q&A')),
                h('div', { class: 'wb-list' },
                    SOURCES.map(src => setRow(src.name, src.note, checkRow({ checked: s.ask.sources[src.key] !== false, label: i18n('Read'), onChange: (v) => edit(n => { n.ask.sources[src.key] = v; }) }))),
                    setRow(i18n('Chat text floors to include'), i18n('When asking about a reply, also send the floors around it to the AI'),
                        select([{ value: '2', label: i18n('2 floors each side') }, { value: '0', label: i18n('That floor only') }, { value: '5', label: i18n('5 floors each side') }], String(s.ask.floors), (v) => edit(n => { n.ask.floors = Number(v); }), { ariaLabel: i18n('Chat text floors') }))),
                h('div', { class: 'wb-checks' },
                    checkRow({ checked: s.ask.previewBeforeSend, label: i18n('Show me before sending to the AI'), onChange: (v) => edit(n => { n.ask.previewBeforeSend = v; }) }),
                    checkRow({ checked: s.ask.redact, label: i18n('Remove API keys and addresses before sending'), onChange: (v) => edit(n => { n.ask.redact = v; }) }))),
            h('section', null,
                sectionTitle(i18n('Window')),
                h('div', { class: 'wb-list' },
                    setRow(i18n('Corner entry'), i18n('Stays in the corner, shows prompt usage and to-do count. Click to open, drag to move'), checkRow({ checked: s.pill !== false, label: i18n('Show'), onChange: (v) => edit(n => { n.pill = v; }) })),
                    setRow(i18n('Shortcut'), i18n('Can also be opened from the wand menu'), select([{ value: 'alt+w', label: 'Alt + W' }, { value: '', label: i18n('No shortcut') }], s.hotkey, (v) => edit(n => { n.hotkey = v; }), { ariaLabel: i18n('Shortcut') })),
                    setRow(i18n('Window and entry position'), i18n('Drag the title bar to move, the bottom-right corner to resize, double-click the title bar to maximize'), button(i18n('Reset position'), () => { try { const p = JSON.parse(localStorage.getItem('workbench.prefs.v1') || '{}'); delete p.box; delete p.pill; delete p.maximised; localStorage.setItem('workbench.prefs.v1', JSON.stringify(p)); } catch { /* ignore */ } app.toast(i18n('Takes effect after reloading the page')); }, { className: 'is-sm' })))),
            rulesSection());
    }

    function rulesSection() {
        const s = app.settings();
        const dismissedCount = Object.keys(s.dismissed || {}).length;
        return h('section', { id: 'wb-rules' },
            sectionTitle(i18n('Suggestions'), dismissedCount ? link(i18nFormat('Restore ${0} ignored', dismissedCount), () => edit(n => { n.dismissed = {}; })) : null),
            h('p', { class: 'wb-sub wb-rules-intro' }, i18n('These are fixed rules that check memory graph, orchestration, preset and character card data locally. '), h('b', { text: i18n('No AI call, no tokens spent') }), i18n('. Checked when the workbench opens and after every reply. The AI is only called when you click "Have the AI look".')),
            h('div', { class: 'wb-list' }, RULES.map(rule => h('div', { class: 'wb-rule' },
                dot(rule.tone),
                h('div', { class: 'wb-rule-main' }, h('div', { text: rule.name }), h('div', { class: 'wb-note', text: rule.when })),
                checkRow({ checked: s.rules[rule.id] ?? rule.defaultOn, ariaLabel: rule.name, onChange: (v) => edit(n => { n.rules[rule.id] = v; }) })))));
    }

    // Luker ships plugin-only.json for plugin / iteration AI calls: a clean
    // envelope that separates the task from RP context. Recommend it here.
    function presetHint() {
        if (!choices) return null;
        if (choices.hasPluginOnly) return null;
        return h('div', { class: 'wb-hint' },
            h('div', null,
                h('b', { text: i18n('Luker\'s bundled "plugin-only" preset is not installed') }),
                h('div', { class: 'wb-note', text: i18n('Luker made this preset for extensions and iteration AI. It separates tool work from roleplay so the AI is not swayed by style. Once imported the workbench uses it by default, and your jailbreak can go in it as usual.') })),
            h('div', { class: 'wb-hint-acts' },
                button(i18n('Import'), async () => {
                    try {
                        await app.source.importBundledPreset('plugin-only');
                        choices = null;
                        app.toast(i18n('plugin-only imported'));
                        ensureChoices();
                    } catch (err) { app.toast(String(err?.message || err), { error: true }); }
                }, { className: 'is-primary is-sm' })));
    }

    let prompts = null;
    async function loadPrompts() {
        const roles = ['ask', 'memory', 'orch', 'preset', 'card', 'world'];
        const out = {};
        for (const r of roles) {
            try { out[r] = await app.source.promptInfo(r); } catch (err) { out[r] = { from: i18n('Unreadable'), custom: false, text: String(err?.message || err) }; }
        }
        prompts = out;
        paint();
    }

    function promptSection() {
        const s = app.settings();
        const rows = ROWS.map(r => {
            const p = prompts?.[r.key];
            return h('details', { class: 'wb-prompt' },
                h('summary', null,
                    dot(r.tone),
                    h('span', { class: 'wb-prompt-name', text: r.label }),
                    h('span', { class: 'wb-note wb-prompt-from', text: p ? `${p.from}${p.custom ? i18n(' (edited by you)') : ''}` : i18n('Reading data…') })),
                p ? h('pre', { class: 'wb-prompt-text', text: p.text || i18n('(empty)') }) : null);
        });
        return h('section', null,
            sectionTitle(i18n('Prompts')),
            h('p', { class: 'wb-sub wb-rules-intro', text: i18n('Ask uses the workbench\'s built-in prompt; the workbenches use Luker\'s own iteration prompts (your edited versions if you changed them in the extension settings). Open one to read it in full.') }),
            h('div', { class: 'wb-list' }, rows),
            h('div', { class: 'wb-checks' },
                checkRow({ checked: s.builtinPrompt, label: i18n('Add workbench instructions in front'), note: i18n('Tells the AI that edits go to a list first, to reply in short Chinese sentences, and that this is editing, not storytelling. Luker\'s own prompts are not affected'), onChange: (v) => edit(n => { n.builtinPrompt = v; }) })));
    }

    function setRow(name, note, control) {
        return h('div', { class: 'wb-setrow' }, h('div', null, h('div', { class: 'wb-setrow-name', text: name }), note ? h('div', { class: 'wb-note', text: note }) : null), control);
    }

    return {
        el,
        show(opts = {}) {
            paint();
            ensureChoices();
            if (!prompts) loadPrompts();
            if (opts.scrollTo === 'rules') requestAnimationFrame(() => el.querySelector('#wb-rules')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        },
    };
}
