/**
 * Edits lib — interactive conflict resolution popup.
 *
 * Consumes the `conflicts` array returned by `applyEdits` and asks the
 * user, per conflict, what to do: apply-mine (overwrite live), keep-theirs
 * (skip this edit), or manual-edit (provide a custom value).
 *
 * Plugin authors that need a different render for a particular op type can
 * provide `renderConflict(entry)` on their custom op handler; conflict-ui
 * calls it instead of the default 3-pane.
 *
 * Returns a Promise<Resolution[]> where each Resolution is one of:
 *   { decision: 'apply-mine', edit }
 *   { decision: 'keep-theirs', edit }
 *   { decision: 'manual', edit, newValue }    // newValue overrides edit.newValue / op-specific field
 */
import { Popup, POPUP_TYPE } from '../../popup.js';

function escapeHtml(s) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(s ?? '')));
    return div.innerHTML;
}

function formatPreviewValue(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); }
    catch { return String(v); }
}

function renderDefaultConflict(entry, index) {
    const div = document.createElement('div');
    div.className = 'luker-studio-merge-entry';
    div.dataset.entryIndex = String(index);

    const path = entry.edit.path || '(root)';
    const opName = entry.edit.op;
    div.innerHTML = `
        <div class="luker-studio-merge-head">
            <code class="luker-studio-merge-path">${escapeHtml(path)}</code>
            <span class="luker-studio-merge-op">${escapeHtml(opName)}</span>
            <span class="luker-studio-merge-reason">${escapeHtml(entry.reason)}</span>
        </div>
        <div class="luker-studio-merge-panes">
            <div class="luker-studio-merge-pane">
                <h4>Baseline (what AI assumed)</h4>
                <pre>${escapeHtml(formatPreviewValue(entry.baseline))}</pre>
            </div>
            <div class="luker-studio-merge-pane">
                <h4>Proposed</h4>
                <pre>${escapeHtml(formatPreviewValue(entry.edit.newValue ?? entry.edit.replace ?? entry.edit.insert_text ?? entry.edit.value ?? '(see op)'))}</pre>
            </div>
            <div class="luker-studio-merge-pane">
                <h4>Current Live</h4>
                <pre>${escapeHtml(formatPreviewValue(entry.current))}</pre>
            </div>
        </div>
        <div class="luker-studio-merge-choices">
            <label><input type="radio" name="merge-${index}" value="apply-mine"> Apply proposed (overwrite live)</label>
            <label><input type="radio" name="merge-${index}" value="keep-theirs" checked> Keep live (skip this edit)</label>
            <label><input type="radio" name="merge-${index}" value="manual"> Manual edit</label>
            <textarea class="luker-studio-merge-manual" rows="3" placeholder="Manual value (used only if Manual edit selected)"></textarea>
        </div>
    `;
    return div;
}

/**
 * Show the conflict resolution popup.
 *
 * @param {ConflictEntry[]} conflicts  from applyEdits
 * @param {object} [opts]
 * @param {(name: string) => OpHandler | null} [opts.getRegisteredOp]  to look up custom renderConflict
 * @returns {Promise<Resolution[] | null>}  null if user cancelled
 */
export async function showConflictResolution(conflicts, opts = {}) {
    if (!Array.isArray(conflicts) || conflicts.length === 0) {
        return [];
    }

    const container = document.createElement('div');
    container.className = 'luker-studio luker-studio-merge';

    const header = document.createElement('div');
    header.className = 'luker-studio-merge-header';
    header.innerHTML = `<h3>Resolve ${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''}</h3>`;
    container.appendChild(header);

    conflicts.forEach((entry, idx) => {
        let entryNode;
        const customHandler = opts.getRegisteredOp && opts.getRegisteredOp(entry.edit.op);
        if (customHandler && typeof customHandler.renderConflict === 'function') {
            // Custom render returns an element; we wrap it with choice radios.
            const customBody = customHandler.renderConflict(entry);
            entryNode = document.createElement('div');
            entryNode.className = 'luker-studio-merge-entry luker-studio-merge-entry-custom';
            entryNode.dataset.entryIndex = String(idx);
            entryNode.appendChild(customBody);
            const choices = document.createElement('div');
            choices.className = 'luker-studio-merge-choices';
            choices.innerHTML = `
                <label><input type="radio" name="merge-${idx}" value="apply-mine"> Apply proposed</label>
                <label><input type="radio" name="merge-${idx}" value="keep-theirs" checked> Keep live</label>
            `;
            entryNode.appendChild(choices);
        } else {
            entryNode = renderDefaultConflict(entry, idx);
        }
        container.appendChild(entryNode);
    });

    const popup = new Popup(container, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Resolve & Apply',
        cancelButton: 'Cancel',
        wider: true,
        allowVerticalScrolling: true,
    });

    const result = await popup.show();
    if (!result) return null;     // user cancelled

    // Collect decisions from the rendered DOM.
    return conflicts.map((entry, idx) => {
        const chosen = container.querySelector(`input[name="merge-${idx}"]:checked`);
        const decision = chosen ? chosen.value : 'keep-theirs';
        if (decision === 'manual') {
            const ta = container.querySelector(`.luker-studio-merge-entry[data-entry-index="${idx}"] .luker-studio-merge-manual`);
            const raw = ta ? String(ta.value || '') : '';
            let parsed = raw;
            try { parsed = JSON.parse(raw); } catch { /* keep as string */ }
            return { decision, edit: entry.edit, newValue: parsed };
        }
        return { decision, edit: entry.edit };
    });
}
