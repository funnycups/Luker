// public/scripts/run-panel/render-incremental.js
/**
 * Translates run-store events into incremental DOM updates inside a
 * run-panel root. No framework; just direct DOM ops.
 *
 * SECTION_APPENDED is the high-frequency event. We coalesce within a
 * single rAF so a fast token stream produces at most ~60 DOM writes/s.
 *
 * Consumer-specific values are injected via constructor options:
 * `store`, `t`, `kindIcons`, `defaultCollapsedKinds`, `modeLabels`,
 * `exportFilename`, `onStop`.
 */

import * as EV from './events.js';

export const DEFAULT_KIND_ICONS = Object.freeze({
    reasoning: '💭',
    text: '📝',
    tool_call: '🔧',
    tool_result: '✅',
    sub_agent: '🤖',
    note: '💡',
    messages_dump: '📦',
});

export class PanelRenderer {
    constructor(rootEl, options = {}) {
        this.root = rootEl;
        this.store = options.store;
        if (!this.store || typeof this.store.getCurrentRun !== 'function') {
            throw new Error('PanelRenderer requires a store option');
        }
        this.t = typeof options.t === 'function' ? options.t : (s) => String(s ?? '');
        this.kindIcons = options.kindIcons || DEFAULT_KIND_ICONS;
        this.defaultCollapsedKinds = new Set(options.defaultCollapsedKinds || []);
        this.modeLabels = options.modeLabels || {};
        this.exportFilename = typeof options.exportFilename === 'function'
            ? options.exportFilename
            : ({ runId, mode }) => `run-${runId}-${mode}.json`;
        this.onStop = typeof options.onStop === 'function' ? options.onStop : null;

        this.bodyEl = rootEl.querySelector('.panel-body');
        this.roundsListEl = rootEl.querySelector('.rounds-list');
        this.finalOutputEl = rootEl.querySelector('.final-output');
        this.headerStatusEl = rootEl.querySelector('.status-dot');
        this.summaryEl = rootEl.querySelector('.panel-summary');
        this.elapsedEl = rootEl.querySelector('.elapsed');
        this.modeBadgeEl = rootEl.querySelector('.mode-badge');
        this.stopBtnEl = rootEl.querySelector('[data-action="stop"]');

        this._pendingAppends = new Map();
        this._rafScheduled = false;
        this._scrollPinned = true;
        this._manualToggles = new Set();
        this._elapsedTimer = null;
        this._roundTimers = new Map();

        this._bindScrollPin();
    }

    _run() {
        return this.store.getCurrentRun();
    }

    _formatElapsed(ms) {
        if (!Number.isFinite(ms) || ms < 0) ms = 0;
        const totalSec = ms / 1000;
        if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
        const m = Math.floor(totalSec / 60);
        const s = Math.floor(totalSec - m * 60);
        return `${m}m ${String(s).padStart(2, '0')}s`;
    }

    _stopRoundTimer(roundId) {
        const t = this._roundTimers.get(roundId);
        if (t != null) {
            clearInterval(t);
            this._roundTimers.delete(roundId);
        }
    }

    _sweepRoundTimers() {
        for (const t of this._roundTimers.values()) clearInterval(t);
        this._roundTimers.clear();
    }

    _setDetailsOpen(detailsEl, open) {
        if (!detailsEl) return;
        if (detailsEl.open === Boolean(open)) return;
        detailsEl.open = Boolean(open);
    }

    _bindScrollPin() {
        this.bodyEl.addEventListener('scroll', () => {
            const distFromBottom = this.bodyEl.scrollHeight - this.bodyEl.scrollTop - this.bodyEl.clientHeight;
            this._scrollPinned = distFromBottom < 40;
            this._updateJumpBtn();
        });
    }

    _updateJumpBtn() {
        let btn = this.root.querySelector('.jump-latest');
        if (this._scrollPinned) {
            if (btn) btn.remove();
            return;
        }
        if (!btn) {
            btn = document.createElement('button');
            btn.className = 'jump-latest';
            btn.textContent = this.t('Jump to latest');
            btn.addEventListener('click', () => {
                this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
                this._scrollPinned = true;
                this._updateJumpBtn();
            });
            this.root.appendChild(btn);
        }
    }

    _maybeScroll() {
        if (this._scrollPinned) {
            this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
        }
    }

    handle(event) {
        switch (event.type) {
            case EV.RUN_STARTED: return this._renderRunStart();
            case EV.ROUND_APPENDED: return this._renderRoundAppended(event.roundId);
            case EV.SECTION_ENSURED: return this._renderSectionEnsured(event.roundId, event.sectionId);
            case EV.SECTION_APPENDED: return this._scheduleAppend(event.roundId, event.sectionId, event.delta);
            case EV.SECTION_STATUS: return this._renderSectionStatus(event.roundId, event.sectionId, event.status);
            case EV.ROUND_STATUS: return this._renderRoundStatus(event.roundId, event.status);
            case EV.RUN_META: return this._renderHeader();
            case EV.RUN_FINISHED: return this._renderRunFinished(event.status);
            case EV.RUN_CLEARED: return this._renderCleared();
        }
    }

    _renderRunStart() {
        const run = this._run();
        if (!run) return;
        this.root.dataset.state = 'open';
        this.roundsListEl.innerHTML = '';
        this._manualToggles.clear();
        this._sweepRoundTimers();
        const empty = this.bodyEl.querySelector(':scope > .empty-state');
        if (empty) empty.remove();
        if (this.finalOutputEl) this.finalOutputEl.hidden = true;
        this.modeBadgeEl.textContent = this.modeLabels[run.mode] || run.mode;
        this.modeBadgeEl.dataset.mode = run.mode;
        this.headerStatusEl.dataset.status = run.status;
        this.stopBtnEl.hidden = false;
        this.stopBtnEl.disabled = false;
        this._startElapsedTimer();
        this._renderHeader();
    }

    _startElapsedTimer() {
        if (this._elapsedTimer) clearInterval(this._elapsedTimer);
        const run = this._run();
        if (!run) return;
        const tick = () => {
            const r = this._run();
            if (!r) return;
            const end = r.endedAt ?? performance.now();
            const sec = ((end - r.startedAt) / 1000).toFixed(1);
            this.elapsedEl.textContent = `${sec}s`;
        };
        tick();
        this._elapsedTimer = setInterval(tick, 200);
    }

    _renderHeader() {
        const run = this._run();
        if (!run) return;
        const numRounds = run.rounds.length;
        const numToolCalls = run.rounds.reduce(
            (n, r) => n + r.sections.filter(s => s.kind === 'tool_call').length, 0,
        );
        const tokens = run.tokensSpent?.total ?? '—';
        const tokensFmt = typeof tokens === 'number'
            ? (tokens > 999 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens))
            : tokens;
        this.summaryEl.textContent = this.t('${0} rounds · ${1} tool calls · ${2} tokens',
            numRounds, numToolCalls, tokensFmt);
    }

    _renderRoundAppended(roundId) {
        const run = this._run();
        if (!run) return;
        const round = run.rounds.find(r => r.id === roundId);
        if (!round) return;

        const li = document.createElement('li');
        li.className = 'round';
        li.dataset.roundId = roundId;
        li.dataset.status = round.status;

        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        const dot = document.createElement('span');
        dot.className = 'round-dot';
        dot.textContent = '●';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'round-label';
        labelSpan.textContent = ` ${round.label} · `;
        const statusSpan = document.createElement('span');
        statusSpan.className = 'round-status';
        statusSpan.textContent = round.status;
        const elapsedSpan = document.createElement('span');
        elapsedSpan.className = 'round-elapsed';
        elapsedSpan.textContent = this._formatElapsed(0);
        summary.appendChild(dot);
        summary.appendChild(labelSpan);
        summary.appendChild(statusSpan);
        summary.appendChild(elapsedSpan);
        details.appendChild(summary);

        const ol = document.createElement('ol');
        ol.className = 'sections-list';
        details.appendChild(ol);

        summary.addEventListener('click', () => {
            this._manualToggles.add(`round:${roundId}`);
        });

        li.appendChild(details);
        this.roundsListEl.appendChild(li);

        if (round.endedAt != null) {
            elapsedSpan.textContent = this._formatElapsed(round.endedAt - round.startedAt);
        } else {
            this._stopRoundTimer(roundId);
            const tick = () => {
                const r = this._run();
                const rd = r?.rounds.find(x => x.id === roundId);
                if (!rd) { this._stopRoundTimer(roundId); return; }
                const end = rd.endedAt ?? performance.now();
                elapsedSpan.textContent = this._formatElapsed(end - rd.startedAt);
                if (rd.endedAt != null) this._stopRoundTimer(roundId);
            };
            tick();
            this._roundTimers.set(roundId, setInterval(tick, 200));
        }

        this._renderHeader();
        this._maybeScroll();
    }

    _renderSectionEnsured(roundId, sectionId) {
        const li = this.roundsListEl.querySelector(`[data-round-id="${CSS.escape(roundId)}"]`);
        if (!li) return;
        const ol = li.querySelector('.sections-list');
        if (!ol) return;
        if (ol.querySelector(`[data-section-id="${CSS.escape(sectionId)}"]`)) return;

        const run = this._run();
        const round = run?.rounds.find(r => r.id === roundId);
        const section = round?.sections.find(s => s.id === sectionId);
        if (!section) return;

        const sli = document.createElement('li');
        sli.className = 'section';
        sli.dataset.sectionId = sectionId;
        sli.dataset.kind = section.kind;
        sli.dataset.status = section.status;

        const details = document.createElement('details');
        details.open = !this.defaultCollapsedKinds.has(section.kind);

        const summary = document.createElement('summary');
        const icon = this.kindIcons[section.kind] || '•';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = `${icon} ${section.title}`;
        summary.appendChild(titleSpan);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.title = this.t('Copy');
        copyBtn.textContent = '⧉';
        copyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._copySection(roundId, sectionId, copyBtn);
        });
        summary.appendChild(copyBtn);
        details.appendChild(summary);

        const pre = document.createElement('pre');
        pre.textContent = section.body;
        details.appendChild(pre);

        summary.addEventListener('click', () => {
            this._manualToggles.add(`section:${roundId}:${sectionId}`);
        });

        sli.appendChild(details);
        ol.appendChild(sli);
        this._maybeScroll();
    }

    _scheduleAppend(roundId, sectionId, delta) {
        const key = `${roundId}::${sectionId}`;
        const prev = this._pendingAppends.get(key) || '';
        this._pendingAppends.set(key, prev + delta);
        if (this._rafScheduled) return;
        this._rafScheduled = true;
        requestAnimationFrame(() => {
            this._rafScheduled = false;
            this._flushAppends();
        });
    }

    _flushAppends() {
        for (const [key, delta] of this._pendingAppends.entries()) {
            const sepIdx = key.indexOf('::');
            const roundId = key.slice(0, sepIdx);
            const sectionId = key.slice(sepIdx + 2);
            const sel = `[data-round-id="${CSS.escape(roundId)}"] [data-section-id="${CSS.escape(sectionId)}"] pre`;
            const pre = this.roundsListEl.querySelector(sel);
            if (pre) pre.appendChild(document.createTextNode(delta));
        }
        this._pendingAppends.clear();
        this._maybeScroll();
    }

    _renderSectionStatus(roundId, sectionId, status) {
        const li = this.roundsListEl.querySelector(
            `[data-round-id="${CSS.escape(roundId)}"] [data-section-id="${CSS.escape(sectionId)}"]`,
        );
        if (!li) return;
        li.dataset.status = status;
        if (status === 'done' || status === 'failed') {
            if (!this._manualToggles.has(`section:${roundId}:${sectionId}`)) {
                const details = li.querySelector(':scope > details');
                this._setDetailsOpen(details, false);
            }
        }
    }

    _renderRoundStatus(roundId, status) {
        const li = this.roundsListEl.querySelector(`[data-round-id="${CSS.escape(roundId)}"]`);
        if (!li) return;
        li.dataset.status = status;
        const summary = li.querySelector(':scope > details > summary');
        if (summary) {
            const statusSpan = summary.querySelector('.round-status');
            if (statusSpan) statusSpan.textContent = status;
            if (status === 'done' || status === 'failed') {
                const run = this._run();
                const round = run?.rounds.find(r => r.id === roundId);
                const elapsedSpan = summary.querySelector('.round-elapsed');
                if (round && elapsedSpan && round.endedAt != null) {
                    elapsedSpan.textContent = this._formatElapsed(round.endedAt - round.startedAt);
                }
            }
        }
        if (status === 'done' || status === 'failed') {
            this._stopRoundTimer(roundId);
            if (!this._manualToggles.has(`round:${roundId}`)) {
                const details = li.querySelector(':scope > details');
                this._setDetailsOpen(details, false);
            }
        }
    }

    _renderRunFinished(status) {
        const run = this._run();
        if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
        this._sweepRoundTimers();
        if (run && this.elapsedEl) {
            const end = run.endedAt ?? performance.now();
            const sec = ((end - run.startedAt) / 1000).toFixed(1);
            this.elapsedEl.textContent = `${sec}s`;
        }
        if (run) {
            for (const round of run.rounds) {
                const li = this.roundsListEl.querySelector(`[data-round-id="${CSS.escape(round.id)}"]`);
                const elapsedSpan = li?.querySelector(':scope > details > summary > .round-elapsed');
                if (!elapsedSpan) continue;
                const end = round.endedAt ?? run.endedAt ?? performance.now();
                elapsedSpan.textContent = this._formatElapsed(end - round.startedAt);
            }
        }
        this.headerStatusEl.dataset.status = status;
        this.stopBtnEl.hidden = true;
        if (run && run.finalText != null && this.finalOutputEl) {
            this.finalOutputEl.hidden = false;
            this.finalOutputEl.querySelector('pre').textContent = run.finalText;
        }
        for (const li of this.roundsListEl.querySelectorAll('.round')) {
            const roundId = li.dataset.roundId;
            if (!roundId || this._manualToggles.has(`round:${roundId}`)) continue;
            this._setDetailsOpen(li.querySelector(':scope > details'), false);
        }
        for (const sli of this.roundsListEl.querySelectorAll('.section')) {
            const sectionId = sli.dataset.sectionId;
            const roundLi = sli.closest('.round');
            const roundId = roundLi?.dataset.roundId;
            if (!sectionId || !roundId) continue;
            if (this._manualToggles.has(`section:${roundId}:${sectionId}`)) continue;
            this._setDetailsOpen(sli.querySelector(':scope > details'), false);
        }
        this._renderHeader();
        this._maybeScroll();
    }

    _renderCleared() {
        if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
        this._sweepRoundTimers();
        this.roundsListEl.innerHTML = '';
        this._manualToggles.clear();
        if (this.finalOutputEl) this.finalOutputEl.hidden = true;
        this.root.dataset.state = 'closed';
    }

    async _copySection(roundId, sectionId, btn) {
        const run = this._run();
        const round = run?.rounds.find(r => r.id === roundId);
        const section = round?.sections.find(s => s.id === sectionId);
        if (!section) return;
        let text = section.body;
        if (section.meta) {
            text = `## ${section.kind}: ${section.title}\n\n${text}\n\n\`\`\`json\n${JSON.stringify(section.meta, null, 2)}\n\`\`\``;
        }
        try {
            await navigator.clipboard.writeText(text);
            const old = btn.textContent;
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = old; }, 800);
        } catch (_) {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
    }

    collapseAll() {
        for (const d of this.root.querySelectorAll('details[open]')) {
            d.open = false;
        }
    }

    exportTrace() {
        const run = this._run();
        if (!run) return;
        const snapshot = JSON.parse(JSON.stringify(run, (k, v) => (k === 'abortFn' ? undefined : v)));
        const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this.exportFilename({ runId: run.runId, mode: run.mode });
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    stop() {
        const run = this._run();
        if (!run) return;
        if (this.onStop) {
            try { this.onStop(run); } catch (_) { /* ignore */ }
            return;
        }
        if (this.stopBtnEl) this.stopBtnEl.disabled = true;
        if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
        this._sweepRoundTimers();
        if (this.headerStatusEl) this.headerStatusEl.dataset.status = 'stopping';
        try {
            if (run.stopFn) {
                run.stopFn();
            } else if (run.abortFn) {
                run.abortFn();
            }
        } catch (_) { /* ignore */ }
    }

    destroy() {
        if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
        this._sweepRoundTimers();
        this._pendingAppends.clear();
        this._rafScheduled = false;
    }

    replayFromStore() {
        const run = this._run();
        if (!run) return;
        this._renderRunStart();
        for (const round of run.rounds) {
            this._renderRoundAppended(round.id);
            for (const section of round.sections) {
                this._renderSectionEnsured(round.id, section.id);
                if (section.status !== 'running') {
                    this._renderSectionStatus(round.id, section.id, section.status);
                }
            }
            if (round.status !== 'running') {
                this._renderRoundStatus(round.id, round.status);
            }
        }
        if (run.status !== 'running') {
            this._renderRunFinished(run.status);
        }
    }
}
