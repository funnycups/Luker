// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Diagnose why an exact-match anchor patch (applyStringPatch) reported
 * `not_found`. Never mutates state. Returns a structured payload the
 * caller stuffs into the failing tool_result so the iterating AI can
 * identify the drift class (whitespace / dedent / similar-but-different)
 * without a second read tool round-trip.
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
 *
 * No size-based output truncation is applied. An earlier revision
 * capped input at 20 KB, snippet count at 2, and total snippet chars at
 * 800 — all pulled from thin air, none tied to a downstream context /
 * transport / storage requirement. The 20 KB input cap turned
 * legitimate patch attempts against long `systemPrompt` fields into a
 * `too_long_to_diagnose` reply that gave the AI nothing actionable.
 * The 800-char / 2-snippet caps silently swallowed matches that would
 * have pinpointed the drift. See
 * `.opencode/memory/feedback_no_arbitrary_max_limits.md` for the rule
 * this violated.
 */

// `SNIPPET_HALF_WINDOW` is a STRUCTURAL parameter, not an output cap:
// it defines HOW WIDE the returned snippet context is around each
// anchor hit. Left+right = 160 chars per snippet is enough for the AI
// to see the surrounding punctuation / whitespace that explains the
// drift, without dumping the full field back (which would defeat the
// diagnostic's purpose of pointing at a specific position). Changing
// this changes the shape of a snippet, not "how much text is allowed
// through" — every hit still gets a snippet.
const SNIPPET_HALF_WINDOW = 80;

// `PROBE_PREFIX_LEN` is a STRUCTURAL parameter for the Layer 3.5
// similarity probe: the first N characters of the caller's `oldString`
// are used as a needle for `indexOf` scans across the current text.
// 40 chars is long enough that random collisions are rare (any 40-char
// prose window is essentially unique) but short enough that the probe
// still hits when the tail of `oldString` diverges from the live text.
// Changing this changes the probe's precision/recall trade, not "how
// much output the AI sees" — every hit is reported.
const PROBE_PREFIX_LEN = 40;

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
        return {
            kind: 'whitespace_drift',
            note: 'Trailing whitespace differs between your oldString and the live text; re-read to see exact trailing spaces per line.',
            snippets: [extractSnippet(current, trimIdx)],
        };
    }

    // Layer 2
    const dedent = tryDedentMatch(current, oldString);
    if (dedent) {
        const prefixDesc = dedent.prefix === '\t' ? '1 tab' : `${dedent.prefix.length} space(s)`;
        return {
            kind: 'whitespace_drift',
            note: `Your oldString appears dedented by ${prefixDesc} vs the live text at char ${dedent.at}. Re-read the field to get the exact leading indentation.`,
            snippets: [extractSnippet(current, dedent.at)],
        };
    }

    // Layer 3
    const normAt = tryNormalizedWhitespaceMatch(current, oldString);
    if (normAt !== null) {
        return {
            kind: 'similar_snippet',
            note: `A whitespace-normalized substring match hit near char ${normAt}; the live text likely has different spacing / punctuation than your oldString.`,
            snippets: [extractSnippet(current, normAt)],
        };
    }

    // Layer 3.5 — long-oldString probe: if the first `PROBE_PREFIX_LEN`
    // chars of oldString occur anywhere in current, surface EVERY hit
    // so the AI can spot where its recollection diverges.
    if (oldString.length >= PROBE_PREFIX_LEN) {
        const probe = oldString.slice(0, PROBE_PREFIX_LEN);
        const hits = [];
        let searchFrom = 0;
        while (true) {
            const idx = current.indexOf(probe, searchFrom);
            if (idx === -1) break;
            hits.push(extractSnippet(current, idx));
            searchFrom = idx + probe.length;
        }
        if (hits.length > 0) {
            return {
                kind: 'similar_snippet',
                note: `Your oldString's first ${PROBE_PREFIX_LEN} chars occur ${hits.length} time(s) in the live text — the middle/end likely diverges. Re-read the field.`,
                snippets: hits,
            };
        }
    }

    return {
        kind: 'no_similar',
        note: 'No recognizable overlap between your oldString and the live text. You may be holding a stale mental model of the field; re-read via <mode>_read_fields([...]).',
        snippets: [],
    };
}
