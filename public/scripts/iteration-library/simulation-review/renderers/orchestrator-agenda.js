import { appendShared, appendToolStatusChip, jsonOrText } from './shared.js';

export function render(payload, i18n) {
    const root = document.createElement('div');
    root.className = 'luker-sim-review luker-sim-review--orch-agenda';

    const rounds = Array.isArray(payload?.rounds) ? payload.rounds : [];
    rounds.forEach(round => {
        const roundLabel = `Round ${round.roundIndex + 1}`;
        const roundSec = appendShared.section(root, roundLabel, null, { collapsedByDefault: true });

        const planner = round.planner || {};
        const plannerBase = `${roundLabel} → Planner`;
        const plannerSec = appendShared.subsection(roundSec, 'Planner', null, { collapsedByDefault: true });
        renderTurns(plannerSec, planner.turns || [], plannerBase, i18n);
        const plannerOut = appendShared.subsection(plannerSec, i18n('sim.label.output', 'Output'), `${plannerBase} → Output`, { collapsedByDefault: true });
        appendShared.pre(plannerOut, planner.output || '');

        const dispatches = Array.isArray(round.dispatches) ? round.dispatches : [];
        dispatches.forEach(d => {
            const dBase = `${roundLabel} → Dispatch "${d.agentName}"`;
            const dSec = appendShared.subsection(roundSec, `Dispatch: ${d.agentName} (todo=${d.todoId})`, null, { collapsedByDefault: true });
            appendShared.note(dSec, `Task brief: ${d.taskBrief || ''}`);
            renderTurns(dSec, d.turns || [], dBase, i18n);
            const out = appendShared.subsection(dSec, i18n('sim.label.output', 'Output'), `${dBase} → Output`, { collapsedByDefault: true });
            appendShared.pre(out, d.output || '');
        });
    });

    const finalizer = payload?.finalizer || {};
    const finSec = appendShared.section(root, i18n('sim.section.finalizer', 'Finalizer'), null, { collapsedByDefault: true });
    renderTurns(finSec, finalizer.turns || [], 'Finalizer', i18n);
    const finOut = appendShared.subsection(finSec, i18n('sim.label.output', 'Output'), 'Finalizer → Output', { collapsedByDefault: true });
    appendShared.pre(finOut, finalizer.output || '');

    const composedSec = appendShared.section(root, i18n('sim.section.final_composed', 'Final Composed Output'), 'Final Composed Output', { isFinalOutput: true });
    appendShared.pre(composedSec, payload?.finalComposedOutput || '');
    return root;
}

function renderTurns(parent, turns, basePath, i18n) {
    turns.forEach((turn, i) => {
        const turnLabel = `Turn ${i + 1}`;
        const turnPath = `${basePath} → ${turnLabel}`;
        const turnSec = appendShared.subsubsection(parent, turnLabel, null, { collapsedByDefault: true });
        if (turn.reasoning) {
            const r = appendShared.subsubsection(turnSec, i18n('sim.label.reasoning', 'Reasoning'), `${turnPath} → Reasoning`, { collapsedByDefault: true });
            appendShared.pre(r, turn.reasoning);
        }
        if (turn.assistantText) {
            const a = appendShared.subsubsection(turnSec, i18n('sim.label.assistant', 'Assistant'), `${turnPath} → Assistant`, { collapsedByDefault: true });
            appendShared.pre(a, turn.assistantText);
        }
        const tcs = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
        tcs.forEach((tc, j) => {
            const tcPath = `${turnPath} → Tool call #${j + 1} (${tc.name})`;
            const tcSec = appendShared.subsubsection(turnSec, `Tool call #${j + 1}: ${tc.name}`, null, { collapsedByDefault: true });
            appendToolStatusChip(tcSec, tc.result, i18n);
            const argsSec = appendShared.subsubsection(tcSec, i18n('sim.label.args', 'args'), `${tcPath} → args`, { collapsedByDefault: true });
            appendShared.pre(argsSec, jsonOrText(tc.args));
            const resSec = appendShared.subsubsection(tcSec, i18n('sim.label.result', 'result'), `${tcPath} → result`, { collapsedByDefault: true });
            appendShared.pre(resSec, jsonOrText(tc.result));
        });
    });
}
