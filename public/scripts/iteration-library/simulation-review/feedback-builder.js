// Pure functions that build the tagged-text tool result a workbench LLM
// will read after a simulate call. No DOM, no side effects. Test surface:
// tests/iteration-library/simulation-review/feedback-builder.test.js

/**
 * @typedef {Object} ChainSegment
 * @prop {string} text - Raw text from the chain.
 * @prop {number} [annotationId] - When set, wrap this segment in
 *   <<<ANNOTATION id=N>>>...<<</ANNOTATION>>> inline markers.
 *
 * @typedef {Object} Annotation
 * @prop {number} id
 * @prop {string} snippet
 * @prop {string} comment
 * @prop {string} path
 *
 * @typedef {Object} WorldInfoHit
 * @prop {string} book
 * @prop {string} entry
 * @prop {string} [comment]
 * @prop {string} [position]
 *
 * @typedef {Object} BuildArgs
 * @prop {string} kind - 'cea' | 'cpa' | 'orch-spec' | 'orch-agenda' | 'orch-loop' | 'orch-director'
 * @prop {boolean} cancelled
 * @prop {{reason: string, message?: string} | null} error
 * @prop {ChainSegment[]} [chainSegments]
 * @prop {Annotation[]} [annotations]
 * @prop {WorldInfoHit[]} [worldInfoHits]
 */

/**
 * Build the tagged-text content that goes inside the `role: 'tool'`
 * reply for a simulate tool call. Returns a string ready to embed as
 * the tool message content; the caller is responsible for delivering
 * it through whatever tool-result conduit its studio uses.
 *
 * @param {BuildArgs} args
 * @returns {string}
 */
export function buildSimulationToolResult(args) {
    const kind = String(args?.kind || '').trim();
    if (args?.error) {
        return renderErrorEnvelope(kind, args.error);
    }
    const cancelled = Boolean(args?.cancelled);
    const annotations = Array.isArray(args?.annotations) ? args.annotations : [];
    const chainSegments = Array.isArray(args?.chainSegments) ? args.chainSegments : [];
    const worldInfoHits = Array.isArray(args?.worldInfoHits) ? args.worldInfoHits : [];

    const chainText = renderChain(chainSegments, cancelled);
    const annotationsBlock = renderAnnotations(annotations, cancelled);
    const worldInfoBlock = renderWorldInfoHits(worldInfoHits);

    const ok = cancelled ? 'false' : 'true';
    const cancelledAttr = cancelled ? ' cancelled="true"' : '';
    const submitted = cancelled ? 'false' : 'true';
    const status = cancelled
        ? `<status submitted="${submitted}"/>`
        : `<status submitted="${submitted}" annotations_count="${annotations.length}"/>`;

    const sections = [
        `<simulation_result kind="${escapeAttr(kind)}" ok="${ok}"${cancelledAttr}>`,
        '',
        status,
        '',
        '<simulation_chain>',
        chainText,
        '</simulation_chain>',
        '',
        annotationsBlock,
    ];
    if (worldInfoBlock) {
        sections.push('', worldInfoBlock);
    }
    sections.push('', '</simulation_result>');
    return sections.join('\n');
}

function renderErrorEnvelope(kind, error) {
    const reason = String(error?.reason || 'unknown');
    const message = String(error?.message || '');
    return [
        `<simulation_result kind="${escapeAttr(kind)}" ok="false">`,
        '',
        `<error reason="${escapeAttr(reason)}">`,
        message,
        '</error>',
        '',
        '</simulation_result>',
    ].join('\n');
}

function renderChain(segments, cancelled) {
    if (segments.length === 0) {
        return '';
    }
    const out = [];
    for (const seg of segments) {
        const text = String(seg?.text ?? '');
        if (!cancelled && typeof seg?.annotationId === 'number') {
            out.push(`<<<ANNOTATION id=${seg.annotationId}>>>${text}<<</ANNOTATION>>>`);
        } else {
            out.push(text);
        }
    }
    return out.join('');
}

function renderAnnotations(annotations, cancelled) {
    if (cancelled || annotations.length === 0) {
        return '<annotations/>';
    }
    const lines = ['<annotations>'];
    for (const ann of annotations) {
        const id = Number(ann?.id);
        const path = String(ann?.path || '(unknown)');
        const snippet = String(ann?.snippet || '');
        const comment = String(ann?.comment || '');
        lines.push(`[#${id}] location: ${path}`);
        lines.push(`     snippet: "${snippet}"`);
        lines.push(`     comment: ${comment}`);
        lines.push('');
    }
    // Drop trailing blank, close tag.
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    lines.push('</annotations>');
    return lines.join('\n');
}

function renderWorldInfoHits(hits) {
    if (hits.length === 0) {
        return '';
    }
    const lines = ['<world_info_hits>'];
    for (const hit of hits) {
        const book = String(hit?.book || '');
        const entry = String(hit?.entry || '');
        const position = String(hit?.position || '');
        const positionTag = position ? ` (${position})` : '';
        lines.push(`  - Lorebook "${book}" → entry "${entry}"${positionTag}`);
    }
    lines.push('</world_info_hits>');
    return lines.join('\n');
}

function escapeAttr(value) {
    return String(value || '').replace(/"/g, '&quot;');
}
