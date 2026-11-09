// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ready-made memory structures. A template replaces the editor's type list
// (unsaved until saved). The event type is always kept as it is: memory-graph
// relies on it. Built-in ids (character_sheet / location_state / thread)
// reuse Luker's own default spec, so its tuned rules come along.

import { i18n } from '../i18n.js';

const col = (key, label, hint) => ({ key, label, hint });

/** A type the template defines itself. */
function custom(id, label, intro, columns, { always = false, latest = true, required = ['title'], keywords = [] } = {}) {
    return { id, label, intro, columns, always, latest, required, keywords };
}

export const TEMPLATES = [
    {
        id: 'simple',
        name: i18n('Streamlined'),
        note: i18n('Records only events, characters and plot threads. Few entries, low cost, good for cheap models.'),
        types: ['character_sheet', 'thread'],
    },
    {
        id: 'romance',
        name: i18n('Romance and daily life'),
        note: i18n('Focuses on how the relationship changes, promises and memorable moments.'),
        types: [
            'character_sheet',
            custom('relationship', i18n('Relationship'), i18n('The long-term state between two characters. Update only when the relationship really changes.'), [
                col('title', i18n('Both sides'), i18n('Names of both sides, in the format "A × B"')),
                col('stage', i18n('Relationship stage'), i18n('Current stage, for example: just met, flirting, dating, cold war')),
                col('feeling', i18n('Feelings'), i18n('How each side truly feels about the other now, in a sentence or two')),
                col('promise', i18n('Promises'), i18n('Promises between them not yet kept; leave empty if none')),
            ], { always: true, required: ['title', 'stage'], keywords: [i18n('Relationship'), i18n('feelings'), i18n('Promises'), i18n('confession')] }),
            custom('moment', i18n('Memorable moment'), i18n('Important moments worth bringing up later: firsts, confessions, gifts, fights and making up. Not ordinary daily life.'), [
                col('title', i18n('Name'), i18n('A short name, for example: first date')),
                col('when', i18n('Time'), i18n('Time in the story, for example: evening of the third day')),
                col('detail', i18n('What happened'), i18n('What happened and the key things said, at most 80 characters')),
                col('meaning', i18n('Meaning'), i18n('How this affected their relationship')),
            ], { latest: false, keywords: [i18n('anniversary'), i18n('first time'), i18n('gift'), i18n('memory')] }),
            'location_state',
        ],
    },
    {
        id: 'adventure',
        name: i18n('Fantasy adventure'),
        note: i18n('Records quest progress, important items and factions. Good for tabletop-style play and long adventures.'),
        types: [
            'character_sheet',
            'location_state',
            custom('quest', i18n('Quest'), i18n('A quest or commission with a clear goal that lasts several turns or more.'), [
                col('title', i18n('Quest name'), i18n('A short quest name, at most 10 characters')),
                col('status', i18n('State'), i18n('Only one of: in progress / completed / failed / abandoned')),
                col('goal', i18n('Goal'), i18n('What must be achieved and who asked for it')),
                col('progress', i18n('Progress'), i18n('How far it has got and what to do next')),
                col('reward', i18n('Reward'), i18n('The promised reward; leave empty if none')),
            ], { always: true, required: ['title', 'status', 'goal'], keywords: [i18n('Quest'), i18n('commission'), i18n('Goal')] }),
            custom('item', i18n('Item'), i18n('Important items that affect the plot: keys, tokens, artifacts, key props. Not ordinary consumables.'), [
                col('title', i18n('Name'), i18n('The formal name of the item')),
                col('owner', i18n('Holder'), i18n('Who has it now; write "whereabouts unknown" if lost')),
                col('effect', i18n('What it does'), i18n('What it can do and its limits')),
                col('state', i18n('State'), i18n('Intact, damaged, used up and so on')),
            ], { keywords: [i18n('Item'), i18n('prop'), i18n('equipment'), i18n('artifact')] }),
            custom('faction', i18n('Faction'), i18n('Groups such as organizations, countries, sects and guilds.'), [
                col('title', i18n('Name'), i18n('The formal name of the faction')),
                col('leader', i18n('Leader'), i18n('Who leads it now')),
                col('stance', i18n('Stance'), i18n('Friendly, neutral or hostile toward the protagonists, and why')),
                col('note', i18n('Key points'), i18n('Long-lasting facts such as size, base and purpose, at most 60 characters')),
            ], { keywords: [i18n('Faction'), i18n('organization'), i18n('camp'), i18n('country')] }),
        ],
    },
    {
        id: 'mystery',
        name: i18n('Mystery'),
        note: i18n('Records clues and open questions, so the AI stays consistent and does not give away answers.'),
        types: [
            'character_sheet',
            'location_state',
            custom('clue', i18n('Clue'), i18n('Specific evidence or testimony found during the investigation.'), [
                col('title', i18n('Name'), i18n('A short name, for example: bloodstained handkerchief')),
                col('found', i18n('How it was found'), i18n('Where, by whom and when it was found')),
                col('content', i18n('Content'), i18n('What the clue itself shows; facts only, no speculation')),
                col('points_to', i18n('Points to'), i18n('Which person or open question it seems related to')),
            ], { required: ['title', 'content'], keywords: [i18n('Clue'), i18n('evidence'), i18n('testimony')] }),
            custom('question', i18n('Open question'), i18n('A puzzle not yet solved. Once solved, set the state to "solved" and write the answer.'), [
                col('title', i18n('Question'), i18n('Write it as a question, for example: how did the killer leave the locked room')),
                col('status', i18n('State'), i18n('Only one of: unsolved / solved')),
                col('known', i18n('Known'), i18n('Relevant facts known so far')),
                col('suspects', i18n('Suspects'), i18n('Possible answers or suspects')),
            ], { always: true, required: ['title', 'status'], keywords: [i18n('puzzle'), i18n('Open question'), i18n('truth'), i18n('Suspects')] }),
        ],
    },
    {
        id: 'life',
        name: i18n('Life simulation'),
        note: i18n('Records schedules, to-dos and belongings. Good for daily life, management and raising stories.'),
        types: [
            'character_sheet',
            custom('status', i18n('State'), i18n('A character\'s changing state: stamina, mood, money, skill levels and so on.'), [
                col('title', i18n('Character sheet'), i18n('Whose state this is; name only')),
                col('condition', i18n('Body and mood'), i18n('Current stamina, health and mood')),
                col('money', i18n('Money'), i18n('Money on hand, as a specific number')),
                col('skills', i18n('Skill list'), i18n('Learned skills and proficiency')),
            ], { always: true, keywords: [i18n('State'), i18n('stamina'), i18n('mood'), i18n('Money')] }),
            custom('todo', i18n('To-do'), i18n('Things promised or planned.'), [
                col('title', i18n('Task'), i18n('The thing to do, in one sentence')),
                col('status', i18n('State'), i18n('Only one of: to do / done / cancelled')),
                col('due', i18n('Time'), i18n('When it must be done; leave empty if none')),
                col('note', i18n('Side notes'), i18n('Who is involved and what to prepare')),
            ], { always: true, required: ['title', 'status'], keywords: [i18n('To-do'), i18n('plan'), i18n('arranged'), i18n('schedule')] }),
            custom('belonging', i18n('Item'), i18n('Things a character owns or receives.'), [
                col('title', i18n('Name'), i18n('Item name')),
                col('owner', i18n('Owner'), i18n('Who it belongs to')),
                col('count', i18n('Quantity'), i18n('How many')),
                col('note', i18n('Explanation'), i18n('Origin or use, in one sentence')),
            ], { keywords: [i18n('Item'), i18n('gift'), i18n('buy'), i18n('obtain')] }),
            'location_state',
        ],
    },
];

/** Converts a template's own type into a memory-graph spec. */
function toSpec(def) {
    const keys = def.columns.map(c => c.key);
    return {
        id: def.id,
        label: def.label,
        tableName: `${def.id}_table`,
        tableColumns: keys,
        embeddingColumns: keys.slice(),
        level: 'semantic',
        extractHint: def.intro,
        extractionInstructions: '',
        extractEveryN: 1,
        keywords: def.keywords.slice(),
        columnHints: Object.fromEntries(def.columns.map(c => [c.key, c.hint])),
        requiredColumns: def.required.filter(k => keys.includes(k)),
        forceUpdate: false,
        editable: true,
        alwaysInject: def.always,
        latestOnly: def.latest,
        primaryKeyColumns: def.latest && keys.includes('title') ? ['title'] : [],
        compression: { mode: 'none', threshold: 6, fanIn: 3, maxDepth: 6, keepRecentLeaves: 0, summarizeInstruction: '' },
    };
}

/**
 * The type list a template produces.
 * @param {object} template one of TEMPLATES
 * @param {object[]} current specs now in the editor (its event type is kept)
 * @param {object[]} defaults Luker's default specs
 * @returns {{ types: object[], labels: object }} labels: column names to show
 */
export function buildTemplate(template, current = [], defaults = []) {
    const byId = (specs, id) => (specs || []).find(s => String(s?.id) === id);
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const types = [];
    const labels = {};
    const event = byId(current, 'event') || byId(defaults, 'event');
    if (event) types.push(clone(event));
    for (const entry of template.types) {
        if (typeof entry === 'string') {
            const spec = byId(defaults, entry) || byId(current, entry);
            if (spec) types.push(clone(spec));
            continue;
        }
        types.push(toSpec(entry));
        labels[entry.id] = Object.fromEntries(entry.columns.map(c => [c.key, c.label]));
    }
    return { types, labels };
}

/** Names of the types a template contains, for the picker. */
export function templateTypeNames(template, nameOf) {
    return ['event', ...template.types].map(entry => (typeof entry === 'string' ? nameOf(entry) : entry.label));
}
