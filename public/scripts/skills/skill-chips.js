/**
 * Skill chips component.
 *
 * Reusable per-agent + mode-level skill visibility editor. Renders the
 * `skills: { visible: [], deny: [] }` profile field as a row of colored
 * chips (green for `visible`, red for `deny`, distinct for the special
 * `'+'` inherit sentinel) with an "Add..." dropdown and per-chip
 * toggle / remove actions.
 *
 * The component is mounted via `mountSkillChips(host, opts)`. It writes
 * the entire `value` shape via `opts.onChange(nextValue)` on every
 * mutation; the caller is responsible for splicing that into its profile
 * editor and triggering the Luker save flow.
 *
 * Pure helpers (chipKindFor, computeAddOptions, applyChipToggle,
 * applyChipRemove, applyChipAdd, renderSkillChipsHtml) are exported for
 * unit testing without a DOM. The interactive `mountSkillChips` binds
 * delegated `click` handlers on the host element, addressing chips via
 * `data-skill-chip-action` / `data-skill-chip-name` attributes — matching
 * the convention used by other Luker UI panels.
 *
 * Inheritance semantics: agent-level chip rows accept an `inheritFrom`
 * (the mode-level value). When present, the component renders an
 * "Inherit mode default" entry in the add control which inserts the
 * `'+'` sentinel at the head of `visible`. The resolver in
 * `skill-resolution.js` interprets a leading `'+'` as "inherit mode
 * baseline then append the rest"; without inheritFrom (the chips ARE
 * the mode-level slot), this control is suppressed.
 *
 * Missing-skill handling: chip names that don't appear in
 * `availableSkills` are still rendered (so the user sees what's
 * configured) but with a greyed-out class and a tooltip indicating the
 * skill is not installed in the current data dir. The `'+'` sentinel is
 * never considered missing.
 */

import { ensureSkillI18n } from './i18n.js';

// ── Pure helpers (exported for tests) ─────────────────────────────────────

const INHERIT_SENTINEL = '+';

/**
 * Classify a chip name's role within a value: visible / deny / inherit / null.
 *
 * `null` is returned when the name does not appear in either list — the
 * caller can decide whether that's a legal state (rare; only happens if
 * someone passes a stale name to the helper).
 *
 * @param {string} name
 * @param {{visible: string[], deny: string[]}} value
 * @returns {'visible'|'deny'|'inherit'|null}
 */
export function chipKindFor(name, value) {
    if (name === INHERIT_SENTINEL) {
        const visible = Array.isArray(value?.visible) ? value.visible : [];
        return visible.includes(INHERIT_SENTINEL) ? 'inherit' : null;
    }
    const visible = Array.isArray(value?.visible) ? value.visible : [];
    if (visible.includes(name)) return 'visible';
    const deny = Array.isArray(value?.deny) ? value.deny : [];
    if (deny.includes(name)) return 'deny';
    return null;
}

/**
 * True if the skill name is installed (appears in `availableSkills`).
 * The `'+'` sentinel is always installed — it represents the inheritance
 * relationship rather than a physical skill on disk.
 *
 * @param {string} name
 * @param {Array<{name: string}>} availableSkills
 * @returns {boolean}
 */
export function isInstalled(name, availableSkills) {
    if (name === INHERIT_SENTINEL) return true;
    return Array.isArray(availableSkills) && availableSkills.some(s => s && s.name === name);
}

/**
 * Compute the set of skill names that should appear in the "Add..."
 * dropdown — everything in `availableSkills` minus what's already chipped
 * (in either `visible` or `deny`). The `'+'` sentinel is never added via
 * the dropdown — the dedicated "Inherit mode default" control owns that
 * insertion path.
 *
 * @param {{visible: string[], deny: string[]}|undefined} value
 * @param {Array<{name: string}>} availableSkills
 * @returns {Array<{name: string, description?: string}>}
 */
export function computeAddOptions(value, availableSkills) {
    const visible = Array.isArray(value?.visible) ? value.visible : [];
    const deny = Array.isArray(value?.deny) ? value.deny : [];
    const taken = new Set([...visible, ...deny]);
    taken.delete(INHERIT_SENTINEL); // never in the dropdown anyway
    if (!Array.isArray(availableSkills)) return [];
    return availableSkills
        .filter(s => s && typeof s.name === 'string' && !taken.has(s.name))
        .map(s => ({ name: s.name, description: s.description ? String(s.description) : '' }));
}

/**
 * Build the className array for a chip given its kind + install state.
 * Returned as an array so callers can join with whatever delimiter they
 * need (templating vs setting `className` directly).
 *
 * @param {{name: string, kind: 'visible'|'deny'|'inherit', installed: boolean}} chip
 * @returns {string[]}
 */
export function chipClasses({ kind, installed }) {
    const out = ['luker_skill_chip'];
    if (kind === 'visible') out.push('luker_skill_chip_visible');
    else if (kind === 'deny') out.push('luker_skill_chip_deny');
    else if (kind === 'inherit') out.push('luker_skill_chip_inherit');
    if (!installed) out.push('luker_skill_chip_missing');
    return out;
}

// ── Mutation helpers ─────────────────────────────────────────────────────

function cloneValue(value) {
    return {
        visible: Array.isArray(value?.visible) ? value.visible.slice() : [],
        deny: Array.isArray(value?.deny) ? value.deny.slice() : [],
    };
}

/**
 * Toggle a chip between `visible` and `deny`. The `'+'` inherit sentinel
 * cannot be toggled (the resolver doesn't accept `'+'` on the deny list —
 * it's a visible-only signal); the helper returns an equivalent clone in
 * that case so callers can still react uniformly.
 *
 * Returns a new value object — does not mutate the input.
 *
 * @param {{visible: string[], deny: string[]}} value
 * @param {string} name
 * @returns {{visible: string[], deny: string[]}}
 */
export function applyChipToggle(value, name) {
    const next = cloneValue(value);
    if (name === INHERIT_SENTINEL) return next;
    const visibleIdx = next.visible.indexOf(name);
    if (visibleIdx >= 0) {
        next.visible.splice(visibleIdx, 1);
        next.deny.push(name);
        return next;
    }
    const denyIdx = next.deny.indexOf(name);
    if (denyIdx >= 0) {
        next.deny.splice(denyIdx, 1);
        next.visible.push(name);
    }
    return next;
}

/**
 * Drop a chip from both lists. Returns a new value object.
 *
 * @param {{visible: string[], deny: string[]}} value
 * @param {string} name
 * @returns {{visible: string[], deny: string[]}}
 */
export function applyChipRemove(value, name) {
    const next = cloneValue(value);
    next.visible = next.visible.filter(n => n !== name);
    next.deny = next.deny.filter(n => n !== name);
    return next;
}

/**
 * Append a skill name to `visible`. The `'+'` inherit sentinel is
 * canonicalized at the head of `visible` (the resolver checks
 * `visible[0] === '+'`), so callers don't have to worry about ordering.
 * Duplicate names are no-ops. Undefined input is normalized to the
 * empty shape.
 *
 * @param {{visible: string[], deny: string[]}|undefined} value
 * @param {string} name
 * @returns {{visible: string[], deny: string[]}}
 */
export function applyChipAdd(value, name) {
    const next = cloneValue(value);
    if (next.visible.includes(name)) return next;
    if (next.deny.includes(name)) return next; // already chipped on the other side
    if (name === INHERIT_SENTINEL) {
        next.visible.unshift(INHERIT_SENTINEL);
    } else {
        next.visible.push(name);
    }
    return next;
}

// ── HTML rendering ───────────────────────────────────────────────────────

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    })[c]);
}

/**
 * Render a single chip's HTML. The chip body carries the chip name as
 * data-skill-chip-name and `data-skill-chip-action="toggle"`. A nested
 * `x` button carries the same name with `data-skill-chip-action="remove"`.
 * The inherit chip only gets the remove button (toggle is meaningless).
 *
 * @param {{name: string, kind: 'visible'|'deny'|'inherit', installed: boolean, label?: string, t: (s: string) => string}} chip
 * @returns {string}
 */
function renderChipHtml(chip) {
    const { name, kind, installed, label, t } = chip;
    const classes = chipClasses({ kind, installed }).join(' ');
    const displayLabel = label || name;
    // Tooltip explains the chip state. For missing skills we surface the
    // install gap so users can fix it via the skill manager.
    let title;
    if (!installed) {
        title = t('Skill is not installed in your current data dir.');
    } else if (kind === 'inherit') {
        title = t('Inherit mode default visible skills. Click x to remove.');
    } else if (kind === 'visible') {
        title = t('Visible to this agent. Click to deny; x to remove.');
    } else {
        title = t('Denied for this agent. Click to mark visible; x to remove.');
    }
    const escName = escapeHtml(name);
    const escLabel = escapeHtml(displayLabel);
    const escTitle = escapeHtml(title);

    // Inherit chip is non-toggleable; render a static span and only the
    // remove button.
    if (kind === 'inherit') {
        return `<span class="${classes}" data-skill-chip-name="${escName}" title="${escTitle}"><span class="luker_skill_chip_label">${escLabel} ${escapeHtml(t('(inherit mode default)'))}</span><span class="luker_skill_chip_x" data-skill-chip-action="remove" data-skill-chip-name="${escName}" title="${escapeHtml(t('Remove'))}">&times;</span></span>`;
    }
    return `<span class="${classes}" data-skill-chip-action="toggle" data-skill-chip-name="${escName}" title="${escTitle}"><span class="luker_skill_chip_label">${escLabel}</span><span class="luker_skill_chip_x" data-skill-chip-action="remove" data-skill-chip-name="${escName}" title="${escapeHtml(t('Remove'))}">&times;</span></span>`;
}

/**
 * Build the chips block HTML. Pure function — does not touch the DOM.
 *
 * @param {object} opts
 * @param {{visible: string[], deny: string[]}|undefined} opts.value
 * @param {{visible: string[], deny: string[]}|undefined} [opts.inheritFrom]
 *   When present, the row is treated as agent-level (inherits from the
 *   given mode-level value). Enables the "Inherit mode default" add
 *   control. Omit for mode-level rows.
 * @param {Array<{name: string, description?: string}>} opts.availableSkills
 * @param {(s: string) => string} [opts.t] - i18n helper; defaults to identity.
 * @returns {string}
 */
export function renderSkillChipsHtml({ value, inheritFrom, availableSkills, t = (s) => s } = {}) {
    const safeValue = {
        visible: Array.isArray(value?.visible) ? value.visible : [],
        deny: Array.isArray(value?.deny) ? value.deny : [],
    };
    const avail = Array.isArray(availableSkills) ? availableSkills : [];

    // Render order: inherit (if present) → other visible → deny. This is
    // the same order chips appear in the resolved skill catalog.
    const orderedNames = [];
    for (const n of safeValue.visible) {
        if (!orderedNames.includes(n)) orderedNames.push(n);
    }
    for (const n of safeValue.deny) {
        if (!orderedNames.includes(n)) orderedNames.push(n);
    }

    const chipsHtml = orderedNames.map((name) => {
        const kind = chipKindFor(name, safeValue) || 'visible';
        return renderChipHtml({
            name,
            kind,
            installed: isInstalled(name, avail),
            t,
        });
    }).join('');

    const addOptions = computeAddOptions(safeValue, avail);
    const showInheritAdd = Boolean(inheritFrom)
        && !safeValue.visible.includes(INHERIT_SENTINEL);

    // The add control is a single button that, on click, surfaces a
    // dropdown. The component owns the dropdown in mountSkillChips; the
    // pure renderer only emits the button + the static select markup so
    // both jsdom-less tests and the live UI see the same DOM structure.
    const addOptionsHtml = addOptions.map(s => {
        const safeDesc = s.description ? escapeHtml(s.description) : '';
        const title = safeDesc ? ` title="${safeDesc}"` : '';
        return `<option value="${escapeHtml(s.name)}"${title}>${escapeHtml(s.name)}</option>`;
    }).join('');

    const inheritButton = showInheritAdd
        ? `<button type="button" class="menu_button menu_button_small luker_skill_chip_add_inherit" data-skill-chip-action="add-inherit" title="${escapeHtml(t('Inherit mode default visible skills'))}">${escapeHtml(t('+ inherit mode default'))}</button>`
        : '';

    const addControl = addOptions.length > 0
        ? `<span class="luker_skill_chip_add">
            <select class="text_pole luker_skill_chip_add_select" data-skill-chip-add-select>
                <option value="">${escapeHtml(t('Add...'))}</option>
                ${addOptionsHtml}
            </select>
            <button type="button" class="menu_button menu_button_small" data-skill-chip-action="open-add" title="${escapeHtml(t('Add a skill'))}">${escapeHtml(t('Add'))}</button>
        </span>`
        : `<span class="luker_skill_chip_add luker_skill_chip_add_empty" title="${escapeHtml(t('All available skills already chipped'))}">
            <button type="button" class="menu_button menu_button_small" data-skill-chip-action="open-add" disabled>${escapeHtml(t('Add'))}</button>
        </span>`;

    return `<div class="luker_skill_chips">${chipsHtml}${inheritButton}${addControl}</div>`;
}

// ── Interactive mount ─────────────────────────────────────────────────────

/**
 * Mount the chips component into a host element. Re-renders on every
 * mutation; calls `onChange(nextValue)` after each successful mutation
 * so the caller can splice the new value into its profile editor.
 *
 * The caller owns scrolling, layout, and the host element's lifecycle.
 * The component only touches `host.innerHTML` + delegated listeners on
 * the host.
 *
 * @param {HTMLElement} host - container the chips render into
 * @param {object} opts
 * @param {{visible: string[], deny: string[]}|undefined} opts.value
 * @param {{visible: string[], deny: string[]}|undefined} [opts.inheritFrom]
 * @param {Array<{name: string, description?: string}>} opts.availableSkills
 * @param {(next: {visible: string[], deny: string[]}) => void} opts.onChange
 * @param {(s: string) => string} [opts.t] - i18n helper
 * @returns {{ rerender: () => void, getValue: () => object }}
 */
export function mountSkillChips(host, opts = {}) {
    ensureSkillI18n();
    const t = typeof opts.t === 'function' ? opts.t : (s) => s;
    let current = {
        visible: Array.isArray(opts.value?.visible) ? opts.value.visible.slice() : [],
        deny: Array.isArray(opts.value?.deny) ? opts.value.deny.slice() : [],
    };
    const availableSkills = Array.isArray(opts.availableSkills) ? opts.availableSkills : [];
    const inheritFrom = opts.inheritFrom;
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

    function render() {
        host.innerHTML = renderSkillChipsHtml({
            value: current,
            inheritFrom,
            availableSkills,
            t,
        });
        bind();
    }

    function commit(next) {
        current = next;
        if (onChange) onChange({
            visible: current.visible.slice(),
            deny: current.deny.slice(),
        });
        render();
    }

    function bind() {
        // Delegated click handler on every action-bearing element. We bind
        // per-element rather than once on the host because the stub DOM
        // in tests doesn't bubble events; both approaches work identically
        // in real browsers.
        const actionables = host.querySelectorAll('[data-skill-chip-action]');
        actionables.forEach((el) => {
            el.addEventListener('click', (ev) => {
                if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
                const action = el.getAttribute('data-skill-chip-action');
                const name = el.getAttribute('data-skill-chip-name') || '';
                if (action === 'toggle') {
                    if (!name || name === INHERIT_SENTINEL) return;
                    commit(applyChipToggle(current, name));
                } else if (action === 'remove') {
                    if (!name) return;
                    commit(applyChipRemove(current, name));
                } else if (action === 'add-inherit') {
                    commit(applyChipAdd(current, INHERIT_SENTINEL));
                } else if (action === 'open-add') {
                    const select = host.querySelector('[data-skill-chip-add-select]');
                    if (!select) return;
                    const chosen = String(select.value || '').trim();
                    if (!chosen) return;
                    commit(applyChipAdd(current, chosen));
                }
            });
        });

        // One-step add: picking from the dropdown commits immediately,
        // so the user never has to chase a separate Add button. The
        // hidden open-add button still works for keyboard-only users.
        const addSelect = host.querySelector('[data-skill-chip-add-select]');
        if (addSelect && typeof addSelect.addEventListener === 'function') {
            addSelect.addEventListener('change', (ev) => {
                if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
                const chosen = String(addSelect.value || '').trim();
                if (!chosen) return;
                commit(applyChipAdd(current, chosen));
            });
        }
    }

    render();

    return {
        rerender: render,
        getValue: () => ({ visible: current.visible.slice(), deny: current.deny.slice() }),
    };
}
