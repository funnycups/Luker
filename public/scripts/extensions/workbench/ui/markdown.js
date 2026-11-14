// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal, safe Markdown for AI answers: paragraphs, **bold**, `code`,
// bullet / numbered lists and pipe tables. Builds DOM nodes with
// textContent only — never innerHTML (answers are model output).

import { h } from '../../lens-shared/util.js';

function inline(text) {
    const out = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const tok = m[0];
        out.push(tok.startsWith('**') ? h('b', { text: tok.slice(2, -2) }) : h('code', { text: tok.slice(1, -1) }));
        last = m.index + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

export function renderMarkdown(source) {
    const lines = String(source || '').replace(/\r/g, '').split('\n');
    const root = h('div', { class: 'wb-md' });
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }
        if (isRow(line) && isRow(lines[i + 1] || '') && /^[\s|:-]+$/.test(lines[i + 1])) {
            const head = cells(line);
            i += 2;
            const rows = [];
            while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
            root.appendChild(h('div', { class: 'wb-md-table' }, h('table', null,
                h('thead', null, h('tr', null, head.map(c => h('th', null, inline(c))))),
                h('tbody', null, rows.map(r => h('tr', null, r.map(c => h('td', null, inline(c)))))))));
            continue;
        }
        if (/^\s*([-*•]|\d+[.)、])\s+/.test(line)) {
            const ordered = /^\s*\d/.test(line);
            const items = [];
            while (i < lines.length && /^\s*([-*•]|\d+[.)、])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)、])\s+/, ''));
            root.appendChild(h(ordered ? 'ol' : 'ul', null, items.map(t => h('li', null, inline(t)))));
            continue;
        }
        if (/^#{1,4}\s/.test(line)) {
            root.appendChild(h('p', { class: 'wb-md-h' }, inline(line.replace(/^#+\s*/, ''))));
            i++;
            continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() && !isRow(lines[i]) && !/^\s*([-*•]|\d+[.)、])\s+/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) para.push(lines[i++]);
        root.appendChild(h('p', null, inline(para.join('\n'))));
    }
    return root;
}
