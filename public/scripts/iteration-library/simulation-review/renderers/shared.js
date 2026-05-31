// Tiny DOM helpers shared by all per-mode renderers. Keeps the
// individual renderers focused on structure and path strings.
//
// `opts.collapsedByDefault` (boolean): mark the section as initially
// folded (CSS hides the body) AND tag it `data-collapsible="true"` so
// the popup's "Expand all / Collapse all" toggle can find it. Use this
// for process wrappers (rounds, sub-agent dispatches, tool calls, per-
// step Outputs, Reasoning) — anything the user can drill into but
// doesn't need to see at-a-glance.
// `opts.isFinalOutput` (boolean): tag the section `data-sim-final-
// output="true"` so popup.js can scroll it into view on open. The
// final-output section is the one the user opened the popup for —
// "Final Output" (cea/cpa), "Final Capsule" (spec), "Final Composed
// Output" (agenda), "Capsule" (loop), "Final Message" (director).
// Never collapse this one.

export function jsonOrText(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function applySectionOpts(sec, opts) {
    if (opts.collapsedByDefault) {
        sec.classList.add('luker-sim-section--collapsed');
        sec.setAttribute('data-collapsible', 'true');
    }
    if (opts.isFinalOutput) {
        sec.setAttribute('data-sim-final-output', 'true');
    }
}

export const appendShared = {
    h1(parent, text) {
        const h = document.createElement('h1');
        h.textContent = text;
        parent.appendChild(h);
    },
    section(parent, heading, locPath, opts = {}) {
        const sec = document.createElement('section');
        sec.className = 'luker-sim-section';
        if (locPath) sec.setAttribute('data-loc-path', locPath);
        applySectionOpts(sec, opts);
        const h = document.createElement('h2');
        h.textContent = heading;
        sec.appendChild(h);
        parent.appendChild(sec);
        return sec;
    },
    subsection(parent, heading, locPath, opts = {}) {
        const sec = document.createElement('section');
        sec.className = 'luker-sim-subsection';
        if (locPath) sec.setAttribute('data-loc-path', locPath);
        applySectionOpts(sec, opts);
        const h = document.createElement('h3');
        h.textContent = heading;
        sec.appendChild(h);
        parent.appendChild(sec);
        return sec;
    },
    subsubsection(parent, heading, locPath, opts = {}) {
        const sec = document.createElement('section');
        sec.className = 'luker-sim-subsubsection';
        if (locPath) sec.setAttribute('data-loc-path', locPath);
        applySectionOpts(sec, opts);
        const h = document.createElement('h4');
        h.textContent = heading;
        sec.appendChild(h);
        parent.appendChild(sec);
        return sec;
    },
    pre(parent, text) {
        const pre = document.createElement('pre');
        pre.className = 'luker-sim-pre';
        pre.textContent = String(text ?? '');
        parent.appendChild(pre);
        return pre;
    },
    note(parent, text) {
        const p = document.createElement('p');
        p.className = 'luker-sim-note';
        p.textContent = String(text ?? '');
        parent.appendChild(p);
        return p;
    },
};

/**
 * Append a status chip to a tool-call section header. The chip reflects
 * whether the tool actually ran (live read) or was rewritten by the
 * sim-safe quarantine into a noop / validated stub. The classification
 * comes from the `result` envelope set by loop-tools.js's exec
 * dispatch:
 *   - `result.simulated === true && result.unvalidated === true` →
 *     unvalidated noop fallback (orange). The tool had no simulate()
 *     handler so the orchestrator returned `{ok:true, simulated:true,
 *     unvalidated:true}` without touching state.
 *   - `result.simulated === true` (no `unvalidated`) → validated
 *     simulate path (yellow). The tool's `simulate()` ran args
 *     validation and shape-matched the success envelope.
 *   - otherwise → live read (green). The tool ran end-to-end against
 *     real state.
 *
 * `sectionEl` is the <section> returned by appendShared.subsection /
 * subsubsection; we attach the chip to the heading inside it so it
 * sits on the same line as the tool name and never gets hidden when
 * the section collapses.
 */
export function appendToolStatusChip(sectionEl, result, i18n) {
    if (!sectionEl) return null;
    const heading = sectionEl.querySelector('h1, h2, h3, h4');
    if (!heading) return null;
    const doc = heading.ownerDocument;
    const chip = doc.createElement('span');
    chip.classList.add('sim-review-tool-chip');
    if (result && result.simulated && result.unvalidated) {
        chip.classList.add('sim-review-tool-chip--unvalidated');
        chip.textContent = i18n('sim.tool_status.simulated_unvalidated', 'Simulated (unvalidated)');
    } else if (result && result.simulated) {
        chip.classList.add('sim-review-tool-chip--validated');
        chip.textContent = i18n('sim.tool_status.simulated_validated', 'Simulated (validated)');
    } else {
        chip.classList.add('sim-review-tool-chip--read');
        chip.textContent = i18n('sim.tool_status.read', 'Live read');
    }
    heading.appendChild(chip);
    return chip;
}

/**
 * Append a tool-source chip (e.g. `[ext]` / `[profile]` / `[ST]`) to a
 * tool-call section header so users can tell at a glance which dispatch
 * layer served a given call. Builtin tools — the always-on default
 * surface — get no chip; adding one for them would just be visual noise.
 * Unknown sources (e.g. a name that no layer recognizes — the dispatcher
 * would have surfaced `ToolError(NOT_IMPLEMENTED)`) also get no chip.
 *
 *   - 'profile'   → `[profile]` — per-run Layer-3 customTools[] entry
 *   - 'extension' → `[ext]`     — Layer-2 extension-registered tool
 *   - 'st-bridge' → `[ST]`      — Layer-2 ST-bridged tool
 *   - 'builtin' / undefined → no chip
 *
 * Source labels are technical/developer-facing — three short tags meant
 * to disambiguate "which registry served this call" in a debug-oriented
 * popup. They share the same chip CSS family as `appendToolStatusChip`
 * above (border-radius / sizing match), with their own color variants.
 */
export function appendToolSourceChip(sectionEl, source) {
    if (!sectionEl) return null;
    const safe = String(source || '');
    if (safe !== 'profile' && safe !== 'extension' && safe !== 'st-bridge') return null;
    const heading = sectionEl.querySelector('h1, h2, h3, h4');
    if (!heading) return null;
    const doc = heading.ownerDocument;
    const chip = doc.createElement('span');
    chip.classList.add('sim-review-tool-chip');
    chip.classList.add(`sim-review-tool-chip--source-${safe.replace(/[^a-z0-9]/gi, '-')}`);
    let label;
    if (safe === 'profile') label = '[profile]';
    else if (safe === 'extension') label = '[ext]';
    else label = '[ST]';
    chip.textContent = label;
    chip.setAttribute('title', `tool source: ${safe}`);
    heading.appendChild(chip);
    return chip;
}
