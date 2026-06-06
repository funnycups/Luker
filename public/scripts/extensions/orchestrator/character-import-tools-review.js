/**
 * Review popup shown when importing a character card whose orchestrator
 * profile carries `customTools[]` entries.
 *
 * Authoring a custom tool is authoring executable JavaScript that runs
 * with the full SillyTavern session permissions. When that JavaScript
 * arrives via a third-party character card, the user MUST opt in
 * explicitly — never silently. This popup surfaces every incoming entry
 * (name, mode, description, expandable body) and offers three choices:
 *
 *   - 'with'    : import the profile and the tools
 *   - 'without' : import the profile, drop the tools
 *   - 'cancel'  : drop the whole import
 *
 * Pure UI; caller does the actual apply.
 */

const __ctx = SillyTavern.getContext();
const Popup = __ctx.Popup;
const POPUP_TYPE = __ctx.POPUP_TYPE;
const POPUP_RESULT = __ctx.POPUP_RESULT;
import { escapeHtml as esc } from './html-escape.js';

const RESULT_WITH = POPUP_RESULT.AFFIRMATIVE;       // 1
const RESULT_WITHOUT = POPUP_RESULT?.CUSTOM1 ?? 1001;

function buildHtml(tools, t) {
    const list = tools.map(tool => `
        <li class="luker_orch_ct_import_item">
            <div class="luker_orch_ct_import_head">
                <code class="luker_orch_ct_import_name">${esc(tool?.name || '')}</code>
                <span class="luker_orch_ct_mode">[${esc(tool?.mode === 'read' ? 'read' : 'write')}]</span>
            </div>
            ${tool?.description ? `<div class="luker_orch_ct_import_desc">${esc(tool.description)}</div>` : ''}
            <details class="luker_orch_ct_import_body">
                <summary>${esc(t('View body...'))}</summary>
                <pre class="monospace luker_orch_ct_import_pre">${esc(tool?.body || '')}</pre>
                ${tool?.simulateBody ? `<pre class="monospace luker_orch_ct_import_pre">${esc(tool.simulateBody)}</pre>` : ''}
            </details>
        </li>
    `).join('');
    const warning = t('This character ships ${0} custom tools that will run JavaScript with full access to your SillyTavern session:').replace('${0}', String(tools.length));
    return `
<div class="luker_orch_ct_import_review">
    <div class="luker_orch_ct_warning">
        ${esc(warning)}
    </div>
    <ul class="luker_orch_ct_import_list">${list}</ul>
</div>
    `;
}

/**
 * @param {object} opts
 * @param {Array<object>} opts.tools Sanitized customTools entries.
 * @param {(s: string) => string} opts.t i18n helper.
 * @returns {Promise<'with' | 'without' | 'cancel'>}
 */
export async function reviewIncomingCustomTools({ tools, t }) {
    const arr = Array.isArray(tools) ? tools : [];
    // No tools to review — caller should not have called us, but tolerate
    // the empty case by acting like the user picked "import as-is".
    if (arr.length === 0) {
        return 'with';
    }

    const html = buildHtml(arr, t);
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton: t('Apply with tools'),
        cancelButton: t('Cancel'),
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        customButtons: [
            { text: t('Apply without tools'), result: RESULT_WITHOUT, appendAtEnd: true },
        ],
    });
    const result = await popup.show();
    if (result === RESULT_WITH) return 'with';
    if (result === RESULT_WITHOUT) return 'without';
    return 'cancel';
}
