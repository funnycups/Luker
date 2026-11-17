// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, clear, put } from '../../../../lens-shared/util.js';
import { button, emptyState, sectionTitle } from '../../../../lens-shared/ui.js';
import { serializeRunTrace } from '../../../../run-panel/recorder.js';
import { buildSdDiagnoseDraft } from '../../activity.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat } from '../i18n.js';

export function createRunView(app) {
    const el = h('div', { class: 'sdlens-runs', dataset: { sdView: 'run' } });
    let selectedRunKey = '';
    let unsubscribeRecorder = null;

    function getRecorder() {
        return app.getContext()?.runPanel?.getRunRecorder?.() || null;
    }

    function listSdRuns() {
        const recorder = getRecorder();
        if (!recorder) return [];
        const live = (recorder.currents?.() || []).filter(item => item?.source === 'sd');
        const past = (recorder.history?.() || []).filter(item => item?.source === 'sd');
        const seen = new Set();
        const combined = [];
        for (const item of [...live, ...past]) {
            const key = item.runKey || `sd:${item.runId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            combined.push({ ...item, runKey: key });
        }
        return combined;
    }

    function exportRunJson(run) {
        const text = serializeRunTrace(run);
        if (!text) return;
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = h('a', { href: url, download: `sd-run-${run.runId}.json` });
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function diagnoseRun(run) {
        const ctx = app.getContext();
        const draft = buildSdDiagnoseDraft(run.runKey, ctx);
        void ctx?.workbench?.open?.({ page: 'ai', ws: 'sd', draft });
    }

    function statusBadgeKind(status) {
        if (status === 'committed' || status === 'done' || status === 'succeeded') return 'is-ok';
        if (status === 'error' || status === 'failed') return 'is-bad';
        return 'is-warn';
    }

    function paint() {
        clear(el);
        const runs = listSdRuns();
        if (runs.length === 0) {
            el.style.display = 'flex';
            put(el, emptyState(
                'run',
                i18n('No image generation runs recorded yet'),
                i18n('Trigger an illustration or image generation job to inspect its rounds, prompts, and reference bindings here.'),
                null,
                { renderIcon: icon },
            ));
            return;
        }
        el.style.display = '';

        const activeRun = runs.find(r => r.runKey === selectedRunKey) || runs[0];
        selectedRunKey = activeRun.runKey;

        const listPane = h('aside', { class: 'sdlens-runs-list' },
            runs.map(run => h('button', {
                type: 'button',
                class: `sdlens-char-card ${run.runKey === selectedRunKey ? 'is-active' : ''}`.trim(),
                dataset: { runKey: run.runKey },
                onClick: () => {
                    selectedRunKey = run.runKey;
                    paint();
                },
            },
            h('div', { class: 'sdlens-char-meta' },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' } },
                    h('span', { class: 'sdlens-char-name', text: run.chatLabel || run.runKey }),
                    h('span', { class: `lw-pilltag ${statusBadgeKind(run.status)}`, text: run.status })),
                h('div', {
                    class: 'sdlens-char-sub',
                    text: `${i18nFormat('${0} round(s)', run.rounds?.length || 0)} · ${run.startedAtWall ? new Date(run.startedAtWall).toLocaleTimeString() : run.runId}`,
                })))));

        const exportBtn = button(i18n('Export run JSON'), () => exportRunJson(activeRun), {
            small: true,
            iconName: 'download',
            renderIcon: icon,
        });
        exportBtn.dataset.sdRole = 'export-run';

        const diagBtn = button(i18n('Diagnose with AI'), () => diagnoseRun(activeRun), {
            small: true,
            primary: activeRun.status === 'error' || activeRun.status === 'failed',
            iconName: 'target',
            renderIcon: icon,
        });
        diagBtn.dataset.sdRole = 'diagnose-run';

        const detailPane = h('div', { class: 'sdlens-runs-detail' },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                    h('h3', { style: { margin: '0', fontSize: '15px' }, text: activeRun.runKey }),
                    h('span', { class: `lw-pilltag ${statusBadgeKind(activeRun.status)}`, text: activeRun.status })),
                h('div', { style: { display: 'flex', gap: '8px' } }, exportBtn, diagBtn)),
            activeRun.error
                ? h('pre', { class: 'sdlens-pre', text: String(activeRun.error) })
                : null,
            ...(activeRun.rounds || []).map(round => h('div', { class: 'sdlens-round-card', dataset: { roundId: round.id } },
                sectionTitle(round.label || round.id, h('span', { class: `lw-pilltag ${statusBadgeKind(round.status)}`, text: round.status })),
                ...(round.sections || []).map(sec => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                    h('div', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--lw-muted)' }, text: `${sec.title || sec.kind} (${sec.status})` }),
                    sec.body ? h('pre', { class: 'sdlens-pre', text: String(sec.body) }) : null,
                    sec.meta?.imageUrl
                        ? h('img', {
                            src: sec.meta.imageUrl,
                            alt: sec.title || 'Generated image',
                            style: { maxWidth: '280px', borderRadius: 'var(--lw-r-sm)', border: '1px solid var(--lw-border)' },
                        })
                        : null)))));

        put(el, listPane, detailPane);
    }

    function bindRecorder() {
        unsubscribeRecorder?.();
        unsubscribeRecorder = getRecorder()?.subscribe?.(() => {
            if (el.isConnected) paint();
        }) || null;
    }

    return {
        el,
        show(opts = {}) {
            if (opts?.runKey) {
                selectedRunKey = String(opts.runKey);
            }
            bindRecorder();
            paint();
        },
        destroy() {
            unsubscribeRecorder?.();
            unsubscribeRecorder = null;
        },
    };
}
