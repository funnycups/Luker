import { isDeepStrictEqual } from 'node:util';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import encode from '../../png/encode.js';
import { write as writeCardData } from '../../character-card-parser.js';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isDate = value => typeof value === 'number' && Number.isFinite(value);
const has = (doc, key) => isObject(doc) && Object.hasOwn(doc, key);
const valueOf = (doc, key) => (has(doc, key) ? doc[key] : undefined);

/**
 * Three-way pick of one value, `undefined` meaning absent: the side that
 * changed it from base, or ours when both agree. `conflicted` is true when
 * both changed it to different values; ours is then returned.
 */
function pick3(b, o, t) {
    if (isDeepStrictEqual(o, t)) return { value: o, conflicted: false };
    if (isDeepStrictEqual(o, b)) return { value: t, conflicted: false };
    if (isDeepStrictEqual(t, b)) return { value: o, conflicted: false };
    return { value: o, conflicted: true };
}

/** Keys of ours in order, then the keys only theirs has. */
const keysOf = (o, t) => [...new Set([...Object.keys(o), ...Object.keys(t)])];

/** True when every side that holds `key` holds a finite number. */
const datesUsable = (key, ...docs) => docs.every(doc => !has(doc, key) || isDate(doc[key]));

/**
 * Merge the date `key` with `combine` when both sides hold numbers there,
 * else three-way like any other field.
 */
function mergeDate(key, b, o, t, combine) {
    if (!datesUsable(key, o, t)) return pick3(valueOf(b, key), valueOf(o, key), valueOf(t, key));
    const values = [o, t].filter(doc => has(doc, key)).map(doc => doc[key]);
    return { value: values.length > 0 ? combine(...values) : undefined, conflicted: false };
}

/**
 * The side whose date `key` is `pick`-ed, ours on a tie, a side without
 * the date counting as `missing`; null when a side holds a non-number.
 */
function sideByDate(key, o, t, pick, missing) {
    if (!datesUsable(key, o, t)) return null;
    const at = doc => (has(doc, key) ? doc[key] : missing);
    return pick(at(o), at(t)) === at(t) && at(t) !== at(o) ? t : o;
}

/**
 * Three-way merge of a group document. The fields every chat save and
 * chat switch rewrites never conflict: `date_last_chat` takes the later
 * value, `chat_size` comes from the side that chatted later, ours on a
 * tie, `chats` lists ours' ids then theirs' extras, without the ids one
 * side removed from base, and `chat_id` comes from the side that chatted
 * later when `chats` lists it, else from the other side when listed, else
 * it is the last listed id; an empty `chats` keeps that side's id. The
 * group list read stamps `date_added` from the file's birth time on each
 * device and derives `create_date` from it (`listGroupsWithChatStats` in
 * `src/storage/engines/fs-engine-transaction.js`), and the next group
 * save stores both, so `date_added` takes the earlier value and
 * `create_date` comes from the same side. A date that is not a number on
 * either side merges three-way and decides no side, so the fields that
 * follow it merge three-way too. Every other field merges three-way; a
 * field both sides changed to different values keeps ours and sets
 * `conflicted`.
 *
 * @param {unknown} base
 * @param {unknown} ours
 * @param {unknown} theirs
 * @returns {{ value: object, conflicted: boolean } | null} null when ours or theirs is not an object
 */
export function mergeGroupDocuments(base, ours, theirs) {
    if (!isObject(ours) || !isObject(theirs)) return null;
    const b = isObject(base) ? base : {};
    const later = sideByDate('date_last_chat', ours, theirs, Math.max, -Infinity);
    const earlier = sideByDate('date_added', ours, theirs, Math.min, Infinity);
    const otherOf = side => (side === ours ? theirs : ours);
    const fromSide = (side, key) => (has(side, key) ? side[key] : otherOf(side)[key]);
    const chats = Array.isArray(ours.chats) && Array.isArray(theirs.chats) ? mergeChatIds(b.chats, ours.chats, theirs.chats) : null;
    let conflicted = false;
    const out = [];
    const put = (key, picked) => {
        conflicted ||= picked.conflicted;
        if (picked.value !== undefined) out.push([key, picked.value]);
    };
    const three = key => pick3(valueOf(b, key), valueOf(ours, key), valueOf(theirs, key));
    for (const key of keysOf(ours, theirs)) {
        if (key === 'date_last_chat') {
            put(key, mergeDate(key, b, ours, theirs, Math.max));
        } else if (key === 'date_added') {
            put(key, mergeDate(key, b, ours, theirs, Math.min));
        } else if (key === 'create_date') {
            put(key, earlier ? { value: fromSide(earlier, key), conflicted: false } : three(key));
        } else if (key === 'chat_size') {
            put(key, later ? { value: fromSide(later, key), conflicted: false } : three(key));
        } else if (key === 'chat_id') {
            const byRecency = chatIdsByRecency(ours, theirs);
            const picked = byRecency ? { value: byRecency[0], conflicted: false } : three(key);
            if (chats) picked.value = chooseChatId(byRecency ?? [picked.value], chats);
            put(key, picked);
        } else if (key === 'chats' && chats) {
            put(key, { value: chats, conflicted: false });
        } else {
            put(key, three(key));
        }
    }
    return { value: Object.fromEntries(out), conflicted };
}

/**
 * The chat ids of the side that chatted later, ours on a tie, then of the
 * other side; null when either is not an object or a `date_last_chat` is
 * not a number.
 *
 * @param {unknown} ours
 * @param {unknown} theirs
 * @returns {unknown[] | null}
 */
export function chatIdsByRecency(ours, theirs) {
    if (!isObject(ours) || !isObject(theirs)) return null;
    const later = sideByDate('date_last_chat', ours, theirs, Math.max, -Infinity);
    if (!later) return null;
    const other = later === ours ? theirs : ours;
    return [has(later, 'chat_id') ? later.chat_id : other.chat_id, other.chat_id];
}

/**
 * The first of `candidates` that `chats` lists, else the last listed id;
 * the first defined candidate when `chats` is empty.
 *
 * @param {unknown[]} candidates
 * @param {unknown[]} chats
 * @returns {unknown}
 */
export function chooseChatId(candidates, chats) {
    const listed = candidates.find(id => id !== undefined && chats.includes(id));
    if (listed !== undefined) return listed;
    return chats.length > 0 ? chats.at(-1) : candidates.find(id => id !== undefined);
}

/** Ours' chat ids then theirs' extras, without the ids base listed and one side removed. */
function mergeChatIds(baseChats, oursChats, theirsChats) {
    const listed = Array.isArray(baseChats) ? baseChats : [];
    const removed = id => listed.includes(id) && !(oursChats.includes(id) && theirsChats.includes(id));
    return [...new Set([...oursChats, ...theirsChats])].filter(id => !removed(id));
}

/** Card fields a chat switch or chat save rewrites. */
const CARD_BOOKKEEPING_FIELDS = Object.freeze(['chat', 'date_last_chat']);

const isCardChunk = chunk => {
    if (chunk.name !== 'tEXt') return false;
    const keyword = PNGtext.decode(chunk.data).keyword.toLowerCase();
    return keyword === 'chara' || keyword === 'ccv3';
};

const SPEC_FIELDS = Object.freeze(['spec', 'spec_version']);

function without(card, fields) {
    const rest = { ...card };
    for (const field of fields) delete rest[field];
    return rest;
}

const withoutBookkeeping = card => without(card, CARD_BOOKKEEPING_FIELDS);

/**
 * The card JSON of a PNG, from the `chara` chunk `write` stores, and the
 * PNG without its card chunks. `write` derives the `ccv3` chunk from the
 * same JSON and `read` prefers `ccv3`, so a card whose `ccv3` chunk holds
 * anything apart from its spec and bookkeeping fields that `chara` lacks
 * gives null, as does a card without a `chara` chunk: rebuilding either
 * from `chara` would drop what `ccv3` holds.
 *
 * @param {Buffer | null} bytes
 * @returns {{ card: object, image: Buffer } | null}
 */
function splitCardPng(bytes) {
    if (!bytes) return null;
    try {
        const chunks = extract(new Uint8Array(bytes));
        const texts = chunks.filter(chunk => chunk.name === 'tEXt').map(chunk => PNGtext.decode(chunk.data));
        const cardOf = keyword => {
            const text = texts.find(t => t.keyword.toLowerCase() === keyword);
            return text ? JSON.parse(Buffer.from(text.text, 'base64').toString('utf8')) : undefined;
        };
        const card = cardOf('chara');
        if (!isObject(card)) return null;
        const v3 = cardOf('ccv3');
        const comparable = value => without(value, [...SPEC_FIELDS, ...CARD_BOOKKEEPING_FIELDS]);
        if (v3 !== undefined && !(isObject(v3) && isDeepStrictEqual(comparable(v3), comparable(card)))) return null;
        return { card, image: Buffer.from(encode(chunks.filter(chunk => !isCardChunk(chunk)))) };
    } catch {
        return null;
    }
}

/**
 * Three-way merge of a character card PNG. The image and the card apart
 * from its bookkeeping fields each take the side that changed them, or
 * ours when both sides agree; when both sides changed either of them
 * differently the result keeps ours and is `conflicted`. Of the
 * bookkeeping fields, `date_last_chat` takes the later value and `chat`
 * merges three-way, coming from the side that chatted later when both
 * changed it, ours on a tie. A `date_last_chat` that is not a number on
 * either side merges three-way and decides no side, so a `chat` both
 * sides changed is then `conflicted`. The card is written with
 * `character-card-parser`'s `write`, so both devices write the same bytes.
 *
 * @param {Buffer | null} baseBytes
 * @param {Buffer} oursBytes
 * @param {Buffer} theirsBytes
 * @returns {{ bytes: Buffer, conflicted: boolean } | null} null when ours or theirs holds no card `write` can rebuild
 */
export function mergeCharacterCards(baseBytes, oursBytes, theirsBytes) {
    const o = splitCardPng(oursBytes);
    const t = splitCardPng(theirsBytes);
    if (!o || !t) return null;
    const b = splitCardPng(baseBytes);
    const sideOf = (equal, oursValue, theirsValue, baseValue) => {
        if (equal(oursValue, theirsValue) || (b && equal(theirsValue, baseValue))) return o;
        if (b && equal(oursValue, baseValue)) return t;
        return null;
    };
    const imageSide = sideOf((x, y) => x.equals(y), o.image, t.image, b?.image);
    const restSide = sideOf(isDeepStrictEqual, withoutBookkeeping(o.card), withoutBookkeeping(t.card), b && withoutBookkeeping(b.card));
    const card = { ...(restSide ?? o).card };
    const later = sideByDate('date_last_chat', o.card, t.card, Math.max, -Infinity);
    const chat = pick3(valueOf(b?.card, 'chat'), valueOf(o.card, 'chat'), valueOf(t.card, 'chat'));
    const chatPicked = chat.conflicted && later ? { value: valueOf(later, 'chat'), conflicted: false } : chat;
    const date = mergeDate('date_last_chat', b?.card, o.card, t.card, Math.max);
    for (const [field, picked] of [['chat', chatPicked], ['date_last_chat', date]]) {
        if (picked.value === undefined) delete card[field];
        else card[field] = picked.value;
    }
    const conflicted = restSide === null || imageSide === null || chatPicked.conflicted || date.conflicted;
    return { bytes: writeCardData((imageSide ?? o).image, JSON.stringify(card)), conflicted };
}
