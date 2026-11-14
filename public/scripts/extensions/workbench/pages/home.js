// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Overview: prompt budget bar, to-do (suggestions + pending AI changes), and the four
// workbench cards.

import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { h, put, clear, formatTokens, relativeTime, formatDuration } from '../../lens-shared/util.js';
import { icon } from '../icons.js';
import { button, link, dot, pillTag, sectionTitle, loading } from '../ui/components.js';
import { budgetNote } from '../model/budget.js';

export function createHomePage(app) {
    const el = h('div', { class: 'wb-page' });
    const openWhy = new Set();

    function paint() {
        clear(el);
        const snap = app.snapshot();
        const chat = snap?.chat;
        put(el, h('div', null,
            h('h2', { class: 'wb-h2', text: i18n('Overview') }),
            h('p', { class: 'wb-sub', text: chat?.label ? i18nFormat('${0}. What takes up space and what needs attention are all here.', chat.label) : i18n('No chat open. Open one to see prompt usage and suggestions here.') })));
        if (!snap) {
            put(el, app.loadError() ? h('p', { class: 'wb-note', text: i18nFormat('Failed to read: ${0}', app.loadError()) }) : loading());
            return;
        }
        put(el, budgetCard(snap), todoSection(), cardsSection(snap));
    }

    function budgetCard(snap) {
        const b = snap.budget;
        const head = sectionTitle(i18n('How much each part took in the latest prompt'), link(i18n('Recalculate'), () => app.reload(), { iconName: 'refresh' }));
        if (!b) {
            return h('section', { class: 'wb-budget' }, head,
                h('p', { class: 'wb-note', text: i18n('No data yet. After a reply is generated, this shows how many tokens the preset, character card, world books, memory graph and chat history each take (chat completion APIs only).') }));
        }
        const note = budgetNote(b, b.memoryHistory || []);
        return h('section', { class: 'wb-budget' }, head,
            h('div', { class: 'wb-budget-top' },
                h('span', { class: 'wb-budget-total', text: formatTokens(b.total) }),
                b.max ? h('span', { class: 'wb-budget-of', text: i18nFormat('/ context ${0} tokens', formatTokens(b.max)) }) : null,
                note ? h('span', { class: 'wb-budget-warn', text: note }) : null),
            h('div', { class: 'wb-bar', role: 'img', 'aria-label': b.parts.map(p => `${p.label} ${formatTokens(p.tokens)}`).join('，') },
                b.parts.map(p => h('span', { style: { flexGrow: String(p.tokens), background: `var(--wb-t-${p.key})` }, title: `${p.label} ${p.tokens} token` }))),
            h('div', { class: 'wb-legend' }, b.parts.map(p => h('span', null,
                h('i', { style: { background: `var(--wb-t-${p.key})` } }), p.label, h('b', { text: formatTokens(p.tokens) })))));
    }

    function todoSection() {
        const list = app.suggestions();
        const head = sectionTitle(list.length ? i18nFormat('To do · ${0}', list.length) : i18n('To do'), link(i18n('Where suggestions come from'), () => app.go('settings', { scrollTo: 'rules' }), { iconName: 'info' }));
        if (!list.length) return h('section', null, head, h('p', { class: 'wb-note', text: i18n('Nothing to do right now.') }));
        return h('section', null, head, h('div', { class: 'wb-tips' }, list.map(tip)));
    }

    function tip(s) {
        const why = h('details', { class: 'wb-why', open: openWhy.has(s.id) || null, onToggle: (e) => { if (e.target.open) openWhy.add(s.id); else openWhy.delete(s.id); } },
            h('summary', null, icon('info', { size: 12 }), h('span', { text: i18n('Why this suggestion') })),
            h('div', { class: 'wb-why-body' }, h('div', { text: s.why }), h('span', { class: 'wb-why-src', text: i18nFormat('Rule check · ${0}. No AI was called', s.source) })));
        const acts = s.actions.map(a => button(a.label, () => runAction(s, a), { className: a.primary ? 'is-primary' : '' }));
        if (s.id !== 'card.pending') acts.push(button(i18n('Ignore'), () => dismiss(s), { className: 'is-ghost' }));
        return h('div', { class: 'wb-tip', style: { '--tone': `var(--wb-t-${s.tone})` } },
            dot(s.tone),
            h('div', { class: 'wb-tip-main' },
                h('div', { text: s.text }),
                h('div', { class: 'wb-tip-meta', text: `${{ memory: i18n('Memory graph'), orch: i18n('Orchestration'), preset: i18n('Preset'), card: i18n('Character card') }[s.tone]} · ${s.id === 'card.pending' ? i18n('Waiting for you') : i18n('Suggestions')}` }),
                why),
            h('div', { class: 'wb-tip-acts' }, acts));
    }

    function dismiss(s) {
        const next = structuredClone(app.settings());
        next.dismissed = { ...next.dismissed, [s.id]: s.sig };
        app.saveSettings(next);
        paint();
        app.toast(i18n('Ignored. It will come back if the numbers change'), {
            action: i18n('Undo'),
            onAction: () => {
                const back = structuredClone(app.settings());
                delete back.dismissed[s.id];
                app.saveSettings(back);
                paint();
            },
        });
    }

    async function runAction(s, a) {
        if (a.kind === 'session') { app.go('ai', { sessionId: a.sessionId }); return; }
        if (a.kind === 'ai') { app.go('ai', { ws: a.ws, draft: a.prompt }); return; }
        if (a.kind === 'ask') { app.go('ask', { draft: a.question }); return; }
        if (a.kind === 'setHorizon') {
            try {
                const result = await app.source.setMemoryHorizon(a.value);
                const historyId = app.history.record({ ws: 'memory', title: i18nFormat('Max lookback floors for always-on injection ${0} → ${1}', result.before || i18n('No limit'), a.value), lines: [result.scope === 'character' ? i18n('Changed the settings for this character only') : i18n('Changed the global settings')], from: i18n('Suggestions'), undo: result.undo });
                app.toast(i18nFormat('Set to ${0}', a.value), {
                    action: i18n('Undo'),
                    onAction: async () => {
                        try {
                            await app.history.undo(historyId);
                            app.reload();
                        } catch (err) {
                            app.toast(i18nFormat('Could not undo: ${0}', err?.message || err), { error: true });
                        }
                    },
                });
                app.reload();
            } catch (err) {
                app.toast(i18nFormat('Not changed: ${0}', err?.message || err), { error: true });
            }
        }
    }

    function cardsSection(snap) {
        const m = snap.memory;
        const o = snap.orch;
        const p = snap.preset;
        const c = snap.card;
        const wb = [...new Set([...(snap.world?.character || []), ...(snap.world?.global || [])])];
        const warn = (id) => app.suggestions().some(s => s.tone === id);
        const status = (id, installed) => !installed ? pillTag(i18n('Not installed'), '') : warn(id) ? pillTag(i18n('Has suggestions'), 'warn') : pillTag(i18n('All good'), 'ok');
        const askBtn = (ws) => button(i18n('Ask AI'), () => app.go('ai', { ws }), { iconName: 'spark' });
        const lensBtn = (which, label) => (snap.lenses?.[which] ? button(i18nFormat('Open the ${0}', label), () => { app.source.openLens(which); app.collapse(); }, { iconName: 'lens', className: 'is-ghost' }) : null);
        const card = (tone, iconName, name, by, pill, stats, acts) => h('article', { class: 'wb-card', style: { '--tone': `var(--wb-t-${tone})` } },
            h('div', { class: 'wb-card-head' },
                h('span', { class: 'wb-card-icon' }, icon(iconName, { size: 17 })),
                h('div', { class: 'wb-card-title' }, h('div', { class: 'wb-card-name', text: name }), h('div', { class: 'wb-card-by', text: by })),
                pill),
            h('div', { class: 'wb-card-stat' }, stats.filter(Boolean).map(([k, v]) => h('span', null, `${k} `, h('b', { text: v })))),
            h('div', { class: 'wb-card-acts' }, acts));
        const last = o?.last;
        const avg = o?.runs?.length ? o.runs.reduce((s, r) => s + (r.durationMs || 0), 0) / o.runs.length : 0;
        return h('section', null, sectionTitle(i18n('Five workbenches')), h('div', { class: 'wb-cards' },
            card('memory', 'memory', i18n('Memory graph'), m ? `${m.scope === 'character' ? i18n('Settings for this character only') : i18n('Global settings')}` : i18n('Memory graph not found'), status('memory', Boolean(m)),
                m ? [[i18n('Nodes'), String(m.nodes)], [i18n('Always on'), formatTokens(m.core)], m.focus ? [i18n('Recalled this time'), formatTokens(m.focus)] : null] : [],
                [m ? askBtn('memory') : null, lensBtn('memory', i18n('Memory Lens'))]),
            card('orch', 'orch', i18n('Orchestration'), o ? (o.enabled ? i18n('Turned on') : i18n('Turned off')) : i18n('Orchestrator not found'), status('orch', Boolean(o)),
                o ? [[i18n('Last run'), last ? relativeTime(last.at) : i18n('Not yet')], avg ? [i18n('Average'), formatDuration(avg)] : null] : [],
                [o ? askBtn('orch') : null, lensBtn('orch', i18n('Orchestra Lens'))]),
            card('preset', 'preset', i18n('Preset'), p?.name || i18n('Chat completion preset'), status('preset', Boolean(p)),
                p ? [[i18n('Enabled entries'), String(p.prompts.filter(x => x.enabled).length)], snap.budget ? [i18n('Prompt usage'), formatTokens(snap.budget.parts.find(x => x.key === 'preset')?.tokens || 0)] : null] : [],
                [p ? askBtn('preset') : null]),
            card('card', 'card', i18n('Character card'), c?.name ? `${c.name}${c.books?.length ? i18nFormat(' · ${0} world books', c.books.length) : ''}` : i18n('No character card selected'), c?.name ? (warn('card') ? pillTag(i18n('To confirm'), 'warn') : pillTag(i18n('All good'), 'ok')) : pillTag(i18n('None selected'), ''),
                c?.name && snap.budget ? [[i18n('Card description'), formatTokens(snap.budget.parts.find(x => x.key === 'card')?.tokens || 0)], [i18n('World book'), formatTokens(snap.budget.parts.find(x => x.key === 'world')?.tokens || 0)]] : [],
                [c?.name ? askBtn('card') : null]),
            card('world', 'world', i18n('World book'), wb.length ? i18nFormat('${0} books · ${1}${2}', wb.length, wb.slice(0, 2).join(listSeparator()), wb.length > 2 ? i18n(' etc.') : '') : i18n('No active world books'), wb.length ? pillTag(i18n('All good'), 'ok') : pillTag(i18n('Not present'), ''),
                snap.budget ? [[i18n('Injected this time'), formatTokens(snap.budget.parts.find(x => x.key === 'world')?.tokens || 0)]] : [],
                [wb.length ? askBtn('world') : null])));
    }

    return {
        el,
        show: paint,
        onSnapshot: paint,
    };
}
