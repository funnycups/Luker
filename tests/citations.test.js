/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from '@jest/globals';
import {
    extractCitationsFromData,
    mergeCitations,
    normalizeCitationsForDisplay,
    renderMessageCitations,
    sanitizeCitationUrl,
} from '../public/scripts/lib/citations.js';

describe('citations helpers', () => {
    test('sanitizeCitationUrl allows only http(s) URLs and rejects javascript/data schemes', () => {
        expect(sanitizeCitationUrl('https://example.com/docs?q=1')).toBe('https://example.com/docs?q=1');
        expect(sanitizeCitationUrl('http://example.org/path')).toBe('http://example.org/path');
        expect(sanitizeCitationUrl('javascript:alert(1)')).toBe('');
        expect(sanitizeCitationUrl('data:text/html,<script>alert(1)</script>')).toBe('');
        expect(sanitizeCitationUrl('not a url')).toBe('');
    });

    test('extractCitationsFromData reads OpenAI-shaped message citations, top-level citations, and native Claude text block citations', () => {
        const msgCitations = [{ type: 'web_search_result_location', url: 'https://a.test', title: 'Alpha', cited_text: 'fact A' }];
        expect(extractCitationsFromData({ choices: [{ message: { citations: msgCitations } }] })).toEqual(msgCitations);

        expect(extractCitationsFromData({ citations: ['https://b.test/page'] })).toEqual(['https://b.test/page']);

        expect(extractCitationsFromData({
            content: [
                { type: 'thinking', thinking: 'hmm' },
                { type: 'text', text: 'Answer.', citations: [{ type: 'web_search_result_location', url: 'https://c.test', title: 'Gamma', cited_text: 'fact C' }] },
            ],
        })).toEqual([{ type: 'web_search_result_location', url: 'https://c.test', title: 'Gamma', cited_text: 'fact C' }]);

        expect(extractCitationsFromData({ choices: [{ message: { content: 'plain' } }] })).toBeNull();
    });

    test('mergeCitations preserves order across continuation rounds and deduplicates identical entries', () => {
        const round1 = [{ type: 'web_search_result_location', url: 'https://one.test', title: 'One' }];
        const round2 = [
            { type: 'web_search_result_location', url: 'https://one.test', title: 'One' },
            { type: 'web_search_result_location', url: 'https://two.test', title: 'Two' },
        ];
        expect(mergeCitations(round1, round2)).toEqual([
            { type: 'web_search_result_location', url: 'https://one.test', title: 'One' },
            { type: 'web_search_result_location', url: 'https://two.test', title: 'Two' },
        ]);
        expect(mergeCitations(null, null)).toBeNull();
    });

    test('normalizeCitationsForDisplay normalizes Anthropic, Cohere v2, and string URL citations while deduplicating by URL', () => {
        const items = normalizeCitationsForDisplay([
            {
                type: 'web_search_result_location',
                url: 'https://docs.anthropic.com/en/docs',
                title: 'Anthropic Docs',
                cited_text: 'Use pause_turn to resume server tools.',
            },
            {
                type: 'web_search_result_location',
                url: 'https://docs.anthropic.com/en/docs',
                title: 'Duplicate URL',
                cited_text: 'Ignored duplicate.',
            },
            {
                type: 'page_location',
                document_title: 'Field Manual',
                start_page_number: 4,
                end_page_number: 5,
                cited_text: 'Keep the valve closed.',
            },
            {
                text: 'Cohere snippet',
                sources: [{
                    id: 'doc-1',
                    document: { title: 'Cohere Reference', url: 'https://docs.cohere.com/v2' },
                }],
            },
            'https://www.example.com/report',
            { url: 'javascript:alert(1)', title: 'Unsafe Link', cited_text: 'plain text remains safe' },
        ]);

        expect(items).toEqual([
            {
                label: 'Anthropic Docs',
                url: 'https://docs.anthropic.com/en/docs',
                excerpt: 'Use pause_turn to resume server tools.',
            },
            {
                label: 'Field Manual',
                url: '',
                excerpt: 'Keep the valve closed.',
            },
            {
                label: 'Cohere Reference',
                url: 'https://docs.cohere.com/v2',
                excerpt: 'Cohere snippet',
            },
            {
                label: 'example.com',
                url: 'https://www.example.com/report',
                excerpt: '',
            },
            {
                label: 'Unsafe Link',
                url: '',
                excerpt: 'plain text remains safe',
            },
        ]);
    });

    test('renderMessageCitations renders safe DOM links, escapes raw HTML text, and clears when citations are absent', () => {
        const host = document.createElement('div');
        host.innerHTML = '<div class="mes"><div class="mes_text"></div><div class="mes_citations_wrapper"></div></div>';
        const mesEl = host.firstElementChild;

        renderMessageCitations({
            extra: {
                citations: [
                    {
                        type: 'web_search_result_location',
                        url: 'https://example.com/a',
                        title: '<img src=x onerror=alert(1)>',
                        cited_text: '<b>quoted</b>',
                    },
                    {
                        url: 'javascript:alert(1)',
                        title: 'Blocked Scheme',
                    },
                ],
            },
        }, mesEl, { sourcesLabel: '来源' });

        const wrapper = mesEl.querySelector('.mes_citations_wrapper');
        expect(wrapper.querySelector('img')).toBeNull();
        expect(wrapper.querySelector('b')).toBeNull();
        expect(wrapper.querySelector('.mes_citations_summary').textContent).toContain('来源 (2)');

        const links = wrapper.querySelectorAll('a.mes_citation_link');
        expect(links).toHaveLength(1);
        expect(links[0].href).toBe('https://example.com/a');
        expect(links[0].target).toBe('_blank');
        expect(links[0].rel).toBe('noopener noreferrer');
        expect(links[0].textContent).toBe('<img src=x onerror=alert(1)>');

        const labels = wrapper.querySelectorAll('.mes_citation_label');
        expect(labels).toHaveLength(1);
        expect(labels[0].textContent).toBe('Blocked Scheme');

        // Switching to a swipe without citations empties the wrapper.
        renderMessageCitations({ extra: {} }, mesEl, { sourcesLabel: '来源' });
        expect(wrapper.textContent).toBe('');
        expect(wrapper.children).toHaveLength(0);
    });
});
