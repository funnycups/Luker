// Tiny DOM helpers shared by all per-mode renderers. Keeps the
// individual renderers focused on structure and path strings.

export function jsonOrText(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
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
        if (opts.collapsedByDefault) sec.classList.add('luker-sim-section--collapsed');
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
        if (opts.collapsedByDefault) sec.classList.add('luker-sim-section--collapsed');
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
        if (opts.collapsedByDefault) sec.classList.add('luker-sim-section--collapsed');
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
