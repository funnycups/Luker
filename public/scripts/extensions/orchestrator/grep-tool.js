/**
 * grep-tool.js — shared regex search engine for orchestrator search tools.
 *
 * Each search tool (draft_search, chat_search, lorebook_search, skill_search)
 * wraps gatherGrepMatches with its own corpus iterator and prefix format.
 *
 * The helper produces grep -n style output:
 *   - For a single-unit corpus with empty prefix: "{lineno}: {line_content}"
 *   - For a multi-unit corpus with non-empty prefix: "{prefix}:{lineno}: {line_content}"
 *
 * Lines containing multiple matches are emitted once (grep default).
 * The scan is line-oriented; multi-line patterns that require literal
 * \n cannot match (split into per-line patterns instead).
 */

/**
 * Run a regex search across a corpus iterator and return grep -n style output.
 *
 * @param {Iterable<{prefix: string, content: string}>} corpusIter
 *   An iterable (array or generator) yielding "units" — one document /
 *   message / file each. `prefix` labels the unit's location for output
 *   (empty string for single-unit corpora). `content` is the unit's text.
 * @param {string} pattern  JavaScript RegExp source.
 * @param {string} [flags='gm']  RegExp flags. 'g' is auto-injected.
 * @returns {{ok: true, output: string} | {ok: false, error: string}}
 */
export function gatherGrepMatches(corpusIter, pattern, flags = 'gm') {
    let normalizedFlags = String(flags || 'gm');
    if (!normalizedFlags.includes('g')) normalizedFlags += 'g';

    let re;
    try {
        re = new RegExp(String(pattern ?? ''), normalizedFlags);
    } catch (err) {
        return {
            ok: false,
            error: `invalid regex: ${err.message}. If searching literal text, escape regex metacharacters.`,
        };
    }

    const outputLines = [];
    for (const unit of corpusIter) {
        if (!unit || typeof unit !== 'object') continue;
        const prefix = String(unit.prefix ?? '');
        const content = String(unit.content ?? '');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            re.lastIndex = 0;
            let match;
            let hit = false;
            while ((match = re.exec(line)) !== null) {
                hit = true;
                // Zero-width match guard — without this, /^/g loops forever
                // because lastIndex doesn't advance.
                if (match[0].length === 0) {
                    re.lastIndex += 1;
                    if (re.lastIndex > line.length) break;
                }
            }
            if (hit) {
                const lineno = i + 1;
                outputLines.push(prefix ? `${prefix}:${lineno}: ${line}` : `${lineno}: ${line}`);
            }
        }
    }

    return { ok: true, output: outputLines.join('\n') };
}
