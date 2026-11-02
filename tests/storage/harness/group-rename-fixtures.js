import fs from 'node:fs';
import path from 'node:path';
import { createHook } from 'node:async_hooks';
import { expect } from '@jest/globals';

export const groupOptions = id => ({ isGroup: true, groupId: id });
export const HEADER = {
    user_name: 'Archivist', character_name: '', create_date: '2026-01-02T03:04:05Z',
    unknown_header: { retained: ['渡口', { exact: true }] },
    chat_metadata: { is_group_chat: true, integrity: 'original-integrity', note_prompt: 'Moonlit reeds', variables: { retained: ['🌙', null] }, unknown: { nested: 7 } },
};
export const MESSAGES = [
    { name: 'Guide', is_user: false, is_system: false, mes: 'Across the ford: 渡口 🌙 \\ reeds.', send_date: '2026-01-02T03:04:06Z', extra: { gen_id: 'kept-generation', unknown: { a: [1, null, false] } }, swipes: ['Across the ford: 渡口 🌙 \\ reeds.', 'Alternate'], swipe_id: 0, swipe_info: [{ extra: { retained: true } }, { extra: {} }], unknown_message: ['kept'] },
    { name: 'User', is_user: true, is_system: false, mes: 'Keep "every" word.\nAnd this line.', send_date: '2026-01-02T03:04:07Z', extra: { retained: { b: 2 } } },
];
export const STATES = new Map([
    ['memory_graph', { nodes: [{ id: 'ford', facts: ['north', '渡口'] }], edges: [], revision: 9, unknown: { exact: true } }],
    ['extension.v2', { records: [null, false, 0, '🌙'], nested: { retained: ['reeds'] } }],
    ['null-state', null], ['text-state', 'unquoted string state'], ['__proto__', { retained: 'namespace is data' }],
]);

const HEADER_WITHOUT_METADATA = { ...HEADER };
delete HEADER_WITHOUT_METADATA.chat_metadata;
export const ADMITTED_HEADERS = [
    ['absent metadata', HEADER_WITHOUT_METADATA],
    ...[
        ['null metadata', null], ['array metadata', [null, { retained: true }]],
        ['string metadata', 'retained metadata'], ['number metadata', 7], ['boolean metadata', false],
        ['absent embedded integrity', { retained: { exact: ['渡口', null] } }],
        ...[null, '', false, 17, ['token'], { token: 'retained' }].map(integrity => [
            `embedded integrity ${JSON.stringify(integrity)}`, { integrity, retained: { exact: true } },
        ]),
    ].map(([label, chat_metadata]) => [label, { ...HEADER_WITHOUT_METADATA, chat_metadata }]),
    ['prototype-like own fields', JSON.parse('{"__proto__":{"retained":true},"constructor":{"name":"retained"},"chat_metadata":{"__proto__":{"exact":true}}}')],
];

// Bypass ordinary write-time integrity insertion so the reader's admitted source
// document, rather than a normalized saveRaw result, is the preservation oracle.
export async function seedNative(repo, h, header, id = 'old') {
    const body = [...MESSAGES, null, 'admitted body value', [false, { retained: true }]];
    const updatedAt = 1_770_000_000_000, createdAt = 1_760_000_000_000;
    if (h.engine.kind === 'fs') {
        fs.mkdirSync(h.dirs.groupChats, { recursive: true });
        fs.writeFileSync(chatPath(h, id), [header, ...body].map(value => JSON.stringify(value)).join('\n') + '\n');
        fs.utimesSync(chatPath(h, id), updatedAt / 1000, updatedAt / 1000);
    } else {
        const values = [h.handle, '', id, 1, id, JSON.stringify({ header, body }), updatedAt, createdAt];
        await h.engine.withTransaction(h.handle, async tx => {
            const columns = '(handle, char_dir, name, is_group, group_id, doc, updated_at, created_at)';
            if (tx._db) tx._db.prepare(`INSERT INTO chats ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...values);
            else if (tx._conn) await tx._conn.execute(`INSERT INTO chats ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, values);
            else await tx._client.query(`INSERT INTO chats ${columns} VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`, values);
        });
    }
    const admitted = await repo.get(h.handle, '', id, groupOptions(id));
    expect(admitted.header).toEqual(header);
    expect(admitted.body).toEqual(body);
    for (const [namespace, value] of STATES) await repo.setState(h.handle, '', id, namespace, value, groupOptions(id));
    return capture(repo, h, id);
}

export const NATIVE_NUMBERS = [
    ['negative zero', '-0'], ['overflow number', '1e400'],
    ['wide integer', '9007199254740993'], ['precise decimal', '1.2345678901234567890123456789'],
];

export async function insertNativeParent(h, literal, id = 'old') {
    const header = `{ "user_name":"Archivist", "unknown_header":{"number":${literal},"text":"渡口 🌙"}, "chat_metadata":{"integrity":"native-token","number":${literal}} }`;
    const body = `[{"name":"Guide","mes":"Keep every native value.","extra":{"number":${literal},"retained":[null,false,"🌙"]}},null,"admitted scalar"]`;
    const updatedAt = 1_770_000_000_000, createdAt = 1_760_000_000_000;
    if (h.engine.kind === 'fs') {
        fs.mkdirSync(h.dirs.groupChats, { recursive: true });
        fs.writeFileSync(chatPath(h, id), `${header}\n\n${body.slice(1, -1).replace('},null,"admitted scalar"', '}\nnull\n"admitted scalar"')}\n`);
        fs.utimesSync(chatPath(h, id), updatedAt / 1000, updatedAt / 1000);
        return;
    }
    await h.engine.withTransaction(h.handle, async tx => {
        const values = [h.handle, '', id, 1, id, `{"header":${header},"body":${body},"native_extra":{"retained":${literal}}}`, updatedAt, createdAt];
        const columns = '(handle, char_dir, name, is_group, group_id, doc, updated_at, created_at)';
        if (tx._db) tx._db.prepare(`INSERT INTO chats ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...values);
        else if (tx._conn) await tx._conn.execute(`INSERT INTO chats ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, values);
        else await tx._client.query(`INSERT INTO chats ${columns} VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`, values);
    });
}

export async function insertNativeState(h, namespace, raw, id = 'old') {
    if (h.engine.kind === 'fs') return fs.writeFileSync(statePath(h, id, namespace), raw);
    await h.engine.withTransaction(h.handle, async tx => {
        const values = [h.handle, '', id, 1, id, namespace, raw];
        const columns = '(handle, char_dir, name, is_group, group_id, namespace, doc)';
        if (tx._db) tx._db.prepare(`INSERT INTO chat_states ${columns} VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...values);
        else if (tx._conn) await tx._conn.execute(`INSERT INTO chat_states ${columns} VALUES (?, ?, ?, ?, ?, ?, ?)`, values);
        else await tx._client.query(`INSERT INTO chat_states ${columns} VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`, values);
    });
}

export async function nativeSelected(h, id) {
    if (h.engine.kind === 'fs') {
        const parent = fs.readFileSync(chatPath(h, id)).toString('base64');
        const states = [];
        const namespaces = await h.engine.withTransaction(h.handle, tx => tx.listChatStateNamespaces({ kind: 'chat', handle: h.handle, charDir: '', name: id, ...groupOptions(id) }));
        for (const ns of namespaces.sort()) states.push([ns, fs.readFileSync(statePath(h, id, ns)).toString('base64')]);
        return { parent, states };
    }
    return h.engine.withTransaction(h.handle, async tx => {
        const args = [h.handle, '', id, 1, id];
        if (tx._db) return {
            parent: tx._db.prepare('SELECT doc FROM chats WHERE handle=? AND char_dir=? AND name=? AND is_group=? AND group_id=?').get(...args).doc,
            states: tx._db.prepare('SELECT namespace, doc FROM chat_states WHERE handle=? AND char_dir=? AND name=? AND is_group=? AND group_id=? ORDER BY namespace').all(...args).map(row => [row.namespace, row.doc]),
        };
        if (tx._conn) return {
            parent: (await tx._conn.execute('SELECT CAST(doc AS CHAR) AS doc FROM chats WHERE handle=? AND char_dir=? AND name=? AND is_group=? AND group_id=?', args))[0][0].doc,
            states: (await tx._conn.execute('SELECT namespace, CAST(doc AS CHAR) AS doc FROM chat_states WHERE handle=? AND char_dir=? AND name=? AND is_group=? AND group_id=? ORDER BY namespace', args))[0].map(row => [row.namespace, row.doc]),
        };
        return {
            parent: (await tx._client.query('SELECT doc::text AS doc FROM chats WHERE handle=$1 AND char_dir=$2 AND name=$3 AND is_group=$4 AND group_id=$5', args)).rows[0].doc,
            states: (await tx._client.query('SELECT namespace, doc::text AS doc FROM chat_states WHERE handle=$1 AND char_dir=$2 AND name=$3 AND is_group=$4 AND group_id=$5 ORDER BY namespace', args)).rows.map(row => [row.namespace, row.doc]),
        };
    });
}

export function numericPredicates(snapshot) {
    const flags = value => ({ negativeZero: Object.is(value, -0), positiveInfinity: value === Infinity, finite: Number.isFinite(value), type: typeof value, text: String(value) });
    return {
        metadata: flags(snapshot.chat.header.chat_metadata.number),
        header: flags(snapshot.chat.header.unknown_header.number),
        message: flags(snapshot.chat.body[0].extra.number),
        states: snapshot.states.map(([ns, value]) => [ns, flags(ns === 'nested' ? value.number : value)]),
    };
}

export async function seed(repo, h, id = 'old', options = groupOptions(id)) {
    await repo.saveRaw(h.handle, '', id, { header: HEADER, body: MESSAGES, integrity: HEADER.chat_metadata.integrity, updatedAt: 1_770_000_000_000, createdAt: 1_760_000_000_000 }, options);
    for (const [ns, value] of STATES) await repo.setState(h.handle, '', id, ns, value, options);
    return capture(repo, h, id, options);
}

export async function capture(repo, h, id, options = groupOptions(id)) {
    const chat = await repo.get(h.handle, '', id, options);
    const namespaces = (await repo.listStateNamespaces(h.handle, '', id, options)).sort();
    const states = [];
    for (const ns of namespaces) states.push([ns, await repo.getState(h.handle, '', id, ns, options)]);
    const result = { chat, states };
    recordPayload(h, `selected ${id}`, result);
    return result;
}

export function recordPayload(h, label, value) {
    if (!process.env.LUKER_RENAME_PAYLOAD_EVIDENCE) return;
    fs.appendFileSync(process.env.LUKER_RENAME_PAYLOAD_EVIDENCE, JSON.stringify({ test: expect.getState().currentTestName, engine: h.engine.kind, dataRoot: h.dataRoot, execArgv: process.execArgv, label, value }) + '\n');
}

export function expectMoved(actual, original, kind) {
    expect(actual.chat.header).toEqual(original.chat.header);
    expect(actual.chat.body).toEqual(original.chat.body);
    expect(actual.chat.integrity).toEqual(original.chat.integrity);
    expect(actual.chat.updatedAt).toBe(original.chat.updatedAt);
    if (kind !== 'fs') expect(actual.chat.createdAt).toBe(original.chat.createdAt);
    expect(actual.states).toEqual(original.states);
}

export function disk(h) {
    if (!fs.existsSync(h.dirs.groupChats)) return {};
    const result = Object.fromEntries(fs.readdirSync(h.dirs.groupChats).sort().map(name => {
        const file = path.join(h.dirs.groupChats, name), stat = fs.lstatSync(file);
        return [name, stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : stat.isDirectory() ? { directory: true } : { bytes: fs.readFileSync(file).toString('base64'), mtimeMs: stat.mtimeMs }];
    }));
    recordPayload(h, 'native directory bytes', result);
    return result;
}

export async function rawResources(h) {
    if (h.engine.kind === 'fs') return disk(h);
    const result = await h.engine.withTransaction(h.handle, async tx => {
        const order = ' ORDER BY char_dir, name, is_group, group_id';
        if (tx._db) return {
            chats: tx._db.prepare(`SELECT * FROM chats WHERE handle=?${order}`).all(h.handle),
            states: tx._db.prepare(`SELECT * FROM chat_states WHERE handle=?${order}, namespace`).all(h.handle),
        };
        if (tx._conn) return {
            chats: (await tx._conn.execute(`SELECT *, CAST(doc AS CHAR) AS raw_document FROM chats WHERE handle=?${order}`, [h.handle]))[0],
            states: (await tx._conn.execute(`SELECT *, CAST(doc AS CHAR) AS raw_document FROM chat_states WHERE handle=?${order}, namespace`, [h.handle]))[0],
        };
        return {
            chats: (await tx._client.query(`SELECT *, doc::text AS raw_document FROM chats WHERE handle=$1${order}`, [h.handle])).rows,
            states: (await tx._client.query(`SELECT *, doc::text AS raw_document FROM chat_states WHERE handle=$1${order}, namespace`, [h.handle])).rows,
        };
    });
    recordPayload(h, 'native SQL resources', result);
    return result;
}

export const chatPath = (h, id) => path.join(h.dirs.groupChats, `${id}.jsonl`);
export const statePath = (h, id, ns) => path.join(h.dirs.groupChats, `${id}.luker-state.${ns}.json`);

export function sameNativeEntry(first, second) {
    const a = fs.lstatSync(first, { bigint: true });
    let b;
    try { b = fs.lstatSync(second, { bigint: true }); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const sameObject = b !== undefined && a.dev === b.dev && a.ino === b.ino;
    if (process.env.LUKER_RENAME_PAYLOAD_EVIDENCE) {
        const identity = stat => ({ dev: stat.dev.toString(), ino: stat.ino.toString(), mode: stat.mode.toString() });
        fs.appendFileSync(process.env.LUKER_RENAME_PAYLOAD_EVIDENCE, JSON.stringify({ test: expect.getState().currentTestName, engine: 'fs', dataRoot: path.dirname(first), execArgv: process.execArgv, label: 'native selected-entry identity', value: { first, second, firstIdentity: identity(a), secondIdentity: b === undefined ? null : identity(b), sameObject } }) + '\n');
    }
    return sameObject;
}

export const NATIVE_STATE_SPELLINGS = [
    ['base case', (id, ns) => `${id.toUpperCase()}.luker-state.${ns}.json`],
    ['infix case', (id, ns) => `${id}.LUKER-STATE.${ns}.json`],
    ['suffix case', (id, ns) => `${id}.luker-state.${ns}.JSON`],
    ['combined case', (id, ns) => `${id.toUpperCase()}.LUKER-STATE.${ns}.JSON`],
    ['base normalization', (id, ns) => `${id.normalize('NFD')}.luker-state.${ns}.json`],
];

// Observe an async entry without replacing any application/engine method or result.
// The actor performs real competing writes at the selected ownership boundary.
export function onAsyncEntry(method, actor) {
    let reached = false, job;
    const hook = createHook({ init(_id, type) {
        if (reached || type !== 'PROMISE' || !new Error().stack.includes(`at ${method} (`)) return;
        reached = true;
        hook.disable();
        try { job = Promise.resolve(actor()).then(value => ({ value }), error => ({ error })); }
        catch (error) { job = Promise.resolve({ error }); }
    } });
    hook.enable();
    return async () => {
        hook.disable();
        expect(reached).toBe(true);
        const result = await job;
        if (result.error) throw result.error;
        return result.value;
    };
}

export async function corruptDocument(h, id, raw = '{"private":"PRIVATE_PAYLOAD",') {
    if (h.engine.kind === 'fs') return fs.writeFileSync(chatPath(h, id), raw);
    return h.engine.withTransaction(h.handle, async tx => {
        if (tx._db) tx._db.prepare('UPDATE chats SET doc=? WHERE handle=? AND name=?').run('null', h.handle, id);
        else if (tx._conn) await tx._conn.execute('UPDATE chats SET doc=CAST(? AS JSON) WHERE handle=? AND name=?', ['null', h.handle, id]);
        else await tx._client.query('UPDATE chats SET doc=$1::jsonb WHERE handle=$2 AND name=$3', ['null', h.handle, id]);
    });
}
