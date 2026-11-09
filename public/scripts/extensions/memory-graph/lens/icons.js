// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hand-drawn 24×24 stroke icon set for Memory Lens.

const SVG_NS = 'http://www.w3.org/2000/svg';

const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS = {
    search: `${circle(11, 11, 7)}M20 20l-4-4`,
    x: 'M6 6l12 12M18 6L6 18',
    graph: `${circle(6, 6, 2.5)}${circle(18, 8, 2.5)}${circle(9, 18, 2.5)}M8.4 6.4l7.1.9M6.6 8.4l1.7 7.2M16.4 10l-5.6 6.2`,
    timeline: `M6 3v18${circle(6, 6, 1.6)}${circle(6, 12, 1.6)}${circle(6, 18, 1.6)}M10 6h10M10 12h7M10 18h9`,
    table: 'M4 5h16v14H4zM4 10h16M10 10v9',
    sun: `${circle(12, 12, 4)}M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4`,
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
    refresh: 'M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4',
    chevronLeft: 'M15 6l-6 6 6 6',
    chevronRight: 'M9 6l6 6-6 6',
    chevronDown: 'M6 9l6 6 6-6',
    chevronUp: 'M6 15l6-6 6 6',
    arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
    arrowRight: 'M5 12h14M13 6l6 6-6 6',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    crosshair: `${circle(12, 12, 6)}M12 2v5M12 17v5M2 12h5M17 12h5`,
    filter: 'M4 5h16l-6 7.5V18l-4 2v-7.5z',
    sidebarLeft: 'M4 5h16v14H4zM9.5 5v14',
    sidebarRight: 'M4 5h16v14H4zM14.5 5v14',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
    pin: 'M9 3h6l-1 6.5 3 3V14H7v-1.5l3-3zM12 14v7',
    archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
    user: `${circle(12, 8, 4)}M4.5 20a7.5 7.5 0 0 1 15 0`,
    mapPin: `M12 21s-6.5-5.6-6.5-11.2a6.5 6.5 0 1 1 13 0C18.5 15.4 12 21 12 21z${circle(12, 10, 2.2)}`,
    thread: 'M3 15c3-7 6-7 9 0s6 7 9 0M3 9c3 7 6 7 9 0s6-7 9 0',
    bolt: 'M13 2L4.5 13.5H11L10 22l8.5-11.5H12z',
    clock: `${circle(12, 12, 9)}M12 7v5l3 2`,
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.1 1.1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.1-1.1',
    quote: 'M6 7h4v4c0 3.5-1.7 5.3-4 6M14 7h4v4c0 3.5-1.7 5.3-4 6',
    hexagon: 'M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z',
    doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
    keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
    target: `${circle(12, 12, 8.5)}${circle(12, 12, 4.5)}${circle(12, 12, 0.8)}`,
    eye: `M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z${circle(12, 12, 3)}`,
    lens: `${circle(9, 12, 6.2)}${circle(15, 12, 6.2)}`,
    blocks: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    grip: `${circle(9, 6, 1)}${circle(15, 6, 1)}${circle(9, 12, 1)}${circle(15, 12, 1)}${circle(9, 18, 1)}${circle(15, 18, 1)}`,
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    gauge: 'M4 18a8 8 0 1 1 16 0M12 18l4-6M7.5 13.5l-1-1M12 10V8.5M16.5 13.5l1-1',
    download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    upload: 'M12 15V4M7 9l5-5 5 5M5 20h14',
    arrowUp: 'M12 19V5M6 11l6-6 6 6',
    arrowDown: 'M12 5v14M6 13l6 6 6-6',
    alert: `${circle(12, 12, 9)}M12 7.5v5.5M12 16.5v.01`,
    gear: `M4 7h9M17 7h3M4 17h3M11 17h9${circle(15, 7, 2)}${circle(9, 17, 2)}`,
};

export function icon(name, { size = 16, className = '', label = '' } = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', `mlens-icon ${className}`.trim());
    if (label) {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', label);
    } else {
        svg.setAttribute('aria-hidden', 'true');
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', PATHS[name] || PATHS.hexagon);
    svg.appendChild(path);
    return svg;
}
