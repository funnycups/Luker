// tests/memory-graph/graph-iteration-diff-preview.test.js
import { jest } from '@jest/globals';
import {
    buildGraphDiffSummary,
    diffGraphDocs,
    renderMgGraphDiffCard,
    renderMgGraphDiffSummary,
} from '../../public/scripts/extensions/memory-graph/graph-iteration/diff-cards.js';
import { renderMgGraphPreviewPane } from '../../public/scripts/extensions/memory-graph/graph-iteration/preview.js';

const t = (s) => String(s);

const RECORD_HEADER_RE = /<div class="mg_graph_it_diff_record_header">[\s\S]*?<\/div>/g;

function recordHeaders(html) {
    return html.match(RECORD_HEADER_RE) || [];
}

function headerFor(html, needle) {
    const matches = recordHeaders(html).filter((header) => header.includes(needle));
    expect(matches).toHaveLength(1);
    return matches[0];
}

function node(id, type, title, extra = {}) {
    return {
        id,
        type,
        level: 'semantic',
        title,
        seqTo: 1,
        fields: {},
        semanticDepth: 0,
        semanticRollup: false,
        childrenIds: [],
        parentId: '',
        archived: false,
        ...extra,
    };
}

function link(from, type, to) {
    return { from, type, to };
}

const LIVE = {
    nodes: {
        n_1: node('n_1', 'character_sheet', 'Bryn'),
        n_2: node('n_2', 'location_state', 'Watchtower'),
    },
    links: {
        'n_1␟guards␟n_2': link('n_1', 'guards', 'n_2'),
    },
};

const STAGED = {
    nodes: {
        n_1: node('n_1', 'character_sheet', 'Bryn', { fields: { identity: 'watch captain' } }),
        n_2: node('n_2', 'location_state', 'Watchtower'),
        n_9: node('n_9', 'event', 'Lantern night'),
    },
    links: {
        'n_1␟guards␟n_2': link('n_1', 'guards', 'n_2'),
        'n_9␟involves␟n_1': link('n_9', 'involves', 'n_1'),
    },
};

const SUMMARY_BEFORE = {
    nodes: {
        n_1: node('n_1', 'character_sheet', 'Bryn'),
        n_2: node('n_2', 'location_state', 'Watchtower'),
        n_5: node('n_5', 'event', 'Shift'),
        n_6: node('n_6', 'item', 'Old lantern'),
    },
    links: {
        'n_1␟guards␟n_2': link('n_1', 'guards', 'n_2'),
        'n_6␟owned_by␟n_1': link('n_6', 'owned_by', 'n_1'),
    },
};

const SUMMARY_AFTER = {
    nodes: {
        n_1: node('n_1', 'character_sheet', 'Bryn', { fields: { identity: 'watch captain' } }),
        n_2: node('n_2', 'location_state', 'Watchtower'),
        n_5: node('n_5', 'event', 'Shift', { archived: true }),
        n_9: node('n_9', 'event', 'Lantern night'),
    },
    links: {
        'n_1␟guards␟n_2': { ...link('n_1', 'guards', 'n_2'), note: 'relief' },
        'n_9␟involves␟n_1': link('n_9', 'involves', 'n_1'),
    },
};

describe('diffGraphDocs', () => {
    test('classifies added / removed / modified records', () => {
        const forward = diffGraphDocs(LIVE, STAGED);
        expect(forward.addedNodes).toEqual(['n_9']);
        expect(forward.removedNodes).toEqual([]);
        expect(forward.modifiedNodes).toEqual(['n_1']);
        expect(forward.addedLinks).toEqual(['n_9␟involves␟n_1']);
        expect(forward.removedLinks).toEqual([]);
        expect(forward.modifiedLinks).toEqual([]);

        const backward = diffGraphDocs(STAGED, LIVE);
        expect(backward.removedNodes).toEqual(['n_9']);
        expect(backward.addedNodes).toEqual([]);
        expect(backward.removedLinks).toEqual(['n_9␟involves␟n_1']);
    });

    test('identical docs produce no differences', () => {
        const diff = diffGraphDocs(STAGED, STAGED);
        expect(diff.addedNodes.length + diff.removedNodes.length + diff.modifiedNodes.length
            + diff.addedLinks.length + diff.removedLinks.length + diff.modifiedLinks.length).toBe(0);
    });

    test('archived-node edits count as modifications', () => {
        const before = { nodes: { n_5: node('n_5', 'event', 'Shift') }, links: {} };
        const after = { nodes: { n_5: node('n_5', 'event', 'Shift', { archived: true }) }, links: {} };
        expect(diffGraphDocs(before, after).modifiedNodes).toEqual(['n_5']);
    });
});

describe('buildGraphDiffSummary', () => {
    test('captures identity for added and modified nodes', () => {
        const summary = buildGraphDiffSummary(LIVE, STAGED);
        expect(summary.addedNodes).toEqual([
            { id: 'n_9', type: 'event', title: 'Lantern night' },
        ]);
        expect(summary.removedNodes).toEqual([]);
        expect(summary.modifiedNodes).toEqual([
            { id: 'n_1', type: 'character_sheet', title: 'Bryn', archivedTransition: false },
        ]);
    });

    test('captures removed nodes with their before-state identity', () => {
        const summary = buildGraphDiffSummary(STAGED, LIVE);
        expect(summary.removedNodes).toEqual([
            { id: 'n_9', type: 'event', title: 'Lantern night' },
        ]);
    });

    test('marks archived transitions on modified nodes and only there', () => {
        const before = { nodes: { n_5: node('n_5', 'event', 'Shift') }, links: {} };
        const after = { nodes: { n_5: node('n_5', 'event', 'Shift', { archived: true }) }, links: {} };
        const summary = buildGraphDiffSummary(before, after);
        expect(summary.modifiedNodes).toEqual([
            { id: 'n_5', type: 'event', title: 'Shift', archivedTransition: true },
        ]);
    });

    test('captures endpoints for added, removed and modified links', () => {
        const before = {
            nodes: {},
            links: {
                'n_1␟guards␟n_2': link('n_1', 'guards', 'n_2'),
                'n_2␟holds␟n_3': link('n_2', 'holds', 'n_3'),
            },
        };
        const after = {
            nodes: {},
            links: {
                'n_1␟guards␟n_2': { ...link('n_1', 'guards', 'n_2'), note: 'relief' },
                'n_3␟involves␟n_1': link('n_3', 'involves', 'n_1'),
            },
        };
        const summary = buildGraphDiffSummary(before, after);
        expect(summary.addedLinks).toEqual([{ from: 'n_3', to: 'n_1', type: 'involves' }]);
        expect(summary.removedLinks).toEqual([{ from: 'n_2', to: 'n_3', type: 'holds' }]);
        expect(summary.modifiedLinks).toEqual([{ from: 'n_1', to: 'n_2', type: 'guards' }]);
    });
});

describe('renderMgGraphDiffCard', () => {
    test('wraps each changed record in a group with a header', () => {
        const html = renderMgGraphDiffCard(LIVE, STAGED, { t });
        expect(html).toContain('mg_graph_it_pending_card');
        expect(html).toContain('mg_graph_it_diff_record');
        expect(html).toContain('mg_graph_it_diff_record_header');
    });

    test('renders one card wrapper with record markers for a full change set', () => {
        const html = renderMgGraphDiffCard(LIVE, STAGED, { t });
        expect(html).toContain('mg_graph_it_pending_card');
        expect(html).toContain('n_9');
        expect(html).toContain('Lantern night');
        expect(html).toContain('+');
        expect(html).toContain('n_9␟involves␟n_1');
        expect(html).toContain('identity');
    });

    test('added node header carries the node id and title', () => {
        const html = renderMgGraphDiffCard(LIVE, STAGED, { t });
        const header = headerFor(html, 'Lantern night');
        expect(header).toContain('n_9');
        expect(header).toContain('Lantern night');
        expect(header).toContain('+');
    });

    test('added node identity falls back to type and id when title is empty', () => {
        const before = { nodes: {}, links: {} };
        const after = { nodes: { n_7: node('n_7', 'event', '') }, links: {} };
        const html = renderMgGraphDiffCard(before, after, { t });
        const header = headerFor(html, 'n_7');
        expect(header).toContain('event');
        expect(header).toContain('n_7');
    });

    test('two modified nodes produce two distinct headers', () => {
        const before = {
            nodes: {
                n_1: node('n_1', 'character_sheet', 'Bryn'),
                n_2: node('n_2', 'location_state', 'Watchtower'),
            },
            links: {},
        };
        const after = {
            nodes: {
                n_1: node('n_1', 'character_sheet', 'Bryn', { fields: { identity: 'watch captain' } }),
                n_2: node('n_2', 'location_state', 'Watchtower', { fields: { identity: 'west tower' } }),
            },
            links: {},
        };
        const html = renderMgGraphDiffCard(before, after, { t });
        const headers = recordHeaders(html);
        expect(headers).toHaveLength(2);
        expect(headers.filter((header) => header.includes('n_1'))).toHaveLength(1);
        expect(headers.filter((header) => header.includes('n_2'))).toHaveLength(1);
        expect(headerFor(html, 'n_1')).toContain('Bryn');
        expect(headerFor(html, 'n_2')).toContain('Watchtower');
    });

    test('archived-transition node gets the archived kind and modified marker', () => {
        const before = { nodes: { n_5: node('n_5', 'event', 'Shift') }, links: {} };
        const after = { nodes: { n_5: node('n_5', 'event', 'Shift', { archived: true }) }, links: {} };
        const tSpy = jest.fn((s) => String(s));
        const html = renderMgGraphDiffCard(before, after, { t: tSpy });
        const header = headerFor(html, 'Shift');
        expect(header).toContain('n_5');
        expect(header).toContain('~');
        expect(tSpy).toHaveBeenCalledWith('Archived node');
        expect(tSpy).not.toHaveBeenCalledWith('Modified node');
    });

    test('added link header carries from, type and to', () => {
        const html = renderMgGraphDiffCard(LIVE, STAGED, { t });
        const header = headerFor(html, 'involves');
        expect(header).toContain('n_9');
        expect(header).toContain('n_1');
        expect(header).toContain('involves');
        expect(header).toContain('+');
    });

    test('removed link header carries from, type and to', () => {
        const html = renderMgGraphDiffCard(STAGED, LIVE, { t });
        const header = headerFor(html, 'involves');
        expect(header).toContain('n_9');
        expect(header).toContain('n_1');
        expect(header).toContain('involves');
        expect(header).toContain('−');
    });

    test('renders removals with a minus marker', () => {
        const html = renderMgGraphDiffCard(STAGED, LIVE, { t });
        const header = headerFor(html, 'Lantern night');
        expect(header).toContain('−');
        expect(header).toContain('n_9');
    });

    test('identical docs render the no-change note', () => {
        const html = renderMgGraphDiffCard(STAGED, STAGED, { t });
        expect(html).toContain('mg_graph_it_pending_note');
        expect(html).not.toContain('luker_lib_diff_card');
    });
});

describe('renderMgGraphDiffSummary', () => {
    test('renders one header-only record group per summary entry', () => {
        const summary = buildGraphDiffSummary(SUMMARY_BEFORE, SUMMARY_AFTER);
        const html = renderMgGraphDiffSummary(summary, { t });
        const records = html.match(/<div class="mg_graph_it_diff_record">/g) || [];
        expect(records).toHaveLength(7);
        expect(html).toContain('mg_graph_it_diff_record_marker');
        expect(html).toContain('mg_graph_it_diff_record_kind');
        expect(html).toContain('mg_graph_it_diff_record_identity');
        expect(html).not.toContain('luker_lib_diff_card');
    });

    test('carries marker, kind and identity per record', () => {
        const summary = buildGraphDiffSummary(SUMMARY_BEFORE, SUMMARY_AFTER);
        const html = renderMgGraphDiffSummary(summary, { t });
        const added = headerFor(html, 'Lantern night');
        expect(added).toContain('+');
        expect(added).toContain('event · Lantern night (n_9)');
        const archived = headerFor(html, 'Shift');
        expect(archived).toContain('~');
        expect(archived).toContain('Archived node');
        const removed = headerFor(html, 'Old lantern');
        expect(removed).toContain('−');
        expect(removed).toContain('Removed node');
        const linkHeader = headerFor(html, 'involves');
        expect(linkHeader).toContain('+');
        expect(linkHeader).toContain('n_9');
        expect(linkHeader).toContain('n_1');
    });

    test('routes kind labels through the injected translator', () => {
        const summary = buildGraphDiffSummary(SUMMARY_BEFORE, SUMMARY_AFTER);
        const tSpy = jest.fn((s) => String(s));
        renderMgGraphDiffSummary(summary, { t: tSpy });
        for (const label of ['Archived node', 'Modified node', 'Added node', 'Removed node', 'Added link', 'Removed link', 'Modified link']) {
            expect(tSpy).toHaveBeenCalledWith(label);
        }
    });

    test('returns an empty string for a missing or empty summary', () => {
        expect(renderMgGraphDiffSummary(null)).toBe('');
        expect(renderMgGraphDiffSummary({})).toBe('');
        expect(renderMgGraphDiffSummary(buildGraphDiffSummary(LIVE, LIVE), { t })).toBe('');
    });
});

describe('renderMgGraphPreviewPane', () => {
    test('groups staged nodes by type and marks added / modified rows', () => {
        const html = renderMgGraphPreviewPane(STAGED, LIVE, { t });
        expect(html).toContain('mg_graph_it_preview');
        expect(html).toContain('mg_graph_it_preview_row_added');
        expect(html).toContain('n_9');
        expect(html).toContain('mg_graph_it_preview_row_modified');
        expect(html).toContain('Lantern night');
    });

    test('marks removed nodes and links when staged drops records', () => {
        const html = renderMgGraphPreviewPane(LIVE, STAGED, { t });
        expect(html).toContain('mg_graph_it_preview_row_removed');
        expect(html).toContain('mg_graph_it_preview_link_removed');
        expect(html).toContain('n_9');
    });

    test('empty staged graph renders the empty note', () => {
        const html = renderMgGraphPreviewPane({ nodes: {}, links: {} }, { nodes: {}, links: {} }, { t });
        expect(html).toContain('mg_graph_it_preview_empty');
    });

    test('link rows mark additions', () => {
        const html = renderMgGraphPreviewPane(STAGED, LIVE, { t });
        expect(html).toContain('mg_graph_it_preview_link_added');
        expect(html).toContain('involves');
    });
});
