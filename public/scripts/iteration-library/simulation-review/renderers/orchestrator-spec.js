import { appendShared, appendToolStatusChip, appendToolSourceChip, jsonOrText } from './shared.js';

export function render(payload, i18n) {
    const root = document.createElement('div');
    root.className = 'luker-sim-review luker-sim-review--orch-spec';

    const stages = Array.isArray(payload?.stages) ? payload.stages : [];
    stages.forEach(stage => {
        const stageLabel = `Stage ${stage.stageIndex + 1}`;
        const stageSec = appendShared.section(root, `${stageLabel} [${stage.mode}]`, null, { collapsedByDefault: true });
        const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
        nodes.forEach(node => {
            const nodePath = `${stageLabel} → Node "${node.id}"`;
            const nodeSec = appendShared.subsection(stageSec, `${node.kind} — ${node.id}`, null, { collapsedByDefault: true });
            renderTurns(nodeSec, node.turns || [], nodePath, i18n);
            if (Array.isArray(node.reviewReplayedStages) && node.reviewReplayedStages.length > 0) {
                appendShared.note(nodeSec, `Replayed stages: ${node.reviewReplayedStages.map(i => i + 1).join(', ')}`);
            }
            const outSec = appendShared.subsection(nodeSec, i18n('sim.label.output', 'Output'), `${nodePath} → Output`, { collapsedByDefault: true });
            appendShared.pre(outSec, node.output || '');
        });
    });

    if (typeof payload?.finalCapsule === 'string' && payload.finalCapsule) {
        const sec = appendShared.section(root, i18n('sim.section.final_capsule', 'Final Capsule'), 'Final Capsule', { isFinalOutput: true });
        appendShared.pre(sec, payload.finalCapsule);
    }
    return root;
}

function renderTurns(parent, turns, basePath, i18n) {
    turns.forEach((turn, i) => {
        const turnLabel = `Turn ${i + 1}`;
        const turnPath = `${basePath} → ${turnLabel}`;
        const turnSec = appendShared.subsubsection(parent, turnLabel, null, { collapsedByDefault: true });
        if (turn.reasoning) {
            const rsec = appendShared.subsubsection(turnSec, i18n('sim.label.reasoning', 'Reasoning'), `${turnPath} → Reasoning`, { collapsedByDefault: true });
            appendShared.pre(rsec, turn.reasoning);
        }
        if (turn.assistantText) {
            const asec = appendShared.subsubsection(turnSec, i18n('sim.label.assistant', 'Assistant'), `${turnPath} → Assistant`, { collapsedByDefault: true });
            appendShared.pre(asec, turn.assistantText);
        }
        const tcs = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
        tcs.forEach((tc, j) => {
            const tcPath = `${turnPath} → Tool call #${j + 1} (${tc.name})`;
            const tcSec = appendShared.subsubsection(turnSec, `Tool call #${j + 1}: ${tc.name}`, null, { collapsedByDefault: true });
            appendToolSourceChip(tcSec, tc.source);
            appendToolStatusChip(tcSec, tc.result, i18n);
            const argsSec = appendShared.subsubsection(tcSec, i18n('sim.label.args', 'args'), `${tcPath} → args`, { collapsedByDefault: true });
            appendShared.pre(argsSec, jsonOrText(tc.args));
            const resSec = appendShared.subsubsection(tcSec, i18n('sim.label.result', 'result'), `${tcPath} → result`, { collapsedByDefault: true });
            appendShared.pre(resSec, jsonOrText(tc.result));
        });
    });
}
