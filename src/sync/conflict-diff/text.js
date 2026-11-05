/**
 * Text conflict grouping.
 *
 * A text file is a list of changed blocks. A single-line file is one
 * value instead: a line map of one enormous line is not readable, and a
 * cell page can continue by character offset.
 */

import { lineHunks, lineRows, withContext } from './values.js';

/**
 * @param {string} leftText
 * @param {string} rightText
 * @param {ReturnType<import('./tree.js').createBuilder>} builder
 */
export function renderText(leftText, rightText, builder) {
    const left = String(leftText ?? '');
    const right = String(rightText ?? '');
    if (left === right) return [];

    if (!left.includes('\n') && !right.includes('\n')) {
        return [builder.section({
            label: 'Changes',
            translateLabel: true,
            children: [builder.field({
                label: 'Content',
                translateLabel: true,
                status: 'changed',
                before: left,
                after: right,
            })],
        })];
    }

    const hunks = lineHunks(withContext(lineRows(left, right)));
    if (hunks.length === 0) return [];
    return [builder.section({
        label: 'Changes',
        translateLabel: true,
        children: hunks.map(hunk => builder.lines({
            label: 'Lines',
            translateLabel: true,
            status: 'changed',
            lines: hunk.lines,
            rows: hunk.rows,
        })),
    })];
}
