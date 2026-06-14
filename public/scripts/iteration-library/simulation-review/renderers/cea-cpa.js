import { appendShared } from './shared.js';

export function render(payload, i18n) {
    const root = document.createElement('div');
    root.className = 'luker-sim-review luker-sim-review--singleshot';

    const out = appendShared.section(root, i18n('sim.section.final_output', 'Final Output'), 'Final Output', { isFinalOutput: true });
    appendShared.pre(out, payload?.finalOutput || '');

    if (payload?.reasoning) {
        const sec = appendShared.section(root, i18n('sim.section.reasoning', 'Reasoning'), 'Reasoning', { collapsedByDefault: true });
        appendShared.pre(sec, payload.reasoning);
    }

    if (payload?.assembledPrompt) {
        const ap = appendShared.section(root, i18n('sim.section.assembled_prompt', 'Assembled Prompt'), null, { collapsedByDefault: true });
        if (payload.assembledPrompt?.systemPrompt) {
            const sysSec = appendShared.subsection(ap, i18n('sim.section.assembled_system', 'System'), 'Assembled Prompt → System', { collapsedByDefault: true });
            appendShared.pre(sysSec, payload.assembledPrompt.systemPrompt);
        }
        const messages = Array.isArray(payload.assembledPrompt?.messages) ? payload.assembledPrompt.messages : [];
        let userIdx = 0, assistIdx = 0, sysIdx = 0;
        messages.forEach((m) => {
            const role = (m.role || '').toLowerCase();
            let niceRole, idx;
            if (role === 'user') { niceRole = 'User'; idx = ++userIdx; }
            else if (role === 'assistant') { niceRole = 'Assistant'; idx = ++assistIdx; }
            else { niceRole = 'System'; idx = ++sysIdx; }
            const label = `${niceRole} #${idx}`;
            const path = `Assembled Prompt → ${niceRole} #${idx}`;
            const sec = appendShared.subsection(ap, label, path, { collapsedByDefault: true });
            appendShared.pre(sec, String(m.content || ''));
        });
    }
    return root;
}
