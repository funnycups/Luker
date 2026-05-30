import { appendShared, jsonOrText } from './shared.js';

export function render(payload, i18n) {
    const root = document.createElement('div');
    root.className = 'luker-sim-review luker-sim-review--orch-director';

    const mainSec = appendShared.section(root, i18n('sim.section.main_agent', 'Main Agent'), null, { collapsedByDefault: true });
    const rounds = Array.isArray(payload?.mainAgent?.rounds) ? payload.mainAgent.rounds : [];
    rounds.forEach(round => {
        const roundLabel = `Round ${round.roundIndex + 1}`;
        const base = `Main Agent → ${roundLabel}`;
        const sec = appendShared.subsection(mainSec, roundLabel, null, { collapsedByDefault: true });
        if (round.reasoning) {
            const r = appendShared.subsubsection(sec, i18n('sim.label.reasoning', 'Reasoning'), `${base} → Reasoning`, { collapsedByDefault: true });
            appendShared.pre(r, round.reasoning);
        }
        if (round.assistantText) {
            const a = appendShared.subsubsection(sec, i18n('sim.label.assistant', 'Assistant'), `${base} → Assistant`, { collapsedByDefault: true });
            appendShared.pre(a, round.assistantText);
        }
        const tcs = Array.isArray(round.toolCalls) ? round.toolCalls : [];
        tcs.forEach((tc, j) => {
            const tcPath = `${base} → Tool call #${j + 1} (${tc.name})`;
            const tcSec = appendShared.subsubsection(sec, `Tool call #${j + 1}: ${tc.name}`, null, { collapsedByDefault: true });
            const argsSec = appendShared.subsubsection(tcSec, i18n('sim.label.args', 'args'), `${tcPath} → args`, { collapsedByDefault: true });
            appendShared.pre(argsSec, jsonOrText(tc.args));
            const resSec = appendShared.subsubsection(tcSec, i18n('sim.label.result', 'result'), `${tcPath} → result`, { collapsedByDefault: true });
            appendShared.pre(resSec, jsonOrText(tc.result));
        });
    });

    const subs = Array.isArray(payload?.subagents) ? payload.subagents : [];
    subs.forEach(sub => {
        const subBase = `Sub-agent "${sub.subagentId}"`;
        const sec = appendShared.section(root, `Sub-agent: ${sub.subagentId}${sub.isInline ? ' (inline)' : ''}`, null, { collapsedByDefault: true });
        appendShared.note(sec, `Task: ${sub.task || ''}`);
        if (sub.reasoning) {
            const r = appendShared.subsection(sec, i18n('sim.label.reasoning', 'Reasoning'), `${subBase} → Reasoning`, { collapsedByDefault: true });
            appendShared.pre(r, sub.reasoning);
        }
        const out = appendShared.subsection(sec, i18n('sim.label.output', 'Output'), `${subBase} → Output`, { collapsedByDefault: true });
        appendShared.pre(out, sub.output || '');
    });

    const finSec = appendShared.section(root, i18n('sim.section.final_message', 'Final Message'), 'Final Message', { isFinalOutput: true });
    appendShared.pre(finSec, payload?.finalMessage || '');
    return root;
}
