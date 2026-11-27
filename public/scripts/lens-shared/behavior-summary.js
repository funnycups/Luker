// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Live Behavioral Summary engine shared by Lens surfaces and classic
// SillyTavern drawers/popups. All text goes through textContent /
// createTextNode — never innerHTML.

import { h, clear, put, prefersReducedMotion, findLocalScrollContainer, scrollChildIntoView } from './util.js';

const PLACEHOLDER_RE = /\$\{([^{}]+)\}/g;
const FOCUSABLE_SELECTOR = 'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

// Matches @keyframes luker-bsum-pulse (1.2s) in public/css/luker-studio.css.
const PULSE_DURATION_MS = 1200;

const VALID_MOUNT_POSITIONS = new Set(['prepend', 'append', 'before', 'after']);

const TOKEN_META = new WeakMap();
const MOUNTED_CLEANUPS = new WeakMap();

function escapeAttrValue(value) {
    const str = String(value);
    if (typeof globalThis.CSS?.escape === 'function') {
        return globalThis.CSS.escape(str);
    }
    return str.replace(/["\\]/g, '\\$&');
}

function normalizeFields(raw) {
    if (raw === null || raw === undefined || raw === false) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out = [];
    for (const item of list) {
        const key = String(item ?? '').trim();
        if (key && !out.includes(key)) out.push(key);
    }
    return out;
}

function getTokenMeta(tokenEl) {
    const cached = TOKEN_META.get(tokenEl);
    if (cached) return cached;
    const rawFields = tokenEl.dataset?.bsumFields || '';
    const fields = rawFields
        ? rawFields.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    return { fields, onActivate: null };
}

function defaultResolveField(fieldKey, scopeEl) {
    if (!scopeEl || !fieldKey) return [];
    const selector = `[data-field-key="${escapeAttrValue(fieldKey)}"]`;
    const matches = [];
    if (scopeEl.matches?.(selector)) matches.push(scopeEl);
    matches.push(...scopeEl.querySelectorAll(selector));
    return matches;
}

function normalizeResolvedEntries(raw) {
    if (!raw) return [];
    const list = (Array.isArray(raw) || raw instanceof NodeList) ? Array.from(raw) : [raw];
    const entries = [];
    for (const item of list) {
        if (!item) continue;
        if (item instanceof Element) {
            entries.push({ control: item, highlight: item });
        } else if (item.control instanceof Element) {
            entries.push({
                control: item.control,
                highlight: item.highlight instanceof Element ? item.highlight : item.control,
            });
        }
    }
    return entries;
}

function isInsideElementGroup(elements, node) {
    if (!(node instanceof Node)) return false;
    for (const el of elements) {
        if (el === node || el.contains(node)) return true;
    }
    return false;
}

function isDisplayNone(el) {
    if (!el) return false;
    if (el.hidden) return true;
    if (el.style?.display === 'none') return true;
    const computed = globalThis.getComputedStyle?.(el);
    return computed?.display === 'none';
}

function expandCollapsedAncestors(targetEl) {
    const ancestors = [];
    for (let node = targetEl?.parentElement || null; node; node = node.parentElement) {
        ancestors.push(node);
    }
    // Expand outermost collapsed containers first so nested sections stay reachable.
    ancestors.reverse();
    for (const node of ancestors) {
        if (node.tagName === 'DETAILS' && !node.open) {
            node.open = true;
        }
        if (node.classList?.contains('inline-drawer')) {
            const content = node.querySelector(':scope > .inline-drawer-content');
            if (content && content.contains(targetEl) && isDisplayNone(content)) {
                const toggle = node.querySelector(':scope > .inline-drawer-toggle, :scope > .inline-drawer-header .inline-drawer-toggle');
                toggle?.click();
            }
        }
        if (node.classList?.contains('drawer')) {
            const content = node.querySelector(':scope > .drawer-content');
            if (content && content.contains(targetEl) && content.classList.contains('closedDrawer')) {
                const toggle = node.querySelector(':scope > .drawer-toggle');
                toggle?.click();
                if (content.classList.contains('closedDrawer')) {
                    content.classList.remove('closedDrawer');
                    content.classList.add('openDrawer');
                }
            }
        }
    }
}

/**
 * Creates a reusable controller for cross-drawer behavior-summary jumps:
 * expands collapsed ancestor containers (`<details>`, `.inline-drawer`, `.drawer`),
 * scrolls the target control into view, focuses it, and plays the shared
 * `luker-bsum-field-pulse` highlight animation with automatic timer cleanup.
 *
 * @returns {{ focus: (targetEl: Element | null, options?: { highlightEl?: Element | null, select?: boolean }) => boolean, clear: () => void }}
 */
export function createExternalFieldFocuser() {
    let pulseTarget = null;
    let pulseTimer = null;

    function clear() {
        if (pulseTimer !== null) {
            clearTimeout(pulseTimer);
            pulseTimer = null;
        }
        if (pulseTarget) {
            pulseTarget.classList.remove('luker-bsum-field-pulse');
            pulseTarget = null;
        }
    }

    function focus(targetEl, { highlightEl = null, select = false } = {}) {
        if (!(targetEl instanceof Element)) return false;
        expandCollapsedAncestors(targetEl);
        const wrapper = highlightEl instanceof Element ? highlightEl : targetEl;
        const boundary = wrapper.closest?.('.wbench, .mlens, .olens, .dw-layer, .drawer-content, .popup') || null;
        const scroller = findLocalScrollContainer(wrapper, boundary);
        if (scroller) {
            scrollChildIntoView(scroller, wrapper, {
                behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                block: 'nearest',
            });
        } else if (typeof wrapper.scrollIntoView === 'function') {
            wrapper.scrollIntoView({
                behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                block: 'nearest',
            });
        }
        const focusable = resolveFocusable(targetEl) || targetEl;
        if (typeof focusable.focus === 'function') {
            focusable.focus({ preventScroll: true });
        }
        if (select && typeof focusable.select === 'function') {
            focusable.select();
        }
        clear();
        void wrapper.offsetWidth;
        wrapper.classList.add('luker-bsum-field-pulse');
        pulseTarget = wrapper;
        pulseTimer = setTimeout(() => {
            clear();
        }, PULSE_DURATION_MS);
        return true;
    }

    return { focus, clear };
}

function resolveFocusable(targetEl) {
    if (!(targetEl instanceof Element)) return null;
    if (targetEl.matches(FOCUSABLE_SELECTOR)) return targetEl;
    return targetEl.querySelector(FOCUSABLE_SELECTOR)
        || (targetEl.matches('input, select, textarea, button') ? targetEl : null);
}

function queryAllInRoot(root, selector) {
    const out = [];
    if (root.matches?.(selector)) out.push(root);
    for (const el of root.querySelectorAll(selector)) {
        if (!out.includes(el)) out.push(el);
    }
    return out;
}

function resolveMountEntry(spec, root) {
    const isDescriptor = Boolean(spec) && typeof spec === 'object' && !Array.isArray(spec);
    const rawSelectors = isDescriptor ? spec.selector : spec;
    const selectors = Array.isArray(rawSelectors)
        ? rawSelectors
        : (rawSelectors ? [rawSelectors] : []);
    const highlightSel = isDescriptor && spec.highlight ? String(spec.highlight) : '';

    const controls = [];
    for (const sel of selectors) {
        if (!sel) continue;
        for (const match of queryAllInRoot(root, String(sel))) {
            if (!controls.includes(match)) controls.push(match);
        }
    }

    if (!highlightSel) {
        return controls.map((el) => ({ control: el, highlight: el }));
    }

    const entries = [];
    for (const control of controls) {
        const ancestor = control.closest(highlightSel);
        if (ancestor) {
            entries.push({ control, highlight: ancestor });
        } else {
            const hlMatches = queryAllInRoot(root, highlightSel);
            if (hlMatches.length > 0) {
                for (const hl of hlMatches) entries.push({ control, highlight: hl });
            } else {
                entries.push({ control, highlight: control });
            }
        }
    }
    return entries;
}

/**
 * Splits a template string into Text nodes and interactive/read-only token elements.
 * Throws loudly when any `${key}` placeholder lacks an own non-nullish entry in `tokens`.
 *
 * @param {string} template
 * @param {Record<string, object|string|number|boolean>} [tokens]
 * @returns {Array<Text|HTMLButtonElement|HTMLSpanElement>}
 */
export function renderTemplateParts(template, tokens = {}) {
    if (typeof template !== 'string') {
        throw new TypeError('behavior-summary: template must be a string');
    }

    const parts = [];
    let lastIndex = 0;
    PLACEHOLDER_RE.lastIndex = 0;

    let match;
    while ((match = PLACEHOLDER_RE.exec(template)) !== null) {
        if (match.index > lastIndex) {
            parts.push(document.createTextNode(template.slice(lastIndex, match.index)));
        }

        const key = match[1];
        if (!tokens || typeof tokens !== 'object' || !Object.hasOwn(tokens, key) || tokens[key] === undefined || tokens[key] === null) {
            throw new Error(`behavior-summary: missing token "${key}"`);
        }

        const rawToken = tokens[key];
        const token = (typeof rawToken === 'object') ? rawToken : { text: String(rawToken) };
        const text = String(token.text ?? '');
        const tone = token.tone ? String(token.tone).trim() : '';
        const fields = normalizeFields(token.fields !== undefined ? token.fields : token.field);
        const onActivate = typeof token.onActivate === 'function' ? token.onActivate : null;
        const interactive = fields.length > 0 || Boolean(onActivate);

        const className = [
            'luker-bsum-tok',
            tone ? `is-${tone}` : '',
            interactive ? '' : 'is-readonly',
        ].filter(Boolean).join(' ');

        const commonProps = {
            class: className,
            title: token.title ? String(token.title) : null,
            'aria-label': token.ariaLabel ? String(token.ariaLabel) : null,
            text,
        };

        if (interactive) {
            const btn = h('button', {
                type: 'button',
                ...commonProps,
                dataset: fields.length > 0 ? { bsumFields: fields.join(',') } : null,
            });
            TOKEN_META.set(btn, { fields, onActivate });
            parts.push(btn);
        } else {
            parts.push(h('span', commonProps));
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < template.length) {
        parts.push(document.createTextNode(template.slice(lastIndex)));
    }

    return parts;
}

/**
 * Creates a live Style A behavioral summary card with bidirectional hover/focus
 * highlighting, dormant field dimming, and click-to-jump control focusing.
 *
 * @param {object} opts
 * @param {string} [opts.id]
 * @param {() => object} opts.build
 * @param {Element|null} [opts.scopeEl]
 * @param {(fieldKey: string, scopeEl: Element) => any} [opts.resolveField]
 * @param {(fields: string[], event: Event) => boolean|void} [opts.onTokenActivate]
 * @param {string} [opts.ariaLabel]
 */
export function createBehaviorSummary({
    id = '',
    build,
    scopeEl = null,
    resolveField = defaultResolveField,
    onTokenActivate = null,
    ariaLabel = '',
} = {}) {
    if (typeof build !== 'function') {
        throw new TypeError('behavior-summary: createBehaviorSummary requires a build function');
    }

    const rowsEl = h('div', { class: 'luker-bsum-rows' });
    const warningsEl = h('div', { class: 'luker-bsum-warnings', role: 'status', hidden: true });

    const el = h('div', {
        class: 'luker-bsum is-active',
        dataset: id ? { bsumId: String(id) } : null,
        role: ariaLabel ? 'region' : null,
        'aria-label': ariaLabel || null,
    }, rowsEl, warningsEl);

    let currentScopeEl = null;
    let scopeAbort = null;
    let destroyed = false;

    const cardAbort = new AbortController();
    const scopeHoverFields = new Set();
    const summaryHoverFields = new Set();
    const scopeFocusFields = new Set();
    const summaryFocusFields = new Set();

    const appliedLinkedEls = new Set();
    const appliedDormantEls = new Set();
    const pulseTimers = new Map();

    let fieldTargetsCache = new Map();
    let hoverGroupsCache = new Map();
    let renderedTokenEls = [];
    let renderedFieldKeys = new Set();
    let lastDormantFields = [];

    function clearPulseTimers() {
        for (const [targetEl, timerId] of pulseTimers) {
            clearTimeout(timerId);
            targetEl.classList.remove('luker-bsum-field-pulse');
        }
        pulseTimers.clear();
    }

    function clearLinkedClasses() {
        for (const targetEl of appliedLinkedEls) {
            targetEl.classList.remove('luker-bsum-field-linked');
        }
        appliedLinkedEls.clear();
    }

    function clearDormantClasses() {
        for (const targetEl of appliedDormantEls) {
            targetEl.classList.remove('luker-bsum-field-dormant');
        }
        appliedDormantEls.clear();
    }

    function resolveTargetsForKeys(keys) {
        const map = new Map();
        if (!currentScopeEl) return map;
        for (const key of keys) {
            if (!key) continue;
            const entries = normalizeResolvedEntries(resolveField(key, currentScopeEl));
            if (entries.length > 0) map.set(key, entries);
        }
        return map;
    }

    function rebuildFieldCache() {
        const allKeys = new Set([...renderedFieldKeys, ...lastDormantFields]);
        fieldTargetsCache = resolveTargetsForKeys(allKeys);
        hoverGroupsCache = new Map();
        for (const key of renderedFieldKeys) {
            const entries = fieldTargetsCache.get(key);
            if (!entries) continue;
            const group = new Set();
            for (const entry of entries) {
                group.add(entry.control);
                group.add(entry.highlight);
            }
            hoverGroupsCache.set(key, group);
        }
    }

    function applyDormantClasses() {
        clearDormantClasses();
        if (!currentScopeEl || lastDormantFields.length === 0) return;
        for (const key of lastDormantFields) {
            const entries = fieldTargetsCache.get(key);
            if (!entries) continue;
            for (const entry of entries) {
                entry.highlight.classList.add('luker-bsum-field-dormant');
                appliedDormantEls.add(entry.highlight);
            }
        }
    }

    function syncHighlights() {
        clearLinkedClasses();

        const hasHover = scopeHoverFields.size > 0 || summaryHoverFields.size > 0;
        const activeFields = hasHover
            ? new Set([...scopeHoverFields, ...summaryHoverFields])
            : new Set([...scopeFocusFields, ...summaryFocusFields]);

        for (const rowEl of rowsEl.querySelectorAll('.luker-bsum-row.is-row-hot')) {
            rowEl.classList.remove('is-row-hot');
        }

        const matchedFields = new Set();
        for (const tokEl of renderedTokenEls) {
            const { fields } = getTokenMeta(tokEl);
            const matched = fields.filter((key) => activeFields.has(key));
            const isHot = matched.length > 0;
            tokEl.classList.toggle('is-hot', isHot);
            if (isHot) {
                tokEl.closest('.luker-bsum-row')?.classList.add('is-row-hot');
                for (const key of matched) matchedFields.add(key);
            }
        }

        for (const key of matchedFields) {
            const entries = fieldTargetsCache.get(key);
            if (!entries) continue;
            for (const entry of entries) {
                entry.highlight.classList.add('luker-bsum-field-linked');
                appliedLinkedEls.add(entry.highlight);
            }
        }
    }

    function applyPulse(targetEl) {
        const existing = pulseTimers.get(targetEl);
        if (existing !== undefined) clearTimeout(existing);
        targetEl.classList.remove('luker-bsum-field-pulse');
        // Force style flush so re-clicking the same token restarts the CSS animation.
        void targetEl.offsetWidth;
        targetEl.classList.add('luker-bsum-field-pulse');
        const timerId = setTimeout(() => {
            pulseTimers.delete(targetEl);
            targetEl.classList.remove('luker-bsum-field-pulse');
        }, PULSE_DURATION_MS);
        pulseTimers.set(targetEl, timerId);
    }

    function activateToken(tokenEl, event) {
        const { fields, onActivate } = getTokenMeta(tokenEl);
        if (typeof onActivate === 'function' && onActivate(fields, event) === true) {
            return;
        }
        if (typeof onTokenActivate === 'function' && onTokenActivate(fields, event) === true) {
            return;
        }
        if (!currentScopeEl || fields.length === 0) return;

        const entries = [];
        for (const key of fields) {
            const resolved = fieldTargetsCache.get(key) || normalizeResolvedEntries(resolveField(key, currentScopeEl));
            for (const entry of resolved) entries.push(entry);
        }
        if (entries.length === 0) return;

        let primaryFocusTarget = null;
        let primaryScrollTarget = null;
        for (const entry of entries) {
            expandCollapsedAncestors(entry.control);
            if (!primaryScrollTarget) primaryScrollTarget = entry.control;
            if (!primaryFocusTarget) primaryFocusTarget = resolveFocusable(entry.control);
        }

        const scrollTarget = primaryFocusTarget || primaryScrollTarget;
        if (scrollTarget) {
            const boundary = currentScopeEl?.closest?.('.wbench, .mlens, .olens, .dw-layer, .drawer-content, .popup') || null;
            const scroller = findLocalScrollContainer(scrollTarget, boundary);
            scrollChildIntoView(scroller, scrollTarget, {
                behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                block: 'nearest',
            });
        }
        if (typeof primaryFocusTarget?.focus === 'function') {
            primaryFocusTarget.focus({ preventScroll: true });
        }

        for (const entry of entries) {
            applyPulse(entry.highlight);
        }
    }

    function syncScopeFocusFromActiveElement() {
        scopeFocusFields.clear();
        if (!currentScopeEl) return;
        const activeEl = document.activeElement;
        if (!activeEl || !currentScopeEl.contains(activeEl)) return;
        for (const [key, group] of hoverGroupsCache) {
            if (isInsideElementGroup(group, activeEl)) scopeFocusFields.add(key);
        }
    }

    function syncSummaryFocusFromActiveElement() {
        summaryFocusFields.clear();
        const activeEl = document.activeElement;
        if (!(activeEl instanceof Element) || !el.contains(activeEl)) return;
        const tokEl = activeEl.closest('button.luker-bsum-tok');
        if (!tokEl || !el.contains(tokEl)) return;
        for (const key of getTokenMeta(tokEl).fields) {
            summaryFocusFields.add(key);
        }
    }

    function attachScopeListeners(scope) {
        const controller = new AbortController();
        const { signal } = controller;

        const onScopeEnter = (event) => {
            let changed = false;
            for (const [key, group] of hoverGroupsCache) {
                if (isInsideElementGroup(group, event.target) && !isInsideElementGroup(group, event.relatedTarget)) {
                    if (!scopeHoverFields.has(key)) {
                        scopeHoverFields.add(key);
                        changed = true;
                    }
                }
            }
            if (changed) syncHighlights();
        };

        const onScopeLeave = (event) => {
            let changed = false;
            for (const [key, group] of hoverGroupsCache) {
                if (isInsideElementGroup(group, event.target) && !isInsideElementGroup(group, event.relatedTarget)) {
                    if (scopeHoverFields.delete(key)) changed = true;
                }
            }
            if (changed) syncHighlights();
        };

        const onScopeFocusIn = (event) => {
            scopeFocusFields.clear();
            for (const [key, group] of hoverGroupsCache) {
                if (isInsideElementGroup(group, event.target)) scopeFocusFields.add(key);
            }
            syncHighlights();
        };

        const onScopeFocusOut = (event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && scope.contains(next)) {
                scopeFocusFields.clear();
                for (const [key, group] of hoverGroupsCache) {
                    if (isInsideElementGroup(group, next)) scopeFocusFields.add(key);
                }
            } else {
                scopeFocusFields.clear();
            }
            syncHighlights();
        };

        scope.addEventListener('pointerenter', onScopeEnter, { capture: true, signal });
        scope.addEventListener('mouseenter', onScopeEnter, { capture: true, signal });
        scope.addEventListener('pointerleave', onScopeLeave, { capture: true, signal });
        scope.addEventListener('mouseleave', onScopeLeave, { capture: true, signal });
        scope.addEventListener('focusin', onScopeFocusIn, { signal });
        scope.addEventListener('focusout', onScopeFocusOut, { signal });

        return controller;
    }

    function attachCardListeners() {
        const { signal } = cardAbort;

        const onTokenEnter = (event) => {
            const tokEl = event.target instanceof Element ? event.target.closest('button.luker-bsum-tok') : null;
            if (!tokEl || !el.contains(tokEl)) return;
            summaryHoverFields.clear();
            for (const key of getTokenMeta(tokEl).fields) summaryHoverFields.add(key);
            syncHighlights();
        };

        const onTokenLeave = (event) => {
            const tokEl = event.target instanceof Element ? event.target.closest('button.luker-bsum-tok') : null;
            if (!tokEl || !el.contains(tokEl)) return;
            if (event.relatedTarget instanceof Node && tokEl.contains(event.relatedTarget)) return;
            summaryHoverFields.clear();
            syncHighlights();
        };

        const onTokenFocusIn = (event) => {
            const tokEl = event.target instanceof Element ? event.target.closest('button.luker-bsum-tok') : null;
            if (!tokEl || !el.contains(tokEl)) return;
            summaryFocusFields.clear();
            for (const key of getTokenMeta(tokEl).fields) summaryFocusFields.add(key);
            syncHighlights();
        };

        const onTokenFocusOut = (event) => {
            const next = event.relatedTarget;
            const nextTok = next instanceof Element && el.contains(next) ? next.closest('button.luker-bsum-tok') : null;
            summaryFocusFields.clear();
            if (nextTok) {
                for (const key of getTokenMeta(nextTok).fields) summaryFocusFields.add(key);
            }
            syncHighlights();
        };

        const onCardClick = (event) => {
            const tokEl = event.target instanceof Element ? event.target.closest('button.luker-bsum-tok') : null;
            if (!tokEl || !el.contains(tokEl)) return;
            activateToken(tokEl, event);
        };

        el.addEventListener('pointerenter', onTokenEnter, { capture: true, signal });
        el.addEventListener('mouseenter', onTokenEnter, { capture: true, signal });
        el.addEventListener('pointerleave', onTokenLeave, { capture: true, signal });
        el.addEventListener('mouseleave', onTokenLeave, { capture: true, signal });
        el.addEventListener('focusin', onTokenFocusIn, { signal });
        el.addEventListener('focusout', onTokenFocusOut, { signal });
        el.addEventListener('click', onCardClick, { signal });
    }

    function renderWarningNode(item) {
        if (typeof item === 'string') {
            return h('div', { class: 'luker-bsum-warn is-warn', text: item });
        }
        const severity = String(item.severity || item.tone || 'warn').trim() || 'warn';
        const content = item.template !== undefined
            ? renderTemplateParts(item.template, item.tokens)
            : document.createTextNode(String(item.text ?? ''));
        return h('div', { class: `luker-bsum-warn is-${severity}` }, content);
    }

    function refreshScopeBindings() {
        rebuildFieldCache();
        for (const key of scopeHoverFields) {
            if (!hoverGroupsCache.has(key)) scopeHoverFields.delete(key);
        }
        syncScopeFocusFromActiveElement();
        syncSummaryFocusFromActiveElement();
        applyDormantClasses();
        syncHighlights();
    }

    function update() {
        if (destroyed) return;
        const model = build() || {};
        const tone = String(model.tone || 'active').trim() || 'active';
        el.className = `luker-bsum is-${tone}`;

        const rows = Array.isArray(model.rows) ? model.rows.filter(Boolean) : [];
        const warnings = Array.isArray(model.warnings) ? model.warnings.filter(Boolean) : [];
        lastDormantFields = normalizeFields(model.dormantFields);

        clear(rowsEl);
        for (const row of rows) {
            const content = row.template !== undefined
                ? renderTemplateParts(row.template, row.tokens)
                : document.createTextNode(String(row.text ?? ''));
            const rowTone = row.tone ? String(row.tone).trim() : '';
            const rowClass = rowTone ? `luker-bsum-row is-${rowTone}` : 'luker-bsum-row';
            put(rowsEl, h('div', { class: rowClass },
                h('span', { class: 'luker-bsum-role', text: String(row.role ?? '') }),
                h('div', { class: 'luker-bsum-text' }, content)));
        }

        clear(warningsEl);
        for (const warn of warnings) {
            put(warningsEl, renderWarningNode(warn));
        }
        warningsEl.hidden = warnings.length === 0;

        renderedTokenEls = Array.from(el.querySelectorAll('button.luker-bsum-tok'));
        renderedFieldKeys = new Set();
        for (const tokEl of renderedTokenEls) {
            for (const key of getTokenMeta(tokEl).fields) {
                renderedFieldKeys.add(key);
            }
        }

        summaryHoverFields.clear();
        refreshScopeBindings();
    }

    function bindScope(nextScopeEl) {
        if (destroyed) return;
        scopeAbort?.abort();
        scopeAbort = null;
        scopeHoverFields.clear();
        scopeFocusFields.clear();
        clearLinkedClasses();
        clearDormantClasses();
        clearPulseTimers();

        currentScopeEl = nextScopeEl instanceof Element ? nextScopeEl : null;
        if (currentScopeEl) {
            scopeAbort = attachScopeListeners(currentScopeEl);
        }

        refreshScopeBindings();
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        cardAbort.abort();
        scopeAbort?.abort();
        scopeAbort = null;
        scopeHoverFields.clear();
        summaryHoverFields.clear();
        scopeFocusFields.clear();
        summaryFocusFields.clear();
        clearLinkedClasses();
        clearDormantClasses();
        clearPulseTimers();
        fieldTargetsCache.clear();
        hoverGroupsCache.clear();
    }

    attachCardListeners();
    bindScope(scopeEl);
    update();

    return { el, update, bindScope, destroy };
}

/**
 * Mounts an idempotent live behavioral summary card into an existing DOM container
 * (such as a classic SillyTavern settings drawer or popup) and keeps it synced
 * with form control events.
 *
 * @param {object} opts
 * @param {string} opts.id
 * @param {Element} opts.root
 * @param {Element} opts.anchor
 * @param {'prepend'|'append'|'before'|'after'} [opts.position]
 * @param {Record<string, string|string[]|{ selector: string|string[], highlight?: string }>} [opts.fields]
 * @param {(root: Element) => any} opts.readState
 * @param {(state: any) => object} opts.build
 * @param {(fields: string[], event: Event) => boolean|void} [opts.onTokenActivate]
 * @param {string[]} [opts.events]
 * @param {string} [opts.ariaLabel]
 */
export function mountBehaviorSummary({
    id,
    root,
    anchor,
    position = 'prepend',
    fields = {},
    readState,
    build,
    onTokenActivate = null,
    events = ['input', 'change'],
    ariaLabel = '',
} = {}) {
    if (!id || typeof id !== 'string') {
        throw new Error('behavior-summary: mountBehaviorSummary requires a non-empty string id');
    }
    if (!(root instanceof Element)) {
        throw new Error('behavior-summary: mountBehaviorSummary requires a root Element');
    }
    if (!(anchor instanceof Element)) {
        throw new Error('behavior-summary: mountBehaviorSummary requires an anchor Element');
    }
    if (typeof readState !== 'function' || typeof build !== 'function') {
        throw new TypeError('behavior-summary: mountBehaviorSummary requires readState and build functions');
    }
    if (!VALID_MOUNT_POSITIONS.has(position)) {
        throw new Error(`behavior-summary: invalid mount position "${position}"`);
    }

    const dupSelector = `.luker-bsum[data-bsum-id="${escapeAttrValue(id)}"]`;
    const priorEls = new Set(root.querySelectorAll(dupSelector));
    if (anchor.parentElement) {
        for (const el of anchor.parentElement.querySelectorAll(dupSelector)) {
            priorEls.add(el);
        }
    }
    for (const priorEl of priorEls) {
        MOUNTED_CLEANUPS.get(priorEl)?.();
        priorEl.remove();
    }

    let latestState = readState(root);
    let destroyed = false;

    const summary = createBehaviorSummary({
        id,
        scopeEl: root,
        ariaLabel,
        onTokenActivate,
        resolveField: (fieldKey, scope) => {
            if (!Object.hasOwn(fields, fieldKey)) return [];
            return resolveMountEntry(fields[fieldKey], scope);
        },
        build: () => build(latestState),
    });

    anchor[position](summary.el);

    const eventAbort = new AbortController();
    const refresh = () => {
        if (destroyed) return;
        latestState = readState(root);
        summary.update();
    };

    const eventList = Array.isArray(events) ? events : ['input', 'change'];
    for (const evtName of eventList) {
        if (evtName) {
            root.addEventListener(String(evtName), refresh, { signal: eventAbort.signal });
        }
    }

    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        eventAbort.abort();
        summary.destroy();
        summary.el.remove();
    };

    MOUNTED_CLEANUPS.set(summary.el, destroy);

    return { el: summary.el, refresh, destroy };
}
