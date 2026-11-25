// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure normalization, merging, extraction, and safe DOM rendering for provider
 * citations (Anthropic Messages web_search / document citations, Cohere v2
 * citations, and OpenAI-compatible citations arrays).
 */

const ALLOWED_CITATION_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Validate and normalize a citation URL to http(s) only.
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function sanitizeCitationUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';
    try {
        const parsed = new URL(trimmed);
        return ALLOWED_CITATION_PROTOCOLS.has(parsed.protocol) ? parsed.href : '';
    } catch {
        return '';
    }
}

/**
 * Extract provider citations from a non-streaming response envelope.
 * @param {any} data
 * @returns {Array<any>|null}
 */
export function extractCitationsFromData(data) {
    if (!data || typeof data !== 'object') return null;
    const msgCitations = data?.choices?.[0]?.message?.citations;
    if (Array.isArray(msgCitations) && msgCitations.length > 0) {
        return structuredClone(msgCitations.filter(Boolean));
    }
    if (Array.isArray(data.citations) && data.citations.length > 0) {
        return structuredClone(data.citations.filter(Boolean));
    }
    if (Array.isArray(data.content)) {
        const collected = [];
        for (const block of data.content) {
            if (block?.type === 'text' && Array.isArray(block.citations)) {
                for (const citation of block.citations) {
                    if (citation) collected.push(structuredClone(citation));
                }
            }
        }
        if (collected.length > 0) return collected;
    }
    return null;
}

/**
 * Merge two citation arrays in order, deduplicating identical raw entries.
 * @param {Array<any>|null|undefined} existing
 * @param {Array<any>|null|undefined} incoming
 * @returns {Array<any>|null}
 */
export function mergeCitations(existing, incoming) {
    const out = [];
    const seen = new Set();
    for (const list of [existing, incoming]) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (item == null) continue;
            const key = typeof item === 'string' ? `s:${item}` : `o:${JSON.stringify(item)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(typeof item === 'object' ? structuredClone(item) : item);
        }
    }
    return out.length > 0 ? out : null;
}

function hostLabelFromUrl(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/**
 * Normalize raw provider citation records into deduplicated display items.
 * @param {Array<any>|null|undefined} rawCitations
 * @returns {Array<{ label: string, url: string, excerpt: string }>}
 */
export function normalizeCitationsForDisplay(rawCitations) {
    if (!Array.isArray(rawCitations) || rawCitations.length === 0) {
        return [];
    }

    const items = [];
    const seen = new Set();

    const pushItem = ({ label = '', url = '', excerpt = '' }) => {
        const safeUrl = sanitizeCitationUrl(url);
        const cleanExcerpt = String(excerpt || '').replace(/\s+/g, ' ').trim();
        const cleanLabel = String(label || '').trim() || (safeUrl ? hostLabelFromUrl(safeUrl) : '');
        if (!cleanLabel && !safeUrl && !cleanExcerpt) return;
        const dedupeKey = safeUrl ? `url:${safeUrl}` : `txt:${cleanLabel}\0${cleanExcerpt}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        items.push({
            label: cleanLabel || cleanExcerpt,
            url: safeUrl,
            excerpt: cleanExcerpt,
        });
    };

    for (const raw of rawCitations) {
        if (typeof raw === 'string') {
            const safeUrl = sanitizeCitationUrl(raw);
            if (safeUrl) {
                pushItem({ label: hostLabelFromUrl(safeUrl), url: safeUrl });
            } else if (raw.trim()) {
                pushItem({ label: raw.trim() });
            }
            continue;
        }
        if (!raw || typeof raw !== 'object') continue;

        // Cohere v2 citations carry a `sources[]` array referencing documents.
        if (Array.isArray(raw.sources) && raw.sources.length > 0) {
            const excerpt = typeof raw.text === 'string' ? raw.text : '';
            for (const source of raw.sources) {
                if (!source || typeof source !== 'object') continue;
                const doc = source.document && typeof source.document === 'object' ? source.document : source;
                pushItem({
                    label: doc.title || doc.name || source.id || '',
                    url: doc.url || source.url || '',
                    excerpt: excerpt || doc.snippet || doc.text || '',
                });
            }
            continue;
        }

        // Anthropic Messages citations (`web_search_result_location`, `search_result_location`,
        // `char_location`, `page_location`, `content_block_location`) and OpenAI-compatible objects.
        const url = raw.url || raw.source || raw.uri || '';
        const title = raw.title || raw.document_title || raw.name || '';
        const excerpt = raw.cited_text || raw.snippet || raw.text || '';
        let label = title;
        if (!label && Number.isInteger(raw.start_page_number)) {
            const endPage = Number.isInteger(raw.end_page_number) && raw.end_page_number !== raw.start_page_number
                ? `-${raw.end_page_number}`
                : '';
            label = `p. ${raw.start_page_number}${endPage}`;
        }
        pushItem({ label, url, excerpt });
    }

    return items;
}

/**
 * Safely render citation sources into a message element's `.mes_citations_wrapper`.
 * Uses DOM node construction + `textContent` exclusively (no innerHTML).
 *
 * @param {object|null|undefined} message
 * @param {JQuery<HTMLElement>|HTMLElement|null|undefined} messageElement
 * @param {{ sourcesLabel?: string }} [options]
 */
export function renderMessageCitations(message, messageElement, { sourcesLabel = 'Sources' } = {}) {
    const root = messageElement && typeof messageElement.get === 'function'
        ? messageElement.get(0)
        : messageElement;
    if (!root || typeof root.querySelector !== 'function') return;

    const wrapper = root.querySelector('.mes_citations_wrapper');
    if (!wrapper) return;

    const items = normalizeCitationsForDisplay(message?.extra?.citations);
    wrapper.textContent = '';
    if (items.length === 0) return;

    const doc = wrapper.ownerDocument || document;
    const details = doc.createElement('details');
    details.className = 'mes_citations';

    const summary = doc.createElement('summary');
    summary.className = 'mes_citations_summary';
    const icon = doc.createElement('i');
    icon.className = 'fa-solid fa-quote-left';
    icon.setAttribute('aria-hidden', 'true');
    const titleSpan = doc.createElement('span');
    titleSpan.textContent = `${sourcesLabel} (${items.length})`;
    summary.append(icon, ' ', titleSpan);
    details.appendChild(summary);

    const list = doc.createElement('ol');
    list.className = 'mes_citations_list';

    for (const item of items) {
        const li = doc.createElement('li');
        li.className = 'mes_citation_item';

        if (item.url) {
            const link = doc.createElement('a');
            link.className = 'mes_citation_link';
            link.href = item.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = item.label;
            li.appendChild(link);
        } else {
            const span = doc.createElement('span');
            span.className = 'mes_citation_label';
            span.textContent = item.label;
            li.appendChild(span);
        }

        if (item.excerpt && item.excerpt !== item.label) {
            const quote = doc.createElement('span');
            quote.className = 'mes_citation_excerpt';
            quote.textContent = item.excerpt;
            li.appendChild(quote);
        }

        list.appendChild(li);
    }

    details.appendChild(list);
    wrapper.appendChild(details);
}
