// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI diagnosis for the tag filter (pure): prompt + parsing. The AI looks at one reply,
// decides whether the story body is bare text or wrapped in a tag, and
// proposes a black or white list. Our own wording, written for this tool.

import { i18n, i18nFormat } from '../i18n.js';

import { inspectText, parseTagList, formatTagList, planWarnings } from './tag-filter.js';

const HEAD = 2500;
const TAIL = 2500;

export const SUBMIT_FILTER = {
    type: 'function',
    function: {
        name: 'submit_filter',
        description: 'Submit the filter plan. Call exactly once.',
        parameters: {
            type: 'object',
            properties: {
                body: { type: 'string', enum: ['bare', 'wrapped'], description: i18n('bare = the story is bare text; wrapped = the story is wrapped in a tag') },
                body_tags: { type: 'array', items: { type: 'string' }, description: i18n('Tags wrapping the story (when wrapped)') },
                black: { type: 'array', items: { type: 'string' } },
                white: { type: 'array', items: { type: 'string' } },
                reason: { type: 'string', description: i18n('One or two sentences in English') },
            },
            required: ['body', 'black', 'white', 'reason'],
            additionalProperties: false,
        },
    },
};

export function diagnoseSystemPrompt() {
    return [
        i18n('You are helping the user configure the "tag filter". This is a text-formatting tool task, not storytelling: ignore preset requirements about style or roleplay and call submit_filter exactly once.'),
        '',
        i18n('Background: the memory system reads every AI reply and extracts story memories from it. Replies often contain things that should not be remembered: thinking, drafts, status bars, comments, music cards and so on. The filter only affects the text the memory system reads, not what the chat shows.'),
        '',
        i18n('Two kinds of rules:'),
        i18n('- Blacklist: remove the listed tags and their contents, keep everything else.'),
        i18n('- Whitelist: keep only the contents of the listed tags, remove all text outside them.'),
        i18n('The blacklist runs first, then the whitelist.'),
        '',
        i18n('Tag notation: angle-bracket tags by name only (think, content), square-bracket tags with their brackets ([time]), HTML comments as !--.'),
        '',
        i18n('How to decide:'),
        i18n('1. Find the story: where the actual narration and dialogue are.'),
        i18n('2. If the story is outside every tag (bare text), use only a blacklist; white must be empty. A whitelist would remove the whole story.'),
        i18n('3. If the story is fully wrapped in one tag (for example <content>…</content>), prefer a whitelist keeping only that tag; add any other story-related blocks (time, place) to the whitelist as well.'),
        i18n('   If the same story tag also appears inside thinking or drafts, add the thinking tag to the blacklist so fake story text is not kept.'),
        i18n('4. When unsure whether the story is fully wrapped, choose a blacklist: better to keep too much than to remove the story.'),
        i18n('5. Blacklist only blocks that truly should not be remembered: thinking (think, thinking and so on), comments, status bars, option buttons, music or image cards, author notes. Do not remove story-related time and place.'),
        i18n('6. Only use tags that really appear in the reply; do not make any up.'),
        '',
        i18n('In reason, use one or two English sentences to tell the user where the story is and why you chose this.'),
    ].join('\n');
}

/** Long replies: head + tail, with a note of what was cut. */
export function clipSample(text) {
    const value = String(text ?? '');
    if (value.length <= HEAD + TAIL + 200) return value;
    return `${value.slice(0, HEAD)}\n\n${i18nFormat('…(${0} characters omitted)…', value.length - HEAD - TAIL)}\n\n${value.slice(-TAIL)}`;
}

export function diagnoseUserPrompt(sample) {
    const info = inspectText(sample);
    const tags = info.tags.length
        ? info.tags.map(t => `${t.label}${t.kind === 'angle' ? i18n(' (angle brackets)') : t.kind === 'square' ? i18n(' (square brackets)') : i18n(' (comment)')} ×${t.count}${t.chars ? i18nFormat(', about ${0} characters', t.chars) : ''}`).join('\n')
        : i18n('(no tags found)');
    return [
        i18n('Structure counted beforehand by the program (for reference; the original text is authoritative):'),
        tags,
        i18nFormat('Text outside every tag block: about ${0} characters (about ${1} in total)', info.bareChars, info.totalChars),
        '',
        i18n('Latest AI reply (exactly as the memory graph reads it: line breaks collapsed to spaces, the user\'s own regexes already applied):'),
        '<reply>',
        clipSample(sample),
        '</reply>',
    ].join('\n');
}

/**
 * Turns the AI's answer into a plan, enforcing the bare-text rule.
 * @returns {{ black: string, white: string, body: 'bare'|'wrapped', reason: string, notes: string[] }}
 */
export function readDiagnosis(args, sample) {
    const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\uff0c\u3001]/) : []).map(x => String(x).trim()).filter(Boolean);
    const body = args?.body === 'wrapped' ? 'wrapped' : 'bare';
    let black = formatTagList(parseTagList(list(args?.black).join(',')));
    let white = formatTagList(parseTagList(list(args?.white).join(',')));
    const notes = [];
    if (body === 'bare' && white) {
        notes.push(i18n('The story is bare text and a whitelist would remove it, so the whitelist was cleared.'));
        white = '';
    }
    if (white && planWarnings({ black, white }, sample).includes('empty')) {
        notes.push(i18n('This whitelist would remove the sample reply entirely, so only the blacklist is used.'));
        white = '';
    }
    return { black, white, body, reason: String(args?.reason || '').trim(), notes };
}
