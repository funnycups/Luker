// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hand-drawn 24×24 stroke icons for the workbench.

const SVG_NS = 'http://www.w3.org/2000/svg';
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS = {
    mark: 'M4 6h7v5H4zM13 6h7v8h-7zM4 13h7v5H4zM13 16h7v2h-7z',
    home: 'M4 11l8-6 8 6v8H4zM10 19v-5h4v5',
    ask: 'M5 5h14v10H10l-4 4v-4H5zM10 9.5a2 2 0 1 1 2.6 1.9c-.4.1-.6.5-.6.9v.2M12 14.2v.01',
    spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    history: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2',
    gear: `M4 7h9M17 7h3M4 17h3M11 17h9${circle(15, 7, 2)}${circle(9, 17, 2)}`,
    memory: `${circle(6, 7, 2.5)}${circle(18, 8, 2.5)}${circle(10, 18, 2.5)}M8.4 7.3l7.1.6M7 9.3l2 6.4M16.6 10.2l-5 5.8`,
    orch: 'M5 5h5v5H5zM14 14h5v5h-5zM7.5 10v4a2 2 0 0 0 2 2H14M16.5 14v-4a2 2 0 0 0-2-2H10',
    preset: `M5 6h14M5 12h14M5 18h14${circle(9, 6, 1.8)}${circle(15, 12, 1.8)}${circle(8, 18, 1.8)}`,
    world: 'M5 4.5h6.5a1.5 1.5 0 0 1 1.5 1.5v14a2 2 0 0 0-2-2H5zM19 4.5h-4.5A1.5 1.5 0 0 0 13 6v14a2 2 0 0 1 2-2h4zM7.5 9h3M7.5 12h3M15.5 9h1.5',
    card: `M6 3h12v18H6z${circle(12, 10, 3)}M8.5 17a3.5 3.5 0 0 1 7 0`,
    globe: `${circle(12, 12, 9)}M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18`,
    sun: `${circle(12, 12, 4)}M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4`,
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
    max: 'M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4',
    restore: 'M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4M8 8h8v8H8z',
    min: 'M6 14h12',
    x: 'M6 6l12 12M18 6L6 18',
    alert: `${circle(12, 12, 9)}M12 7.5v5.5M12 16.5v.01`,
    info: `${circle(12, 12, 9)}M12 11v5M12 7.5v.01`,
    check: 'M5 12.5l4.5 4.5L19 7.5',
    lens: `${circle(9, 12, 6.2)}${circle(15, 12, 6.2)}`,
    chevronDown: 'M6 9l6 6 6-6',
    chevronRight: 'M9 6l6 6-6 6',
    plus: 'M12 5v14M5 12h14',
    eye: `M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z${circle(12, 12, 3)}`,
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    send: 'M5 12h13M13 6l6 6-6 6',
    up: 'M12 19V5M6 11l6-6 6 6',
    doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
    refresh: 'M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    stop: 'M7 7h10v10H7z',
    copy: 'M9 9h10v11H9zM15 9V4H5v11h4',
    fork: `${circle(6, 5, 2)}${circle(18, 5, 2)}${circle(12, 19, 2)}M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5`,
    edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
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
    path.setAttribute('d', PATHS[name] || PATHS.info);
    svg.appendChild(path);
    return svg;
}
