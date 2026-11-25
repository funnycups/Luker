import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../storage/harness/endpoint-harness.js';
import { router as charactersRouter, diskCache } from '../../src/endpoints/characters.js';
import { read as readCardChunk, write as writeCardChunk } from '../../src/character-card-parser.js';

const AVATAR = 'Alice.png';
afterAll(() => diskCache.dispose());
const CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: 'Alice',
    data: { name: 'Alice', description: '', extensions: {} },
};

const STORED_EMBED = {
    version: 1,
    items: [{ bundleFormat: 'inline-files-v1', name: 'stale', files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: stale\ndescription: stale\n---\n' }] }],
};

const presetWithEmbed = (temperature) => ({ temperature, extensions: { luker: { embedded_skills_source: STORED_EMBED } } });

const CARD_BOUND_LUKER = {
    chat_completion_preset: {
        presets: [
            { name: 'Night Watch', preset: presetWithEmbed(0.8) },
            { name: 'Plain', preset: { temperature: 1 } },
        ],
        defaultPresetName: 'Night Watch',
    },
    bound_preset: presetWithEmbed(0.5),
    preset: presetWithEmbed(0.6),
};

function seedCard(charsDir, { storedEmbed = false, luker = null } = {}) {
    const seedPath = fileURLToPath(new URL('../../default/content/default_Seraphina.png', import.meta.url));
    const card = storedEmbed
        ? { ...CARD, data: { ...CARD.data, extensions: { luker: { embedded_skills_source: STORED_EMBED } } } }
        : luker
            ? { ...CARD, data: { ...CARD.data, extensions: { luker } } }
            : CARD;
    const png = writeCardChunk(fs.readFileSync(seedPath), JSON.stringify(card));
    const filePath = path.join(charsDir, AVATAR);
    fs.writeFileSync(filePath, png);
    return filePath;
}

// Dotted paths of every `embedded_skills_source` key inside `value`.
function embedPaths(value, prefix = '') {
    if (!value || typeof value !== 'object') return [];
    const out = [];
    for (const [key, child] of Object.entries(value)) {
        const here = prefix ? `${prefix}.${key}` : key;
        if (key === 'embedded_skills_source') out.push(here);
        out.push(...embedPaths(child, here));
    }
    return out;
}

function seedCharacterSkill(root, name) {
    const dir = path.join(root, 'skills', 'character', AVATAR, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\nBody of ${name}\n`);
}

function binaryParser(res, callback) {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function exportCard(app, format, extra = {}) {
    const req = request(app)
        .post('/api/characters/export')
        .send({ format, avatar_url: AVATAR, ...extra })
        .expect(200);
    if (format === 'png') req.buffer(true).parse(binaryParser);
    const res = await req;
    const card = format === 'png'
        ? JSON.parse(readCardChunk(res.body))
        : JSON.parse(res.text);
    return { res, card };
}

function decodeWarnings(res) {
    const header = res.headers['x-luker-export-warning'];
    if (!header) return [];
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

describe.each(ENDPOINT_HARNESSES)('character export skill bundling on $name', ({ mode }) => {
    let harness;
    let cardPath;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => app.use('/api/characters', charactersRouter),
        });
        cardPath = seedCard(harness.dirs.characters);
    });


    test.each(['png', 'json'])('%s export without includeSkills leaves the embed field absent', async (format) => {
        seedCharacterSkill(harness.dirs.root, 'alpha');
        const { res, card } = await exportCard(harness.app, format);
        expect(card.data.extensions.luker?.embedded_skills_source).toBeUndefined();
        expect(decodeWarnings(res)).toEqual([]);
    });

    test.each(['png', 'json'])('%s export with includeSkills packs every character-scope skill', async (format) => {
        seedCharacterSkill(harness.dirs.root, 'alpha');
        seedCharacterSkill(harness.dirs.root, 'beta');
        const before = fs.readFileSync(cardPath);

        const { res, card } = await exportCard(harness.app, format, { includeSkills: true });

        const payload = card.data.extensions.luker.embedded_skills_source;
        expect(payload.version).toBe(1);
        expect(payload.items.map(i => i.name).sort()).toEqual(['alpha', 'beta']);
        expect(decodeWarnings(res)).toEqual([]);

        const after = fs.readFileSync(cardPath);
        expect(after.equals(before)).toBe(true);
        expect(JSON.parse(readCardChunk(after)).data.extensions.luker).toBeUndefined();
    });

    test('includeSkills with an empty character scope leaves the embed field absent', async () => {
        const { res, card } = await exportCard(harness.app, 'png', { includeSkills: true });
        expect(card.data.extensions.luker?.embedded_skills_source).toBeUndefined();
        expect(decodeWarnings(res)).toEqual([]);
    });

    describe('card that already stores bundled skills', () => {
        let before;

        beforeEach(() => {
            cardPath = seedCard(harness.dirs.characters, { storedEmbed: true });
            before = fs.readFileSync(cardPath);
        });

        function expectStoredCardUnchanged() {
            const after = fs.readFileSync(cardPath);
            expect(after.equals(before)).toBe(true);
            expect(JSON.parse(readCardChunk(after)).data.extensions.luker.embedded_skills_source).toEqual(STORED_EMBED);
        }

        test.each(['png', 'json'])('%s export without includeSkills drops the stored embed from the exported copy', async (format) => {
            seedCharacterSkill(harness.dirs.root, 'alpha');
            const { card } = await exportCard(harness.app, format);
            expect(card.data.extensions.luker?.embedded_skills_source).toBeUndefined();
            expectStoredCardUnchanged();
        });

        test.each(['png', 'json'])('%s export with includeSkills and no installed skills drops the stored embed', async (format) => {
            const { res, card } = await exportCard(harness.app, format, { includeSkills: true });
            expect(card.data.extensions.luker?.embedded_skills_source).toBeUndefined();
            expect(decodeWarnings(res)).toEqual([]);
            expectStoredCardUnchanged();
        });

        test('export with includeSkills replaces the stored embed with the installed skills', async () => {
            seedCharacterSkill(harness.dirs.root, 'alpha');
            const { card } = await exportCard(harness.app, 'png', { includeSkills: true });
            expect(card.data.extensions.luker.embedded_skills_source.items.map(i => i.name)).toEqual(['alpha']);
            expectStoredCardUnchanged();
        });

        test('a failed skill pack drops the stored embed', async () => {
            const scopeDir = path.join(harness.dirs.root, 'skills', 'character');
            fs.mkdirSync(scopeDir, { recursive: true });
            fs.writeFileSync(path.join(scopeDir, AVATAR), 'not a directory');
            const { res, card } = await exportCard(harness.app, 'json', { includeSkills: true });
            expect(card.data.extensions.luker?.embedded_skills_source).toBeUndefined();
            expect(decodeWarnings(res).map(w => w.reason)).toEqual(['skills_pack_failed']);
            expectStoredCardUnchanged();
        });
    });

    describe('card whose card-bound presets carry bundled skills', () => {
        let before;

        beforeEach(() => {
            cardPath = seedCard(harness.dirs.characters, { luker: CARD_BOUND_LUKER });
            before = fs.readFileSync(cardPath);
        });

        function expectStoredCardUnchanged() {
            const after = fs.readFileSync(cardPath);
            expect(after.equals(before)).toBe(true);
            expect(JSON.parse(readCardChunk(after)).data.extensions.luker).toEqual(CARD_BOUND_LUKER);
        }

        test.each(['png', 'json'])('%s export without includeSkills carries no bundled skills anywhere', async (format) => {
            seedCharacterSkill(harness.dirs.root, 'alpha');
            const { card } = await exportCard(harness.app, format);
            expect(embedPaths(card)).toEqual([]);
            expect(card.data.extensions.luker.chat_completion_preset.presets.map(p => p.preset.temperature)).toEqual([0.8, 1]);
            expectStoredCardUnchanged();
        });

        test('export with includeSkills and no installed skills carries no bundled skills anywhere', async () => {
            const { card } = await exportCard(harness.app, 'json', { includeSkills: true });
            expect(embedPaths(card)).toEqual([]);
            expectStoredCardUnchanged();
        });

        test('export with includeSkills carries only the freshly packed character scope', async () => {
            seedCharacterSkill(harness.dirs.root, 'alpha');
            const { card } = await exportCard(harness.app, 'png', { includeSkills: true });
            expect(embedPaths(card)).toEqual(['data.extensions.luker.embedded_skills_source']);
            expect(card.data.extensions.luker.embedded_skills_source.items.map(i => i.name)).toEqual(['alpha']);
            expectStoredCardUnchanged();
        });

        test('a failed skill pack carries no bundled skills anywhere', async () => {
            const scopeDir = path.join(harness.dirs.root, 'skills', 'character');
            fs.mkdirSync(scopeDir, { recursive: true });
            fs.writeFileSync(path.join(scopeDir, AVATAR), 'not a directory');
            const { res, card } = await exportCard(harness.app, 'json', { includeSkills: true });
            expect(embedPaths(card)).toEqual([]);
            expect(decodeWarnings(res).map(w => w.reason)).toEqual(['skills_pack_failed']);
            expectStoredCardUnchanged();
        });
    });

    test('a failed skill pack still exports the card and sets the warning header', async () => {
        const scopeDir = path.join(harness.dirs.root, 'skills', 'character');
        fs.mkdirSync(scopeDir, { recursive: true });
        // A file where the scope directory should be makes the scope listing throw.
        fs.writeFileSync(path.join(scopeDir, AVATAR), 'not a directory');

        const { res, card } = await exportCard(harness.app, 'json', { includeSkills: true });

        expect(card.data.name).toBe('Alice');
        expect(card.data.extensions.luker?.embedded_skills_source).toBeUndefined();
        expect(decodeWarnings(res).map(w => w.reason)).toEqual(['skills_pack_failed']);
    });
});
