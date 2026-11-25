// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Overview: prompt budget bar, to-do (suggestions + pending AI changes), and
// core + registered workbench cards.

import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { h, put, clear, formatTokens } from '../../lens-shared/util.js';
import { icon } from '../icons.js';
import { button, link, dot, pillTag, sectionTitle, loading } from '../ui/components.js';
import { budgetNote } from '../model/budget.js';

export function createHomePage(app) {
    const el = h('div', { class: 'wb-page' });
    const openWhy = new Set();
    let lastPaintSignature = null;

    function computePaintSignature(snap) {
        const snapPart = snap ? (() => { const { at: _at, ...rest } = snap; return rest; })() : null;
        const suggPart = (app.suggestions() || []).map(s => ({ id: s.id, sig: s.sig, tone: s.tone, text: s.text, why: s.why, source: s.source }));
        const wsPart = (app.workspaces?.() || []).map(w => ({ id: w.id, title: w.title }));
        return JSON.stringify({ snap: snapPart, sugg: suggPart, ws: wsPart, err: app.loadError() || '' });
    }

    function paint({ force = true } = {}) {
        const snap = app.snapshot();
        const sig = computePaintSignature(snap);
        if (!force && el.childNodes.length > 0 && sig === lastPaintSignature) {
            return;
        }
        lastPaintSignature = sig;
        clear(el);
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
        const domainLabels = {
            memory: i18n('Memory graph'),
            orch: i18n('Orchestration'),
            sd: i18n('Image Generation'),
            preset: i18n('Preset'),
            card: i18n('Character card'),
            world: i18n('World book'),
        };
        const why = h('details', { class: 'wb-why', open: openWhy.has(s.id) || null, onToggle: (e) => { if (e.target.open) openWhy.add(s.id); else openWhy.delete(s.id); } },
            h('summary', null, icon('info', { size: 12 }), h('span', { text: i18n('Why this suggestion') })),
            h('div', { class: 'wb-why-body' }, h('div', { text: s.why }), h('span', { class: 'wb-why-src', text: i18nFormat('Rule check · ${0}. No AI was called', s.source) })));
        const acts = (s.actions || []).map(a => button(a.label, () => runAction(s, a), { className: a.primary ? 'is-primary' : '' }));
        if (s.id !== 'card.pending') acts.push(button(i18n('Ignore'), () => dismiss(s), { className: 'is-ghost' }));
        return h('div', { class: 'wb-tip', style: { '--tone': `var(--wb-t-${s.tone || 'other'})` } },
            dot(s.tone || 'other'),
            h('div', { class: 'wb-tip-main' },
                h('div', { text: s.text }),
                h('div', { class: 'wb-tip-meta', text: `${domainLabels[s.tone] || s.name || s.tone} · ${s.id === 'card.pending' ? i18n('Waiting for you') : i18n('Suggestions')}` }),
                why),
            h('div', { class: 'wb-tip-acts' }, acts));
    }

    function dismiss(s) {
        const next = JSON.parse(JSON.stringify(app.settings()));
        next.dismissed = { ...next.dismissed, [s.id]: s.sig };
        app.saveSettings(next);
        paint();
        app.toast(i18n('Ignored. It will come back if the numbers change'), {
            action: i18n('Undo'),
            onAction: () => {
                const back = JSON.parse(JSON.stringify(app.settings()));
                delete back.dismissed[s.id];
                app.saveSettings(back);
                paint();
            },
        });
    }

    async function runAction(_s, a) {
        if (a.kind === 'session') { app.go('ai', { sessionId: a.sessionId }); return; }
        if (a.kind === 'ai') { app.go('ai', { ws: a.ws, draft: a.prompt }); return; }
        if (a.kind === 'ask') { app.go('ask', { draft: a.question }); return; }
        if (typeof a.run === 'function') {
            try {
                await a.run(app);
            } catch (err) {
                app.toast(i18nFormat('Not changed: ${0}', err?.message || err), { error: true });
            }
            return;
        }
        if (a.kind === 'setHorizon' && typeof app.source?.setMemoryHorizon === 'function') {
            try {
                const result = await app.source.setMemoryHorizon(a.value);
                const historyId = app.history.record({
                    ws: 'memory',
                    title: i18nFormat('Max lookback floors for always-on injection ${0} → ${1}', result.before || i18n('No limit'), a.value),
                    lines: [result.scope === 'character' ? i18n('Changed the settings for this character only') : i18n('Changed the global settings')],
                    from: i18n('Suggestions'),
                    undo: result.undo,
                });
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
        const p = snap.preset;
        const c = snap.card;
        const wb = [...new Set([...(snap.world?.character || []), ...(snap.world?.global || [])])];
        const warn = (id) => app.suggestions().some(s => s.tone === id);
        const status = (id, installed) => !installed ? pillTag(i18n('Not installed'), '') : warn(id) ? pillTag(i18n('Has suggestions'), 'warn') : pillTag(i18n('All good'), 'ok');
        const askBtn = (ws) => button(i18n('Ask AI'), () => app.go('ai', { ws }), { iconName: 'spark' });
        const wsBtn = (ws) => button(i18nFormat('Open the ${0}', ws.title || ws.id), () => app.open({ ws: ws.id }), { iconName: 'lens', className: 'is-ghost' });

        const card = (tone, iconName, name, by, pill, stats, acts) => h('article', { class: 'wb-card', style: { '--tone': `var(--wb-t-${tone})` } },
            h('div', { class: 'wb-card-head' },
                h('span', { class: 'wb-card-icon' }, icon(iconName, { size: 17 })),
                h('div', { class: 'wb-card-title' }, h('div', { class: 'wb-card-name', text: name }), h('div', { class: 'wb-card-by', text: by })),
                pill),
            h('div', { class: 'wb-card-stat' }, stats.filter(Boolean).map(([k, v]) => h('span', null, `${k} `, h('b', { text: v })))),
            h('div', { class: 'wb-card-acts' }, acts));

        const items = [];
        const workspaces = app.workspaces?.() || [];
        const workspaceById = new Map(workspaces.map(w => [w.id, w]));

        for (const provider of app.askProviders?.() || []) {
            const pSnap = snap.providers?.[provider.id];
            if (typeof provider.renderHomeCard === 'function') {
                const desc = provider.renderHomeCard(pSnap, { snap, warn, status, askBtn, wsBtn, workspace: workspaceById.get(provider.id) });
                if (desc) {
                    items.push(card(desc.tone || 'other', desc.iconName || 'mark', desc.name || provider.label || provider.id, desc.by || '', desc.pill || status(desc.tone || provider.id, Boolean(pSnap)), desc.stats || [], desc.acts || []));
                }
            } else if (pSnap) {
                const tone = provider.tone || 'other';
                const ws = workspaceById.get(provider.id);
                items.push(card(tone, provider.icon || 'mark', provider.label || provider.id, pSnap.subtitle || '', status(tone, true), pSnap.stats || [], [ws ? wsBtn(ws) : null]));
            }
        }

        items.push(
            card('preset', 'preset', i18n('Preset'), p?.name || i18n('Chat completion preset'), status('preset', Boolean(p)),
                p ? [[i18n('Enabled entries'), String(p.prompts.filter(x => x.enabled).length)], snap.budget ? [i18n('Prompt usage'), formatTokens(snap.budget.parts.find(x => x.key === 'preset')?.tokens || 0)] : null] : [],
                [p ? askBtn('preset') : null]),
            card('card', 'card', i18n('Character card'), c?.name ? `${c.name}${c.books?.length ? i18nFormat(' · ${0} world books', c.books.length) : ''}` : i18n('No character card selected'), c?.name ? (warn('card') ? pillTag(i18n('To confirm'), 'warn') : pillTag(i18n('All good'), 'ok')) : pillTag(i18n('None selected'), ''),
                c?.name && snap.budget ? [[i18n('Card description'), formatTokens(snap.budget.parts.find(x => x.key === 'card')?.tokens || 0)], [i18n('World book'), formatTokens(snap.budget.parts.find(x => x.key === 'world')?.tokens || 0)]] : [],
                [c?.name ? askBtn('card') : null]),
            card('world', 'world', i18n('World book'), wb.length ? i18nFormat('${0} books · ${1}${2}', wb.length, wb.slice(0, 2).join(listSeparator()), wb.length > 2 ? i18n(' etc.') : '') : i18n('No active world books'), wb.length ? pillTag(i18n('All good'), 'ok') : pillTag(i18n('Not present'), ''),
                snap.budget ? [[i18n('Injected this time'), formatTokens(snap.budget.parts.find(x => x.key === 'world')?.tokens || 0)]] : [],
                [wb.length ? askBtn('world') : null]),
        );

        const heading = items.length === 5 ? i18n('Five workbenches') : i18n('Workbenches');
        return h('section', null, sectionTitle(heading), h('div', { class: 'wb-cards' }, items));
    }

    return {
        el,
        show: () => paint({ force: true }),
        onSnapshot: () => {
            if (!el.isConnected || app.isOpen?.() === false) return;
            paint({ force: false });
        },
        onRegistryUpdate: () => {
            if (!el.isConnected || app.isOpen?.() === false) return;
            paint({ force: true });
        },
    };
}
