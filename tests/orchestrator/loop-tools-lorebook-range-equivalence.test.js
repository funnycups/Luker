import { describe, test, expect } from '@jest/globals';
import { execLorebookList } from '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

// Verbatim copy of the release parser (loop-tools/lorebook.js:309-355),
// kept here as the oracle the delegated parser must match.
function referenceParseUidRange(input) {
    const text = String(input ?? '').trim();
    if (!text) return null;
    const invalidHint = 'Use formats like 0~100, 50~, or ~100 (separators ~, -, :, .. also accepted).';
    const exact = text.match(/^(\d+)$/);
    if (exact) {
        const uid = Number.parseInt(exact[1], 10);
        if (!Number.isInteger(uid) || uid < 0) {
            throw new ToolError(`lorebook_list: invalid range '${text}'.`, 'LOREBOOK_RANGE_INVALID', invalidHint);
        }
        return { start: uid, end: uid };
    }
    const rangeMatch = text.match(/^(\d+)?\s*(?:~|-|:|\.\.)\s*(\d+)?$/);
    if (!rangeMatch) {
        throw new ToolError(`lorebook_list: invalid range '${text}'.`, 'LOREBOOK_RANGE_INVALID', invalidHint);
    }
    const startText = String(rangeMatch[1] ?? '').trim();
    const endText = String(rangeMatch[2] ?? '').trim();
    const start = startText ? Number.parseInt(startText, 10) : 0;
    const end = endText ? Number.parseInt(endText, 10) : Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) {
        throw new ToolError(`lorebook_list: invalid range '${text}'.`, 'LOREBOOK_RANGE_INVALID', invalidHint);
    }
    if (start > end) {
        throw new ToolError(`lorebook_list: invalid range '${text}' — start must be <= end.`, 'LOREBOOK_RANGE_INVALID', invalidHint);
    }
    return { start, end };
}

const BOOK = 'Bryn Headland';
const ENTRIES = Array.from({ length: 12 }, (_, uid) => ({
    world: BOOK, uid, key: [`mark${uid}`], comment: `chart ${uid}`, content: `Bearing ${uid} off the gull rocks.`,
}));

function listContext() {
    return { __getSortedEntriesFn: async () => ENTRIES };
}

function expectedOutput(range) {
    return ENTRIES
        .filter((e) => !range || (e.uid >= range.start && e.uid <= range.end))
        .map((e) => `[${BOOK}] uid=${e.uid} name=${e.comment} key=${e.key.join('|')}`)
        .join('\n');
}

const INPUTS = ['', '   ', '7', '007', '0~5', '5~', '~2', '~', '0-5', '0..5', '0:5', ' 3 ~ 9 ', '-1',
    '5~3', 'abc~5', '2.5~7', '1~2~3', '99999999999999999999', '0~99999999999999999999'];

const CASES = INPUTS.map((range) => {
    try {
        return { range, parsed: referenceParseUidRange(range), error: null };
    } catch (error) {
        return { range, parsed: null, error };
    }
});
const OK_CASES = CASES.filter((c) => !c.error).map((c) => [c.range, c.parsed]);
const ERROR_CASES = CASES.filter((c) => c.error).map((c) => [c.range, c.error]);

describe('lorebook_list range parsing matches the release parser', () => {
    test('the corpus covers malformed and reversed ranges', () => {
        expect(ERROR_CASES.map(([range]) => range)).toEqual(expect.arrayContaining(['5~3', 'abc~5', '2.5~7', '1~2~3']));
    });

    test.each(OK_CASES)('range %p lists the same entries', async (range, parsed) => {
        const out = await execLorebookList({ book_name: BOOK, range }, listContext());
        expect(out).toEqual({ ok: true, output: expectedOutput(parsed) });
    });

    test.each(ERROR_CASES)('range %p throws the same ToolError', async (range, error) => {
        await expect(execLorebookList({ book_name: BOOK, range }, listContext())).rejects.toMatchObject({
            name: 'ToolError',
            message: error.message,
            code: error.code,
            hint: error.hint,
        });
    });
});
