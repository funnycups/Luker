// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings: AI connections (connection profile and generation preset chosen
// separately, a shared block plus per-target overrides with resolved sources),
// Ask sources, window, and suggestions rules (core + SuggestRuleProviders).

import { i18n, i18nFormat } from '../i18n.js';
import { h, put, clear, prefersReducedMotion, scrollChildIntoView } from '../../lens-shared/util.js';
import { createBehaviorSummary } from '../../lens-shared/behavior-summary.js';
import { button, link, dot, checkRow, select, sectionTitle, loading } from '../ui/components.js';
import { listRules } from '../model/suggest.js';
import { resolveAiRow } from '../model/ai-source.js';
import { buildWorkbenchAiSummary, buildWorkbenchQaSummary } from '../model/behavior-summary-models.js';
import { importPresetExample, openPresetDerivation, PRESET_EXAMPLES } from '../../lens-shared/preset-examples.js';
import { getRunDockPrefs, setRunDockPrefs, resetRunDockPosition, subscribeRunDockPrefs } from '../../run-panel/index.js';

function fieldKey(key, node) {
    if (node instanceof Element) node.dataset.fieldKey = key;
    return node;
}

export function knownRoles() {
    return [
        { key: 'ask', label: i18n('Q&A'), tone: 'other' },
        { key: 'memory', label: i18n('Memory graph config'), tone: 'memory' },
        { key: 'memory_graph', label: i18n('Memory graph content'), tone: 'memory' },
        { key: 'orch', label: i18n('Orchestration'), tone: 'orch' },
        { key: 'preset', label: i18n('Preset'), tone: 'preset' },
        { key: 'card', label: i18n('Character card'), tone: 'card' },
        { key: 'world', label: i18n('World book'), tone: 'world' },
        { key: 'sd', label: i18n('Image Generation'), tone: 'sd' },
    ];
}

const AI_ROLE_LABELS = {
    ask: 'Q&A',
    memory: 'Edit memory graph config',
    memory_graph: 'Edit memory graph content',
    orch: 'Edit orchestration settings',
    preset: 'Edit preset',
    card: 'Edit character card',
    world: 'Edit world book',
    sd: 'Generate images',
};

const PLUGIN_LABELS = {
    memory: 'Memory graph settings',
    memory_graph: 'Memory graph settings',
    orch: 'Orchestration settings',
    preset: 'Preset Assistant settings',
    card: 'Character Assistant settings',
    world: 'Character Assistant settings',
    sd: 'Image Generation settings',
};

export function sourceDefs() {
    return [
        { key: 'inspector', name: i18n('Request inspector'), note: i18n('Full content, duration and status of the last 200 requests') },
        { key: 'frontLogs', name: i18n('Frontend logs'), note: i18n('Browser console output, cleared on reload') },
        { key: 'serverLogs', name: i18n('Server logs'), note: i18n('Only admins can read these in multi-user mode') },
        { key: 'content', name: i18n('Current content'), note: i18n('Chat, character card, world books, preset, variables (including optional global), regex, connection profile, skills') },
        { key: 'plugins', name: i18n('Installed extensions'), note: i18n('Memory graph, orchestration, image generation, environment & extensions, suggestions') },
    ];
}

export function createSettingsPage(app) {
    const el = h('div', { class: 'wb-page' });
    let choices = null;
    let choicesVersion = 0;
    let testing = '';
    let prompts = null;
    let promptsVersion = 0;
    let targetsOpen = false;
    let liveSettings = null;
    const currentSettings = () => liveSettings ?? app.settings() ?? {};
    const unsubDockPrefs = subscribeRunDockPrefs(() => {
        if (el.isConnected) paint();
    });

    function activeRows() {
        const targets = app.iterateTargets?.() || [];
        if (!targets.length) return knownRoles();
        const rows = [{ key: 'ask', label: i18n('Q&A'), tone: 'other' }];
        const seen = new Set(['ask']);
        for (const t of targets) {
            if (!t?.id || seen.has(t.id)) continue;
            seen.add(t.id);
            rows.push({ key: t.id, label: t.label || t.id, tone: t.tone || t.id });
        }
        return rows;
    }

    const aiSummary = createBehaviorSummary({
        id: 'wb-ai-settings',
        ariaLabel: i18n('AI & editing behavior summary'),
        onTokenActivate: (fields) => {
            if (fields.includes('targetOverrides')) {
                const details = el.querySelector('.wb-ai-targets');
                if (details) {
                    details.open = true;
                    targetsOpen = true;
                }
            }
            return false;
        },
        build: () => {
            const s = currentSettings();
            const shared = s.ai?.default || {};
            const rows = activeRows();
            let targetOverrideCount = 0;
            for (const row of rows) {
                const own = s.ai?.[row.key];
                if (String(own?.connection || '').trim() || String(own?.preset || '').trim()) {
                    targetOverrideCount += 1;
                }
            }
            const sharedPreset = String(shared.preset || '').trim()
                || (choices?.hasPluginOnly ? PRESET_EXAMPLES.pluginOnly : '');
            return buildWorkbenchAiSummary({
                sharedConnection: shared.connection || '',
                sharedPreset,
                reviewChanges: s.reviewChanges !== false,
                targetOverrideCount,
            });
        },
    });

    const qaSummary = createBehaviorSummary({
        id: 'wb-qa-settings',
        ariaLabel: i18n('Q&A context & privacy summary'),
        build: () => {
            const s = currentSettings();
            const askCfg = s.ask || {};
            const askSources = askCfg.sources || {};
            const defs = sourceDefs();
            return buildWorkbenchQaSummary({
                enabledSources: defs.filter(src => askSources[src.key] !== false).map(src => src.name),
                allSources: defs.map(src => src.name),
                floors: askCfg.floors ?? 2,
                previewBeforeSend: Boolean(askCfg.previewBeforeSend),
                redact: askCfg.redact !== false,
            });
        },
    });

    async function ensureChoices() {
        if (choices) return;
        const ver = ++choicesVersion;
        try {
            const loaded = await app.source.listAiChoices();
            if (ver !== choicesVersion) return;
            choices = loaded;
            const errs = Object.values(choices?.errors || {}).filter(Boolean);
            if (errs.length) {
                app.toast(errs.join(' · '), { error: true, duration: 5000 });
            }
        } catch (err) {
            if (ver !== choicesVersion) return;
            const msg = String(err?.message || err);
            choices = { connections: [], presets: [], native: {}, hasPluginOnly: false, errors: { load: msg } };
            app.toast(msg, { error: true, duration: 5000 });
        }
        paint();
    }

    function edit(mutate, summary = null) {
        const next = JSON.parse(JSON.stringify(currentSettings()));
        mutate(next);
        liveSettings = next;
        app.saveSettings(next);
        summary?.update();
    }

    async function importSharedExample() {
        try {
            const ok = await importPresetExample(PRESET_EXAMPLES.pluginOnly);
            if (!ok) return;
            edit(n => {
                n.ai = n.ai || {};
                n.ai.default = n.ai.default || {};
                n.ai.default.preset = PRESET_EXAMPLES.pluginOnly;
            }, aiSummary);
            choices = null;
            await ensureChoices();
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        }
    }

    async function derivePreset(mode) {
        try {
            await openPresetDerivation(mode);
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        }
    }

    function aiLabel(row) {
        return i18n(AI_ROLE_LABELS[row.key] || row.label || row.key);
    }

    function firstOption(key, field, isShared) {
        if (isShared) {
            if (field === 'connection') return i18n('Not selected, using Luker\'s current connection');
            return choices.hasPluginOnly
                ? i18n('Not selected, using the bundled example plugin-only')
                : i18n('Not selected, using Luker\'s current preset');
        }
        return choices.native?.[key]
            ? i18n('Follow plugin setting')
            : i18n('Follow shared settings');
    }

    function sourceDetail(source, field, key) {
        if (!source) return i18n('Not set');
        if (source.scope === 'current') {
            return field === 'connection'
                ? i18n('Luker\'s current connection')
                : i18n('Luker\'s current preset');
        }
        if (source.scope === 'target') return i18nFormat('Set for this target · ${0}', source.value);
        const scope = source.scope === 'plugin'
            ? i18n(PLUGIN_LABELS[key] || 'Plugin settings')
            : i18n('Shared settings');
        if (source.implicit) {
            return i18nFormat('${0} · not selected, using the bundled example ${1}', scope, source.value);
        }
        return i18nFormat('${0} · ${1}', scope, source.value);
    }

    function sourceLines(sources, key) {
        const line = (field, label) => h('div', { class: 'wb-api-source-line' },
            h('span', { class: 'wb-api-source-key', text: label }),
            h('span', { text: sourceDetail(sources[field], field, key) }));
        return [line('connection', i18n('Connection')), line('preset', i18n('Preset slot'))];
    }

    function aiSelect(key, field, isShared, ariaLabel) {
        const cur = currentSettings().ai?.[key] || {};
        const list = field === 'connection' ? (choices.connections || []) : (choices.presets || []);
        return select(
            [{ value: '', label: firstOption(key, field, isShared) }, ...list.map(name => ({ value: name, label: name }))],
            cur[field] || '',
            (v) => edit(n => {
                n.ai = n.ai || {};
                n.ai[key] = n.ai[key] || {};
                n.ai[key][field] = v;
            }, aiSummary),
            { ariaLabel, follow: true },
        );
    }

    function aiActions() {
        const installed = choices.presets?.includes(PRESET_EXAMPLES.pluginOnly);
        return h('div', { class: 'wb-ai-actions' },
            link(installed ? i18n('Re-import example') : i18n('Import example'), importSharedExample),
            h('span', { class: 'wb-ai-actions-sep', text: '·' }),
            link(i18n('Derive from an existing preset'), () => derivePreset('jailbreak-only')));
    }

    function sharedBlock() {
        return h('div', { class: 'wb-ai-shared' },
            h('div', { class: 'wb-ai-block-title', text: i18n('Shared') }),
            h('div', { class: 'wb-ai-shared-grid' },
                fieldKey('sharedConnection', h('label', { class: 'wb-ai-field' },
                    h('span', { class: 'wb-ai-field-label', text: i18n('Connection profile') }),
                    aiSelect('default', 'connection', true, i18n('Shared connection profile')))),
                fieldKey('sharedPreset', h('label', { class: 'wb-ai-field' },
                    h('span', { class: 'wb-ai-field-label', text: i18n('Generation preset') }),
                    aiSelect('default', 'preset', true, i18n('Shared generation preset'))))),
            aiActions());
    }

    function aiRow(row) {
        const s = currentSettings();
        const own = s.ai?.[row.key] || {};
        const shared = s.ai?.default || {};
        const native = choices.native?.[row.key] || {};
        const sources = resolveAiRow({
            own,
            native,
            shared,
            fallbackConnection: { scope: 'current' },
            fallbackPreset: choices.hasPluginOnly
                ? { scope: 'shared', value: PRESET_EXAMPLES.pluginOnly, implicit: true }
                : { scope: 'current' },
        });
        const label = aiLabel(row);
        return h('tr', null,
            h('td', null,
                dot(row.tone),
                h('span', { text: label }),
                h('div', { class: 'wb-api-source-inline' }, sourceLines(sources, row.key))),
            h('td', null, aiSelect(row.key, 'connection', false, i18nFormat('${0} connection profile', label))),
            h('td', null, aiSelect(row.key, 'preset', false, i18nFormat('${0} generation preset', label))),
            h('td', { class: 'wb-api-source' }, sourceLines(sources, row.key)));
    }

    function targetsBlock() {
        const rows = activeRows();
        if (!rows.length) return null;
        return fieldKey('targetOverrides', h('details', {
            class: 'wb-ai-targets',
            open: targetsOpen || null,
            onToggle: (event) => { targetsOpen = event.target.open; },
        },
        h('summary', { class: 'wb-ai-targets-summary' },
            h('span', { text: rows.length === 1 ? i18n('Set individually (1 target)') : i18nFormat('Set individually (${0} targets)', rows.length) })),
        h('table', { class: 'wb-api wb-api-targets' },
            h('thead', null, h('tr', null,
                h('th', { text: i18n('Used for') }),
                h('th', { text: i18n('Connection profile') }),
                h('th', { text: i18n('Generation preset') }),
                h('th', { text: i18n('Current source') }))),
            h('tbody', null, rows.map(aiRow)))));
    }

    function aiSection() {
        const errs = Object.values(choices?.errors || {}).filter(Boolean);
        return h('section', null,
            sectionTitle(i18n('AI used inside Workbench'), testing ? h('span', { class: 'wb-note', text: i18n('Testing…') }) : link(i18n('Test default'), () => test())),
            aiSummary.el,
            errs.length ? h('p', { class: 'wb-msg-error', text: errs.join(' · ') }) : null,
            !choices
                ? loading(i18n('Reading connection profiles…'))
                : h('div', null, sharedBlock(), targetsBlock()),
            h('div', { class: 'wb-checks' },
                fieldKey('reviewChanges', checkRow({ checked: currentSettings().reviewChanges !== false, label: i18n('Show me the changes first — do not apply them directly'), onChange: (v) => edit(n => { n.reviewChanges = v; }, aiSummary) }))));
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

    function qaSection() {
        const s = currentSettings();
        const askCfg = s.ask || {};
        const askSources = askCfg.sources || {};
        return h('section', null,
            sectionTitle(i18n('Q&A')),
            qaSummary.el,
            h('div', { class: 'wb-list' },
                sourceDefs().map(src => fieldKey('qaSources', setRow(src.name, src.note, checkRow({ checked: askSources[src.key] !== false, label: i18n('Read'), onChange: (v) => edit(n => { n.ask = n.ask || {}; n.ask.sources = n.ask.sources || {}; n.ask.sources[src.key] = v; }, qaSummary) })))),
                fieldKey('qaFloors', setRow(i18n('Chat text floors to include'), i18n('When asking about a reply, also send the floors around it to the AI'),
                    select([
                        { value: '2', label: i18n('2 floors each side') },
                        { value: '0', label: i18n('That floor only') },
                        { value: '5', label: i18n('5 floors each side') },
                        { value: 'all', label: i18n('No limit') },
                    ], String(askCfg.floors ?? 2), (v) => edit(n => { n.ask = n.ask || {}; n.ask.floors = v === 'all' ? 'all' : Number(v); }, qaSummary), { ariaLabel: i18n('Chat text floors') })))),
            h('div', { class: 'wb-checks' },
                fieldKey('qaPreviewBeforeSend', checkRow({ checked: Boolean(askCfg.previewBeforeSend), label: i18n('Show me before sending to the AI'), onChange: (v) => edit(n => { n.ask = n.ask || {}; n.ask.previewBeforeSend = v; }, qaSummary) })),
                fieldKey('qaRedact', checkRow({ checked: askCfg.redact !== false, label: i18n('Remove API keys and addresses before sending'), onChange: (v) => edit(n => { n.ask = n.ask || {}; n.ask.redact = v; }, qaSummary) }))));
    }

    function paint() {
        clear(el);
        liveSettings = JSON.parse(JSON.stringify(app.settings() || {}));
        const s = currentSettings();
        const aiSec = aiSection();
        const qaSec = qaSection();
        put(el,
            h('div', null, h('h2', { class: 'wb-h2', text: i18n('Settings') })),
            aiSec,
            promptSection(),
            qaSec,
            h('section', null,
                sectionTitle(i18n('Window')),
                h('div', { class: 'wb-list' },
                    setRow(i18n('Corner entry'), i18n('Stays in the corner, shows prompt usage and to-do count. Click to open, drag to move'), checkRow({ checked: s.pill !== false, label: i18n('Show'), onChange: (v) => edit(n => { n.pill = v; }) })),
                    setRow(i18n('Workbench default size'), null, select([{ value: 'small', label: i18n('Small window') }, { value: 'large', label: i18n('Large window') }], s.defaultSize === 'large' ? 'large' : 'small', (v) => { const next = v === 'large' ? 'large' : 'small'; edit(n => { n.defaultSize = next; }); app.setWindowSize?.(next); paint(); }, { ariaLabel: i18n('Workbench default size') })),
                    setRow(i18n('Run panel'), null, checkRow({ checked: getRunDockPrefs().autoOpen !== false, label: i18n('Open automatically on run'), onChange: (v) => { setRunDockPrefs({ autoOpen: Boolean(v) }); paint(); } })),
                    setRow(i18n('Run panel default size'), null, select([{ value: 'small', label: i18n('Small window') }, { value: 'large', label: i18n('Large window') }], getRunDockPrefs().defaultSize === 'large' ? 'large' : 'small', (v) => { setRunDockPrefs({ defaultSize: v === 'large' ? 'large' : 'small' }); paint(); }, { ariaLabel: i18n('Run panel default size') })),
                    setRow(i18n('Shortcut'), i18n('Can also be opened from the wand menu'), select([{ value: 'alt+w', label: 'Alt + W' }, { value: '', label: i18n('No shortcut') }], s.hotkey ?? 'alt+w', (v) => edit(n => { n.hotkey = v; }), { ariaLabel: i18n('Shortcut') })),
                    setRow(i18n('Window and entry position'), i18n('Drag the title bar to move, the bottom-right corner to resize, double-click the title bar to maximize'), button(i18n('Reset position'), () => { app.resetWindowPosition?.(); resetRunDockPosition(); app.toast(i18n('Window position restored')); }, { className: 'is-sm' })))),
            rulesSection());
        aiSummary.bindScope(aiSec);
        aiSummary.update();
        qaSummary.bindScope(qaSec);
        qaSummary.update();
    }

    function rulesSection() {
        const s = app.settings();
        const dismissedCount = Object.keys(s.dismissed || {}).length;
        const rules = listRules(app.suggestRuleProviders?.() || []);
        return h('section', { id: 'wb-rules' },
            sectionTitle(i18n('Suggestions'), dismissedCount ? link(i18nFormat('Restore ${0} ignored', dismissedCount), () => edit(n => { n.dismissed = {}; })) : null),
            h('p', { class: 'wb-sub wb-rules-intro' }, i18n('These are fixed rules that check memory graph, orchestration, preset and character card data locally. '), h('b', { text: i18n('No AI call, no tokens spent') }), i18n('. Checked when the workbench opens and after every reply. The AI is only called when you click "Have the AI look".')),
            h('div', { class: 'wb-list' }, rules.map(rule => h('div', { class: 'wb-rule' },
                dot(rule.tone),
                h('div', { class: 'wb-rule-main' }, h('div', { text: rule.name }), h('div', { class: 'wb-note', text: rule.when })),
                checkRow({ checked: s.rules?.[rule.id] ?? rule.defaultOn, ariaLabel: rule.name, onChange: (v) => edit(n => { n.rules = n.rules || {}; n.rules[rule.id] = v; }) })))));
    }

    async function loadPrompts() {
        const ver = ++promptsVersion;
        const rows = activeRows();
        const out = {};
        for (const r of rows) {
            try {
                const info = await app.source.promptInfo(r.key);
                if (ver !== promptsVersion) return;
                out[r.key] = info;
            } catch (err) {
                if (ver !== promptsVersion) return;
                out[r.key] = { from: i18n('Unreadable'), custom: false, text: String(err?.message || err) };
            }
        }
        if (ver !== promptsVersion) return;
        prompts = out;
        paint();
    }

    function promptSection() {
        const s = app.settings();
        const rows = activeRows().map(r => {
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
            h('p', { class: 'wb-sub wb-rules-intro', text: i18n('Ask uses the workbench\'s built-in prompt, while the workbenches use Luker\'s own iteration prompts (your edited versions if you changed them in the extension settings). Open one to read it in full.') }),
            h('div', { class: 'wb-list' }, rows),
            h('div', { class: 'wb-checks' },
                checkRow({ checked: s.builtinPrompt !== false, label: i18n('Add workbench instructions in front'), note: i18n('Tells the AI that edits go to a list first, to reply in short Chinese sentences, and that this is editing, not storytelling. Luker\'s own prompts are not affected'), onChange: (v) => edit(n => { n.builtinPrompt = v; }) })));
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
            if (opts.scrollTo === 'rules') {
                requestAnimationFrame(() => {
                    scrollChildIntoView(el.closest('.wb-main'), el.querySelector('#wb-rules'), {
                        block: 'start',
                        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                    });
                });
            }
        },
        onRegistryUpdate() {
            promptsVersion++;
            choicesVersion++;
            prompts = null;
            choices = null;
            if (el.isConnected) {
                ensureChoices();
                loadPrompts();
                paint();
            }
        },
        destroy() {
            unsubDockPrefs?.();
            aiSummary.destroy();
            qaSummary.destroy();
        },
    };
}
