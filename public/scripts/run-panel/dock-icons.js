// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hand-drawn 24×24 stroke icon set for the shared Run Dock.

const SVG_NS = 'http://www.w3.org/2000/svg';

const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS = {
    search: `${circle(11, 11, 7)}M20 20l-4-4`,
    x: 'M6 6l12 12M18 6L6 18',
    chevronLeft: 'M15 6l-6 6 6 6',
    chevronRight: 'M9 6l6 6-6 6',
    chevronDown: 'M6 9l6 6 6-6',
    chevronUp: 'M6 15l6-6 6 6',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    minus: 'M5 12h14',
    fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
    more: `${circle(5.5, 12, 1.2)}${circle(12, 12, 1.2)}${circle(18.5, 12, 1.2)}`,
    external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    user: `${circle(12, 8, 4)}M4.5 20a7.5 7.5 0 0 1 15 0`,
    bolt: 'M13 2L4.5 13.5H11L10 22l8.5-11.5H12z',
    clock: `${circle(12, 12, 9)}M12 7v5l3 2`,
    hexagon: 'M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z',
    doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
    target: `${circle(12, 12, 8.5)}${circle(12, 12, 4.5)}${circle(12, 12, 0.8)}`,
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    plus: 'M12 5v14M5 12h14',
    alert: `${circle(12, 12, 9)}M12 7.5v5.5M12 16.5v.01`,
    play: 'M8 5.5v13l10.5-6.5z',
    stop: 'M7 7h10v10H7z',
    conductor: 'M4 20l9-9M15.5 3.5l5 5M13 6l5 5-3.5 3.5-5-5z',
    tool: 'M14.5 4.5a4.5 4.5 0 0 0-5.6 5.6L4 15v5h5l4.9-4.9a4.5 4.5 0 0 0 5.6-5.6l-2.8 2.8-3-3z',
    review: 'M4 5h11M4 10h7M4 15h5M13.5 16.5l2.5 2.5 4.5-5',
    capsule: 'M8.5 4h7a4.5 4.5 0 0 1 0 9h-7a4.5 4.5 0 0 1 0-9zM12 4v9M7 17h10M9 20.5h6',
    pen: 'M4 20l1-4.5L16 4.5l3.5 3.5L8.5 19zM14 7l3.5 3.5',
    repeat: 'M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4',
    brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3V4zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3V4z',
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
    svg.setAttribute('class', `rp-icon ${className}`.trim());
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
