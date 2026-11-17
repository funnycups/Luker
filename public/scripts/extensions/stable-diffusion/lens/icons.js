// SPDX-License-Identifier: AGPL-3.0-or-later

const SVG_NS = 'http://www.w3.org/2000/svg';
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS = {
    image: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 19',
    users: `${circle(9, 8, 3.5)}M2.5 19a6.5 6.5 0 0 1 13 0M16 5a3 3 0 0 1 0 6M21.5 19a5.5 5.5 0 0 0-4.5-5.4`,
    run: 'M8 5.5v13l10.5-6.5z',
    spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    plus: 'M12 5v14M5 12h14',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    refresh: 'M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4',
    search: `${circle(11, 11, 7)}M20 20l-4-4`,
    send: 'M5 12h13M13 6l6 6-6 6',
    stop: 'M7 7h10v10H7z',
    fork: `${circle(6, 5, 2)}${circle(18, 5, 2)}${circle(12, 19, 2)}M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5`,
    check: 'M5 12.5l4.5 4.5L19 7.5',
    x: 'M6 6l12 12M18 6L6 18',
    download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14',
    upload: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14',
    alert: `${circle(12, 12, 9)}M12 7.5v5.5M12 16.5v.01`,
    edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    target: `${circle(12, 12, 8.5)}${circle(12, 12, 4.5)}${circle(12, 12, 0.8)}`,
};

export function icon(name, { size = 16, className = '' } = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', PATHS[name] || PATHS.image);
    svg.appendChild(path);
    return svg;
}
