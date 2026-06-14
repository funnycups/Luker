// public/scripts/extensions/orchestrator/run-panel/render-incremental.js
/**
 * Translates RunStateStore events into incremental DOM updates inside
 * #luker-orch-run-panel. No framework; just direct DOM ops.
 *
 * SECTION_APPENDED is the high-frequency event. We coalesce within a
 * single rAF so a fast token stream produces at most ~60 DOM writes/s.
 */

import * as EV from '../run-state/events.js';
import { getCurrentRun } from '../run-state/store.js';
import { i18n, i18nFormat } from '../i18n.js';

const KIND_ICON = {
    reasoning: '💭',
    text: '📝',
    tool_call: '🔧',
    tool_result: '✅',
    sub_agent: '🤖',
    note: '💡',
    messages_dump: '📦',
};

export class PanelRenderer {
    constructor(rootEl) {
        this.root = rootEl;
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
        // Tracks user-driven expand/collapse on round/section <details>.
        // Auto-collapse on terminal status skips any entry the user has
        // touched so a manually-pinned section stays pinned.
        this._manualToggles = new Map();
        // Guards against `_setDetailsOpen` recording its own programmatic
        // flip as a "user toggle" — we set this before mutating .open and
        // clear it after, so the toggle listener can ignore the bounce.
        this._suppressToggleRecord = false;
        this._elapsedTimer = null;

        this._bindScrollPin();
    }

    /**
     * Flip `<details>.open` programmatically without polluting
     * `_manualToggles`. Use this for round/section auto-fold on
     * terminal status; direct `details.open = ...` is only safe at
     * construction (before the toggle listener is attached).
     */
    _setDetailsOpen(detailsEl, open) {
        if (!detailsEl) return;
        if (detailsEl.open === Boolean(open)) return;
        this._suppressToggleRecord = true;
        try {
            detailsEl.open = Boolean(open);
        } finally {
            // Clear after the synchronous assignment — the toggle event
            // fires asynchronously, so flip the flag back in a microtask
            // so the very next handler sees the suppression and later
            // user-driven toggles see it cleared.
            queueMicrotask(() => { this._suppressToggleRecord = false; });
        }
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
            btn.textContent = i18n('Jump to latest');
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
        const run = getCurrentRun();
        if (!run) return;
        this.root.dataset.state = 'open';
        this.roundsListEl.innerHTML = '';
        this._manualToggles.clear();
        // Clear any "no active run" empty-state that may have been planted
        // by a prior menu-triggered openRunPanel() call.
        const empty = this.bodyEl.querySelector(':scope > .empty-state');
        if (empty) empty.remove();
        if (this.finalOutputEl) this.finalOutputEl.hidden = true;
        this.modeBadgeEl.textContent = run.mode;
        this.modeBadgeEl.dataset.mode = run.mode;
        this.headerStatusEl.dataset.status = run.status;
        this.stopBtnEl.hidden = false;
        this._startElapsedTimer();
        this._renderHeader();
    }

    _startElapsedTimer() {
        if (this._elapsedTimer) clearInterval(this._elapsedTimer);
        const run = getCurrentRun();
        if (!run) return;
        const tick = () => {
            const r = getCurrentRun();
            if (!r) return;
            const end = r.endedAt ?? performance.now();
            const sec = ((end - r.startedAt) / 1000).toFixed(1);
            this.elapsedEl.textContent = `${sec}s`;
        };
        tick();
        this._elapsedTimer = setInterval(tick, 200);
    }

    _renderHeader() {
        const run = getCurrentRun();
        if (!run) return;
        const numRounds = run.rounds.length;
        const numToolCalls = run.rounds.reduce(
            (n, r) => n + r.sections.filter(s => s.kind === 'tool_call').length, 0,
        );
        const tokens = run.tokensSpent?.total ?? '—';
        const tokensFmt = typeof tokens === 'number'
            ? (tokens > 999 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens))
            : tokens;
        this.summaryEl.textContent = i18nFormat('${0} rounds · ${1} tool calls · ${2} tokens',
            numRounds, numToolCalls, tokensFmt);
    }

    _renderRoundAppended(roundId) {
        const run = getCurrentRun();
        if (!run) return;
        const round = run.rounds.find(r => r.id === roundId);
        if (!round) return;

        const li = document.createElement('li');
        li.className = 'round';
        li.dataset.roundId = roundId;
        li.dataset.status = round.status;

        const details = document.createElement('details');
        details.open = true; // running round defaults open
        const summary = document.createElement('summary');
        summary.textContent = `● ${round.label} · ${round.status}`;
        details.appendChild(summary);

        const ol = document.createElement('ol');
        ol.className = 'sections-list';
        details.appendChild(ol);

        // Track manual toggles so subsequent status updates don't override
        // user-driven expand/collapse decisions. Programmatic flips via
        // `_setDetailsOpen` (terminal-status auto-fold) set
        // `_suppressToggleRecord` so they don't masquerade as user input.
        details.addEventListener('toggle', () => {
            if (this._suppressToggleRecord) return;
            this._manualToggles.set(`round:${roundId}`, details.open);
        });

        li.appendChild(details);
        this.roundsListEl.appendChild(li);
        this._renderHeader();
        this._maybeScroll();
    }

    _renderSectionEnsured(roundId, sectionId) {
        const li = this.roundsListEl.querySelector(`[data-round-id="${CSS.escape(roundId)}"]`);
        if (!li) return;
        const ol = li.querySelector('.sections-list');
        if (!ol) return;
        if (ol.querySelector(`[data-section-id="${CSS.escape(sectionId)}"]`)) return;

        const run = getCurrentRun();
        const round = run?.rounds.find(r => r.id === roundId);
        const section = round?.sections.find(s => s.id === sectionId);
        if (!section) return;

        const sli = document.createElement('li');
        sli.className = 'section';
        sli.dataset.sectionId = sectionId;
        sli.dataset.kind = section.kind;
        sli.dataset.status = section.status;

        const details = document.createElement('details');
        const isMessagesDump = section.kind === 'messages_dump';
        details.open = !isMessagesDump; // messages_dump deep-folds by default

        const summary = document.createElement('summary');
        const icon = KIND_ICON[section.kind] || '•';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = `${icon} ${section.title}`;
        summary.appendChild(titleSpan);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.title = i18n('Copy');
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

        details.addEventListener('toggle', () => {
            if (this._suppressToggleRecord) return;
            this._manualToggles.set(`section:${roundId}:${sectionId}`, details.open);
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
        // Auto-fold finished sections so a long run doesn't keep every
        // tool_call / tool_result expanded — mobile dies under that.
        // Skip when the user has manually toggled this section: their
        // pin overrides the auto-fold.
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
            const run = getCurrentRun();
            const round = run?.rounds.find(r => r.id === roundId);
            if (round) summary.textContent = `● ${round.label} · ${status}`;
        }
        if (status === 'done' || status === 'failed') {
            if (!this._manualToggles.has(`round:${roundId}`)) {
                const details = li.querySelector(':scope > details');
                this._setDetailsOpen(details, false);
            }
        }
    }

    _renderRunFinished(status) {
        const run = getCurrentRun();
        if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
        // Tick the timer one final time so the displayed elapsed reflects endedAt.
        if (run && this.elapsedEl) {
            const end = run.endedAt ?? performance.now();
            const sec = ((end - run.startedAt) / 1000).toFixed(1);
            this.elapsedEl.textContent = `${sec}s`;
        }
        this.headerStatusEl.dataset.status = status;
        this.stopBtnEl.hidden = true;
        if (run && run.finalText != null && this.finalOutputEl) {
            this.finalOutputEl.hidden = false;
            this.finalOutputEl.querySelector('pre').textContent = run.finalText;
        }
        // Final sweep: collapse every round/section that never reached
        // a terminal status — covers aborted runs and edge cases where
        // a SECTION_STATUS / ROUND_STATUS event was skipped. The final
        // output stays open; user-pinned entries stay pinned.
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
        this.roundsListEl.innerHTML = '';
        this._manualToggles.clear();
        if (this.finalOutputEl) this.finalOutputEl.hidden = true;
        this.root.dataset.state = 'closed';
    }

    async _copySection(roundId, sectionId, btn) {
        const run = getCurrentRun();
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
        const run = getCurrentRun();
        if (!run) return;
        const snapshot = JSON.parse(JSON.stringify(run, (k, v) => (k === 'abortFn' ? undefined : v)));
        const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = `orch-run-${run.runId}-${run.mode}-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    stop() {
        const run = getCurrentRun();
        if (run?.abortFn) {
            try { run.abortFn(); } catch (_) { /* ignore */ }
        }
    }

    /**
     * Rebuild the panel from the live store snapshot. Used when the user
     * manually opens the panel during (or after) a quiet run — those
     * skip the auto-open + incremental wiring on RUN_STARTED, so the
     * panel DOM is empty until we replay the round/section history.
     *
     * Tail sections that are still mid-stream stay live: the rAF append
     * coalescer keeps pointing at the freshly-recreated <pre> nodes, so
     * subsequent SECTION_APPENDED events continue to land in the right
     * spot without rebinding.
     */
    replayFromStore() {
        const run = getCurrentRun();
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
