import { appendShared, appendToolStatusChip, appendToolSourceChip, jsonOrText } from './shared.js';

export function render(payload, i18n) {
    const root = document.createElement('div');
    root.className = 'luker-sim-review luker-sim-review--orch-loop';
    appendShared.note(root, `Termination: ${payload?.terminationReason || ''}`);

    const rounds = Array.isArray(payload?.rounds) ? payload.rounds : [];
    rounds.forEach(round => {
        const roundLabel = `Round ${round.roundIndex + 1}`;
        const sec = appendShared.section(root, roundLabel, null, { collapsedByDefault: true });
        if (round.reasoning) {
            const r = appendShared.subsection(sec, i18n('sim.label.reasoning', 'Reasoning'), `${roundLabel} → Reasoning`, { collapsedByDefault: true });
            appendShared.pre(r, round.reasoning);
        }
        if (round.assistantText) {
            const a = appendShared.subsection(sec, i18n('sim.label.assistant', 'Assistant'), `${roundLabel} → Assistant`, { collapsedByDefault: true });
            appendShared.pre(a, round.assistantText);
        }
        const tcs = Array.isArray(round.toolCalls) ? round.toolCalls : [];
        tcs.forEach((tc, j) => {
            const tcPath = `${roundLabel} → Tool call #${j + 1} (${tc.name})`;
            const tcSec = appendShared.subsection(sec, `Tool call #${j + 1}: ${tc.name}`, null, { collapsedByDefault: true });
            appendToolSourceChip(tcSec, tc.source);
            appendToolStatusChip(tcSec, tc.result, i18n);
            const argsSec = appendShared.subsubsection(tcSec, i18n('sim.label.args', 'args'), `${tcPath} → args`, { collapsedByDefault: true });
            appendShared.pre(argsSec, jsonOrText(tc.args));
            const resSec = appendShared.subsubsection(tcSec, i18n('sim.label.result', 'result'), `${tcPath} → result`, { collapsedByDefault: true });
            appendShared.pre(resSec, jsonOrText(tc.result));
        });
    });

    if (payload?.capsule) {
        const sec = appendShared.section(root, i18n('sim.section.capsule', 'Capsule'), 'Capsule', { isFinalOutput: true });
        appendShared.pre(sec, payload.capsule);
    }
    return root;
}
