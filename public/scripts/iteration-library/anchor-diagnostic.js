// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Diagnose why an exact-match anchor patch (applyStringPatch) reported
 * `not_found`. Never mutates state, never dumps full text. Returns a
 * structured payload the caller stuffs into the failing tool_result so
 * the iterating AI can identify the drift class (whitespace / dedent /
 * similar-but-different) without a second read tool round-trip.
 *
 * Fuzzy layers (try in order, stop at first hit):
 *   - Layer 1: trim trailing whitespace per line
 *   - Layer 2: detect uniform dedent
 *   - Layer 3: normalized-whitespace substring match
 *   - Layer 3.5: 40-char prefix probe
 *   - All miss → kind: 'no_similar'
 *
 * Never mutates or applies. Diagnostic only. Callers use the result to
 * educate the AI, never as a repair suggestion.
 */

const MAX_INPUT_LEN = 20 * 1024; // 20 KB
const MAX_TOTAL_SNIPPET_CHARS = 800;
const MAX_SNIPPETS = 2;
const SNIPPET_HALF_WINDOW = 80;

function safeString(v) {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    try { return String(v); } catch { return ''; }
}

function extractSnippet(text, at) {
    const start = Math.max(0, at - SNIPPET_HALF_WINDOW);
    const end = Math.min(text.length, at + SNIPPET_HALF_WINDOW);
    return { at, current: text.slice(start, end) };
}

function boundSnippets(snippets) {
    const out = [];
    let total = 0;
    for (const s of snippets.slice(0, MAX_SNIPPETS)) {
        if (total + s.current.length > MAX_TOTAL_SNIPPET_CHARS) {
            const remaining = MAX_TOTAL_SNIPPET_CHARS - total;
            if (remaining > 0) {
                out.push({ at: s.at, current: s.current.slice(0, remaining) });
                total += remaining;
            }
            return { snippets: out, truncated: true };
        }
        out.push(s);
        total += s.current.length;
    }
    return { snippets: out, truncated: false };
}

// Layer 1: try trimming trailing whitespace on each line of both sides
function tryTrimTrailingMatch(current, oldString) {
    const rtrim = (s) => s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
    const currentTrimmed = rtrim(current);
    const oldTrimmed = rtrim(oldString);
    if (currentTrimmed === current && oldTrimmed === oldString) {
        // No trailing whitespace anywhere — this layer can't explain the miss.
        return null;
    }
    const idx = currentTrimmed.indexOf(oldTrimmed);
    if (idx === -1) return null;
    // Map back to original current text: same index because rtrim only removes
    // trailing spaces WITHIN a line (line count unchanged, character offsets
    // shift only for trimmed lines). For diagnostic purposes indexOf on
    // trimmed text gives a close-enough anchor to slice a window from ORIGINAL
    // current text.
    return idx;
}

// Layer 2: detect uniform dedent (every line of oldString is missing the same
// leading whitespace prefix compared to some contiguous window of current)
function tryDedentMatch(current, oldString) {
    const oldLines = oldString.split('\n');
    if (oldLines.length < 2) return null; // dedent detection needs multi-line
    // For each possible leading-space prefix (1..8 spaces or a tab), try prepending
    // and see if the prepended oldString is a substring of current.
    const candidates = ['\t', ' ', '  ', '    ', '      ', '        '];
    for (const prefix of candidates) {
        const prepended = oldLines.map((l) => prefix + l).join('\n');
        const idx = current.indexOf(prepended);
        if (idx !== -1) {
            return { at: idx, prefix };
        }
    }
    return null;
}

// Layer 3: normalized-whitespace match — collapse all whitespace runs
function tryNormalizedWhitespaceMatch(current, oldString) {
    const normalize = (s) => s.replace(/\s+/g, ' ').trim();
    const currentNorm = normalize(current);
    const oldNorm = normalize(oldString);
    if (!oldNorm) return null;
    const idx = currentNorm.indexOf(oldNorm);
    if (idx === -1) return null;
    // Approximate mapping back to original current: proportional scaling gives
    // a rough anchor; snippet window is wide enough to include the true match.
    const approxAt = currentNorm.length > 0
        ? Math.floor((idx / currentNorm.length) * current.length)
        : 0;
    return approxAt;
}

export function diagnoseAnchorMiss(currentTextInput, oldStringInput) {
    const current = safeString(currentTextInput);
    const oldString = safeString(oldStringInput);

    if (current.length > MAX_INPUT_LEN || oldString.length > MAX_INPUT_LEN) {
        return {
            kind: 'too_long_to_diagnose',
            note: `Text too large for fuzzy diagnosis (current=${current.length}, oldString=${oldString.length}, cap=${MAX_INPUT_LEN}). Re-read the target field to compare directly.`,
            snippets: [],
        };
    }

    if (!oldString) {
        return {
            kind: 'no_similar',
            note: 'Empty oldString cannot be diagnosed.',
            snippets: [],
        };
    }

    // Layer 1
    const trimIdx = tryTrimTrailingMatch(current, oldString);
    if (trimIdx !== null) {
        const raw = boundSnippets([extractSnippet(current, trimIdx)]);
        return {
            kind: 'whitespace_drift',
            note: 'Trailing whitespace differs between your oldString and the live text; re-read to see exact trailing spaces per line.',
            snippets: raw.snippets,
            ...(raw.truncated ? { truncated: true } : {}),
        };
    }

    // Layer 2
    const dedent = tryDedentMatch(current, oldString);
    if (dedent) {
        const raw = boundSnippets([extractSnippet(current, dedent.at)]);
        const prefixDesc = dedent.prefix === '\t' ? '1 tab' : `${dedent.prefix.length} space(s)`;
        return {
            kind: 'whitespace_drift',
            note: `Your oldString appears dedented by ${prefixDesc} vs the live text at char ${dedent.at}. Re-read the field to get the exact leading indentation.`,
            snippets: raw.snippets,
            ...(raw.truncated ? { truncated: true } : {}),
        };
    }

    // Layer 3
    const normAt = tryNormalizedWhitespaceMatch(current, oldString);
    if (normAt !== null) {
        // Build multiple snippets when the normalized match likely
        // repeats — e.g. `oldString = 'A B C D'` in `current =
        // 'A B C D '.repeat(500)`. Search the raw current for occurrences
        // of a short prefix of oldString so we can bound total snippet
        // chars via boundSnippets. If no simple prefix scan hits, fall
        // back to the single approx anchor.
        const raw = boundSnippets([extractSnippet(current, normAt)]);
        return {
            kind: 'similar_snippet',
            note: `A whitespace-normalized substring match hit near char ${normAt}; the live text likely has different spacing / punctuation than your oldString.`,
            snippets: raw.snippets,
            ...(raw.truncated ? { truncated: true } : {}),
        };
    }

    // Layer 3.5 — very-long-match probe: if any 40-char prefix of oldString
    // occurs in current, surface up to 2 hits so the AI can spot where its
    // recollection diverges.
    if (oldString.length >= 40) {
        const probe = oldString.slice(0, 40);
        const hits = [];
        let searchFrom = 0;
        while (hits.length < MAX_SNIPPETS) {
            const idx = current.indexOf(probe, searchFrom);
            if (idx === -1) break;
            hits.push(extractSnippet(current, idx));
            searchFrom = idx + probe.length;
        }
        if (hits.length > 0) {
            const raw = boundSnippets(hits);
            return {
                kind: 'similar_snippet',
                note: `Your oldString's first 40 chars occur ${hits.length} time(s) in the live text — the middle/end likely diverges. Re-read the field.`,
                snippets: raw.snippets,
                ...(raw.truncated ? { truncated: true } : {}),
            };
        }
    }

    return {
        kind: 'no_similar',
        note: 'No recognizable overlap between your oldString and the live text. You may be holding a stale mental model of the field; re-read via <mode>_read_fields([...]).',
        snippets: [],
    };
}
