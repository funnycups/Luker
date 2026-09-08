/**
 * Shared quote-segment extraction for TTS NPC attribution.
 *
 * The regex order mirrors messageFormatting's <q> replacement in
 * public/script.js (code fences / inline code / <style> first, then the
 * six quote styles) so the qIndex here aligns 1:1 with the <q> node
 * order in the rendered .mes_text DOM.
 */

// Alternation identical to script.js's <q> replacement; capturing groups
// per quote style kept in the same order (p1..p6).
const QUOTE_SCAN_REGEX = /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim;

/**
 * Extract quoted segments from raw text in document order.
 * @param {string} text
 * @returns {Array<{qIndex: number, start: number, end: number, full: string, content: string}>}
 */
export function extractQuoteSegments(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return [];
    }
    const out = [];
    QUOTE_SCAN_REGEX.lastIndex = 0;
    let match;
    while ((match = QUOTE_SCAN_REGEX.exec(text)) !== null) {
        const quoteStyleMatch = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!quoteStyleMatch) {
            continue; // code / style alternative — not a quote segment
        }
        out.push({
            qIndex: out.length,
            start: match.index,
            end: match.index + match[0].length,
            full: match[0],
            content: match[0].slice(1, -1),
        });
    }
    return out;
}

/**
 * Attach qIndex onto parseMessageSegments-shaped dialogue segments by
 * matching segment text against the quote window in cursor order
 * (exact match first, then containment). Segments that do not match any
 * remaining window entry keep qIndex undefined.
 *
 * @param {Array<{type: string, text: string, qIndex?: number}>} segments
 * @param {Array<{qIndex: number, content: string}>} quoteWindow
 */
export function attachQuoteIndices(segments, quoteWindow) {
    if (!Array.isArray(segments) || !Array.isArray(quoteWindow)) {
        return segments;
    }
    let cursor = 0;
    for (const segment of segments) {
        if (!segment || segment.type !== 'dialogue') {
            continue;
        }
        const text = String(segment.text ?? '');
        // exact match from cursor
        let hit = -1;
        for (let i = cursor; i < quoteWindow.length; i++) {
            if (quoteWindow[i].content === text) {
                hit = i;
                break;
            }
        }
        // containment fallback
        if (hit === -1) {
            for (let i = cursor; i < quoteWindow.length; i++) {
                if (quoteWindow[i].content.includes(text) || text.includes(quoteWindow[i].content)) {
                    hit = i;
                    break;
                }
            }
        }
        if (hit !== -1) {
            segment.qIndex = quoteWindow[hit].qIndex;
            cursor = hit + 1;
        }
    }
    return segments;
}
