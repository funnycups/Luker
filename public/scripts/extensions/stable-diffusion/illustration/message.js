export const ILLUSTRATION_ATTRIBUTE = 'data-illustration-id';
export const ILLUSTRATION_FAILED_CLASS = 'luker-illustration-failed';

export const ILLUSTRATION_STRIP_FIND_REGEX = '/(?:<img\\b[^>]*\\bdata-illustration-id=(?:"[^"]*"|\'[^\']*\')[^>]*>[ \\t]?|<span\\b[^>]*\\bdata-illustration-id=(?:"[^"]*"|\'[^\']*\')[^>]*>[\\s\\S]*?<\\/span>[ \\t]?)/gi';

const HTML_ESCAPES = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
});

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPES[character]);
}

export function isAllowedImagePath(url) {
    const value = String(url || '');
    return value.startsWith('/user/images/') || value.startsWith('user/images/');
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function anchorPattern(anchor) {
    const tokens = String(anchor || '').trim().split(/\s+/).filter(Boolean);
    return tokens.map(escapeRegex).join('\\s+');
}

/**
 * Find the first ordered pair of anchors and return the offset where a tag
 * should be inserted. The offset sits after the first whitespace character
 * following the trailing anchor, so a tag placed there keeps the surrounding
 * text separated by single spaces.
 * @param {string} messageText
 * @param {string} insertAfter
 * @param {string} insertBefore
 * @returns {number|null}
 */
export function findInsertionPoint(messageText, insertAfter, insertBefore) {
    const text = String(messageText ?? '');
    const afterPattern = anchorPattern(insertAfter);
    const beforePattern = anchorPattern(insertBefore);
    if (!afterPattern || !beforePattern) {
        return null;
    }

    const afterRegex = new RegExp(afterPattern, 'gi');
    let afterMatch;
    while ((afterMatch = afterRegex.exec(text)) !== null) {
        const afterEnd = afterMatch.index + afterMatch[0].length;
        const beforeRegex = new RegExp(beforePattern, 'gi');
        beforeRegex.lastIndex = afterEnd;
        const beforeMatch = beforeRegex.exec(text);
        if (!beforeMatch) {
            return null;
        }
        if (!/^\s*$/.test(text.slice(afterEnd, beforeMatch.index))) {
            continue;
        }
        return afterEnd + (/\s/.test(text[afterEnd] || '') ? 1 : 0);
    }
    return null;
}

/**
 * Insert HTML placements at anchor positions, left to right.
 * @param {string} messageText
 * @param {Array<{id: string, html: string, insertAfter: string, insertBefore: string}>} placements
 * @param {{ appendMissing?: boolean }} [options]
 * @returns {{ text: string, inserted: string[], missing: string[] }}
 */
export function insertTagsAtAnchors(messageText, placements, { appendMissing = true } = {}) {
    const text = String(messageText ?? '');
    const found = [];
    const missing = [];
    const missingPlacements = [];

    (Array.isArray(placements) ? placements : []).forEach((placement, order) => {
        const position = findInsertionPoint(text, placement.insertAfter, placement.insertBefore);
        if (position === null) {
            missing.push(placement.id);
            missingPlacements.push(placement);
            return;
        }
        found.push({ placement, position, order });
    });

    found.sort((left, right) => left.position - right.position || left.order - right.order);

    let output = '';
    let cursor = 0;
    for (const { placement, position } of found) {
        output += text.slice(cursor, position);
        output += placement.html;
        cursor = position;
        if (cursor < text.length) {
            output += ' ';
        }
    }
    output += text.slice(cursor);

    if (appendMissing) {
        for (const placement of missingPlacements) {
            output += placement.html;
        }
    }

    return {
        text: output,
        inserted: found.map(({ placement }) => placement.id),
        missing,
    };
}

export function buildImageTag({ id, imageUrl, prompt, width }) {
    if (!isAllowedImagePath(imageUrl)) {
        throw new Error(`Illustration image path is not local: ${imageUrl}`);
    }
    const numericWidth = Number(width);
    if (!Number.isFinite(numericWidth) || numericWidth < 10 || numericWidth > 100) {
        throw new Error(`Illustration display width is out of range: ${width}`);
    }
    const safePrompt = escapeHtml(prompt);
    return `<img src="${escapeHtml(imageUrl)}" alt="${safePrompt}" `
        + `${ILLUSTRATION_ATTRIBUTE}="${escapeHtml(id)}" `
        + `style="width: ${numericWidth}%;">`;
}

export function buildFailedTag({ id, prompt, error, label = 'Image generation failed' }) {
    const preview = String(prompt || '').slice(0, 60); // cap-ok: compact inline failure badge inside chat bubble; full prompt stays on record
    const text = `${label}: ${preview}`;
    return `<span class="${ILLUSTRATION_FAILED_CLASS}" ${ILLUSTRATION_ATTRIBUTE}="${escapeHtml(id)}" `
        + `title="${escapeHtml(error)}">${escapeHtml(text)}</span>`;
}

export function buildIllustrationStripRegexScript({ placement } = {}) {
    const userInput = placement?.USER_INPUT ?? 1;
    const aiOutput = placement?.AI_OUTPUT ?? 2;
    return {
        id: 'sd-illustration-prompt-strip',
        scriptName: 'AI Illustration · Strip inline image markup from main prompt',
        findRegex: ILLUSTRATION_STRIP_FIND_REGEX,
        replaceString: '',
        trimStrings: [],
        placement: [userInput, aiOutput],
        disabled: false,
        markdownOnly: false,
        promptOnly: true,
        pluginLanes: [],
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
}

function removeIllustrationNodeCleanly(node) {
    const prev = node.previousSibling;
    const next = node.nextSibling;
    if (
        prev?.nodeType === 3
        && next?.nodeType === 3
        && /[ \t]$/.test(prev.nodeValue || '')
        && /^[ \t]/.test(next.nodeValue || '')
    ) {
        next.nodeValue = (next.nodeValue || '').slice(1);
    }
    node.remove();
}

/**
 * Remove illustration image tags and failed placeholders from message text.
 * Note: preserves exact non-whitespace concatenation when adjacent text nodes have no padding,
 * and collapses the extra single space inserted by insertTagsAtAnchors when surrounded by spaces.
 * @param {string} text
 * @returns {string}
 */
export function stripIllustrationMarkup(text) {
    return stripUnlockedIllustrationMarkup(text, new Set());
}

/**
 * Remove unlocked illustration tags while keeping locked `<img data-illustration-id>` elements intact.
 * @param {string} text
 * @param {Set<string>} [lockedIds]
 * @returns {string}
 */
export function stripUnlockedIllustrationMarkup(text, lockedIds = new Set()) {
    const source = String(text ?? '');
    if (!source.includes(ILLUSTRATION_ATTRIBUTE)) {
        return source;
    }
    const keepSet = lockedIds instanceof Set ? lockedIds : new Set(lockedIds || []);
    const template = document.createElement('template');
    template.innerHTML = source;
    for (const node of template.content.querySelectorAll(`[${ILLUSTRATION_ATTRIBUTE}]`)) {
        const id = node.getAttribute(ILLUSTRATION_ATTRIBUTE) || '';
        if (keepSet.has(id)) {
            continue;
        }
        removeIllustrationNodeCleanly(node);
    }
    return template.innerHTML;
}

/**
 * Replace the element carrying the given illustration id with new markup.
 * @param {string} text
 * @param {string} id
 * @param {string} html
 * @returns {string}
 */
export function replaceIllustrationMarkup(text, id, html) {
    const source = String(text ?? '');
    const target = String(id || '');
    if (!source.includes(ILLUSTRATION_ATTRIBUTE) || !target) {
        return source;
    }
    const template = document.createElement('template');
    template.innerHTML = source;
    const node = template.content.querySelector(`[${ILLUSTRATION_ATTRIBUTE}="${escapeCssAttribute(target)}"]`);
    if (!node) {
        return source;
    }
    const replacement = document.createElement('template');
    replacement.innerHTML = String(html ?? '');
    node.replaceWith(replacement.content);
    return template.innerHTML;
}

function escapeCssAttribute(value) {
    return String(value).replace(/["\\]/g, character => `\\${character}`);
}
