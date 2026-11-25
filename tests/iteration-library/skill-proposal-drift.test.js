// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Skill proposals staged by the iter-studio popups must not overwrite a
 * file that changed on disk between propose and approve. Runs the real
 * skill tool, the real ProposalBus, the real skill-registry target, the
 * browser skills API and the REST router over a real on-disk repository.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { createSkillsRouter } from '../../src/endpoints/skills.js';
import { createSkillRepository } from '../../src/skills/repository.js';

jest.unstable_mockModule('../../public/script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

const { skillsApi } = await import('../../public/scripts/skills/api.js');
const { createBus } = await import('/scripts/iteration-library/proposal-bus/bus.js');
const { clearRegistry } = await import('/scripts/iteration-library/storage/target-registry.js');
const { skillAuthor } = await import('/scripts/iteration-library/proposal-bus/kinds/skill-author.js');
const { runSkillIterStudioTool, ensureSkillRegistryTarget } = await import('/scripts/iteration-library/tools/skill-iter-studio.js');

const GLOBAL = { kind: 'global' };
const NAME = 'harbor-watch';
const SEED = '---\nname: harbor-watch\ndescription: Keep the harbor watch.\n---\n\nRing the bell at dusk.\n';
const PROPOSED = '---\nname: harbor-watch\ndescription: Keep the harbor watch.\n---\n\nRing the bell at dusk and dawn.\n';
const EXTERNAL = '---\nname: harbor-watch\ndescription: Keep the harbor watch.\n---\n\nRing the bell at dusk. Log every ship.\n';

const sha256 = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');

let server;
let realFetch;
let previousLuker;
let tmpRoot;
let repo;

beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/skills', createSkillsRouter({ getRepository: () => repo, getMemoryIndex: () => null }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => realFetch(String(url).startsWith('/') ? `${base}${url}` : url, opts);
    previousLuker = globalThis.Luker;
    globalThis.Luker = {
        getContext: () => ({ skills: skillsApi, lib: { yaml: { parse: parseYaml, stringify: stringifyYaml } } }),
    };
});

afterAll(async () => {
    globalThis.fetch = realFetch;
    globalThis.Luker = previousLuker;
    await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
    clearRegistry();
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'skill-drift-'));
    repo = createSkillRepository(tmpRoot);
    await repo.install({
        scope: GLOBAL,
        payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: SEED }] },
    });
});

afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});

function skillMdPath() {
    return join(tmpRoot, 'skills', 'global', NAME, 'SKILL.md');
}

// Same propose shape the CPA and orchestrator popups use.
async function stage(bus, call) {
    const out = await runSkillIterStudioTool(call, { getWorkingProfile: () => null });
    if (!out?.ok || !out.pendingSkillEdit) throw new Error(`tool did not stage: ${JSON.stringify(out)}`);
    const sk = out.pendingSkillEdit;
    const stableShape = { skillName: sk.skillName || '', scope: sk.scope || null, path: sk.path || '' };
    const { id } = await bus.propose({
        kind: 'skill-author',
        target: { type: 'skill-registry', name: stableShape.skillName, path: stableShape.path, _op: sk.op },
        before: stableShape,
        after: stableShape,
        sourceCallId: 'call-1',
        meta: { op: sk.op, skillName: sk.skillName, scope: sk.scope, path: sk.path, before: sk.before, after: sk.after },
    });
    return { id, op: sk.op };
}

function newBus() {
    ensureSkillRegistryTarget();
    const bus = createBus();
    bus.registerKind('skill-author', skillAuthor);
    return bus;
}

describe('skill proposal drift guard', () => {
    test('readFile reports the sha256 of the full file', async () => {
        const out = await skillsApi.readFile({ scope: GLOBAL, name: NAME, path: 'SKILL.md', offset: 2, limit: 1 });
        expect(out.sha256).toBe(sha256(SEED));
    });

    test('skill_update_content pins the propose-time content hash', async () => {
        const bus = newBus();
        const { op } = await stage(bus, {
            name: 'skill_update_content',
            args: { scope: GLOBAL, name: NAME, path: 'SKILL.md', content: PROPOSED },
        });
        expect(op.args.expectedSha256).toBe(sha256(SEED));
    });

    test('approve after an external edit parks the full-file write as a conflict', async () => {
        const bus = newBus();
        const { id } = await stage(bus, {
            name: 'skill_update_content',
            args: { scope: GLOBAL, name: NAME, path: 'SKILL.md', content: PROPOSED },
        });
        await fs.writeFile(skillMdPath(), EXTERNAL);

        const out = await bus.approve(id);

        expect(out.status).toBe('conflict');
        const entry = bus.listEntries().find((e) => e.id === id);
        expect(entry.status).toBe('conflict');
        expect(entry.conflictError.reason).toBe('CONFLICT');
        expect(entry.conflictError.hint).toMatch(/changed on disk/);
        expect(await fs.readFile(skillMdPath(), 'utf8')).toBe(EXTERNAL);
    });

    test('approve without an external edit commits the full-file write', async () => {
        const bus = newBus();
        const { id } = await stage(bus, {
            name: 'skill_update_content',
            args: { scope: GLOBAL, name: NAME, path: 'SKILL.md', content: PROPOSED },
        });
        const out = await bus.approve(id);
        expect(out.status).toBe('committed');
        expect(await fs.readFile(skillMdPath(), 'utf8')).toBe(PROPOSED);
    });

    test('irreversible skill commits survive direct and message rollback without another disk write', async () => {
        const bus = newBus();
        const { id } = await stage(bus, {
            name: 'skill_update_content', args: { scope: GLOBAL, name: NAME, path: 'SKILL.md', content: PROPOSED },
        });
        expect((await bus.approve(id)).status).toBe('committed');
        const committed = await fs.stat(skillMdPath());
        expect(await bus.rollback(id)).toEqual({ ok: false, status: 'committed', reason: 'not_reversible' });
        const message = { id: 'm1', toolCalls: [{ id: 'call-1' }] };
        expect(bus.countCommittedInMessages([message])).toBe(0);
        expect((await bus.rollbackAllInMessages([message])).results).toEqual([]);
        expect((await bus.rollbackAllInTurn(message)).results).toEqual([]);
        expect(await fs.readFile(skillMdPath(), 'utf8')).toBe(PROPOSED);
        expect((await fs.stat(skillMdPath())).mtimeMs).toBe(committed.mtimeMs);
        expect(bus.listEntries()[0].status).toBe('committed');
    });

    test('a write proposed for a missing file parks when the file appears before approve', async () => {
        const bus = newBus();
        const { id } = await stage(bus, {
            name: 'skill_update_content',
            args: { scope: GLOBAL, name: NAME, path: 'references/tides.md', content: 'High tide at noon.\n' },
        });
        const extPath = join(tmpRoot, 'skills', 'global', NAME, 'references', 'tides.md');
        await fs.mkdir(join(extPath, '..'), { recursive: true });
        await fs.writeFile(extPath, 'Low tide at noon.\n');

        const out = await bus.approve(id);

        expect(out.status).toBe('conflict');
        expect(bus.listEntries().find((e) => e.id === id).conflictError.hint).toMatch(/changed on disk/);
        expect(await fs.readFile(extPath, 'utf8')).toBe('Low tide at noon.\n');
    });

    test('a write proposed for a missing file commits when it is still missing', async () => {
        const bus = newBus();
        const { id } = await stage(bus, {
            name: 'skill_update_content',
            args: { scope: GLOBAL, name: NAME, path: 'references/tides.md', content: 'High tide at noon.\n' },
        });
        const out = await bus.approve(id);
        expect(out.status).toBe('committed');
        const extPath = join(tmpRoot, 'skills', 'global', NAME, 'references', 'tides.md');
        expect(await fs.readFile(extPath, 'utf8')).toBe('High tide at noon.\n');
    });

    test('approve of a delete after an external edit parks and keeps the skill', async () => {
        const bus = newBus();
        const { id } = await stage(bus, { name: 'skill_delete', args: { scope: GLOBAL, name: NAME } });
        await fs.writeFile(skillMdPath(), EXTERNAL);

        const out = await bus.approve(id);

        expect(out.status).toBe('conflict');
        expect(bus.listEntries().find((e) => e.id === id).conflictError.hint).toMatch(/changed on disk/);
        expect(await fs.readFile(skillMdPath(), 'utf8')).toBe(EXTERNAL);
    });

    test('approve of a delete after an external edit broke the frontmatter parks and keeps the skill', async () => {
        const bus = newBus();
        const { id } = await stage(bus, { name: 'skill_delete', args: { scope: GLOBAL, name: NAME } });
        await fs.writeFile(skillMdPath(), 'Ring the bell at dusk.\n');

        const out = await bus.approve(id);

        expect(out.status).toBe('conflict');
        expect(bus.listEntries().find((e) => e.id === id).conflictError.hint).toMatch(/changed on disk/);
        expect(await fs.readFile(skillMdPath(), 'utf8')).toBe('Ring the bell at dusk.\n');
    });

    test('a create proposal parks when the skill appeared on disk before approve', async () => {
        const bus = newBus();
        const { id } = await stage(bus, {
            name: 'skill_create',
            args: { scope: GLOBAL, name: 'tide-ledger', description: 'Log tide turns.', body: 'Record each turn of the tide.' },
        });
        const external = '---\nname: tide-ledger\ndescription: Log tide turns by hand.\n---\n\nWrite the hour.\n';
        await repo.install({ scope: GLOBAL, payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: external }] } });

        const out = await bus.approve(id);

        expect(out.status).toBe('conflict');
        expect(bus.listEntries().find((e) => e.id === id).conflictError.hint).toMatch(/tide-ledger changed on disk/);
        expect(await fs.readFile(join(tmpRoot, 'skills', 'global', 'tide-ledger', 'SKILL.md'), 'utf8')).toBe(external);
    });

    test('a frontmatter proposal pins the content it read at apply time', async () => {
        const bus = newBus();
        const { id } = await stage(bus, {
            name: 'skill_update_frontmatter',
            args: { scope: GLOBAL, name: NAME, patch: { description: 'Keep the night watch.' } },
        });
        const writes = [];
        const original = skillsApi.writeFile;
        skillsApi.writeFile = async (opts) => { writes.push(opts); return original.call(skillsApi, opts); };
        try {
            expect((await bus.approve(id)).status).toBe('committed');
        } finally {
            skillsApi.writeFile = original;
        }
        expect(writes).toHaveLength(1);
        expect(writes[0].expectedSha256).toBe(sha256(SEED));
    });

    test('approve of a delete without an external edit removes the skill', async () => {
        const bus = newBus();
        const { id } = await stage(bus, { name: 'skill_delete', args: { scope: GLOBAL, name: NAME } });
        const out = await bus.approve(id);
        expect(out.status).toBe('committed');
        expect(await repo.get(NAME, GLOBAL)).toBeNull();
    });

    test('an edit proposal re-applies onto the external edit when its anchor survives', async () => {
        const bus = newBus();
        const { id } = await stage(bus, {
            name: 'skill_edit_content',
            args: { scope: GLOBAL, name: NAME, path: 'SKILL.md', oldString: 'Keep the harbor watch.', newString: 'Keep the night watch.' },
        });
        await fs.writeFile(skillMdPath(), EXTERNAL);

        const out = await bus.approve(id);

        expect(out.status).toBe('committed');
        expect(await fs.readFile(skillMdPath(), 'utf8')).toBe(EXTERNAL.replace('Keep the harbor watch.', 'Keep the night watch.'));
    });
});
