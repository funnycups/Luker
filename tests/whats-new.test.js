import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import express from 'express';
import storage from 'node-persist';
import { ensureRun, trackScope } from './harness/jest-run.js';

import {
    evaluateWhatsNew,
    getInitialSeenVersionFields,
    getRuntimeIdentity,
    loadChangelogForLocale,
    parseChangelogMarkdown,
    resolveChangelogLocale,
    shouldApplyAck,
} from '../src/whats-new.js';
import { initUserStorage, toKey } from '../src/users.js';
import { saveAdminSettings } from '../src/admin-settings.js';
import { router as usersAdminRouter } from '../src/endpoints/users-admin.js';
import { router as usersPrivateRouter } from '../src/endpoints/users-private.js';
import { createUserFromOAuth, router as usersPublicRouter } from '../src/endpoints/users-public.js';

const tempDirs = [];
let suiteTempRoot;
let tempDirSeq = 0;

beforeAll(async () => {
    const run = await ensureRun();
    const scope = trackScope(await run.scope({ kind: 'scenario', label: 'whats-new' }));
    suiteTempRoot = (await scope.directory('luker-wn-suite')).path;
});

function makeTempDir(prefix) {
    const dir = path.join(suiteTempRoot, `${prefix}${++tempDirSeq}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
}

function writeChangelogs(baseDir, { en = '', zhCn = '', zhTw = '' } = {}) {
    if (en !== null) {
        fs.mkdirSync(path.join(baseDir, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(baseDir, 'docs', 'changelog.md'), en, 'utf8');
    }
    if (zhCn !== null) {
        fs.mkdirSync(path.join(baseDir, 'docs', 'zh-CN'), { recursive: true });
        fs.writeFileSync(path.join(baseDir, 'docs', 'zh-CN', 'changelog.md'), zhCn, 'utf8');
    }
    if (zhTw !== null) {
        fs.mkdirSync(path.join(baseDir, 'docs', 'zh-TW'), { recursive: true });
        fs.writeFileSync(path.join(baseDir, 'docs', 'zh-TW', 'changelog.md'), zhTw, 'utf8');
    }
}

const SAMPLE_EN = `# Changelog

Intro line.

## Unreleased

### Fixes

- Fixed Docker session cookie naming.

## v2.9.0-rc.4 (2026-11-23)

### Workbench

- Added floating Workbench window.

**Full Changelog**: https://github.com/funnycups/Luker/compare/v2.9.0-rc.3...v2.9.0-rc.4

## v2.9.0-rc.3 (2026-11-21)

### Docs

- Added [Workbench Guide](/features/workbench).

## v2.9.0-rc.2 (2026-11-11)

### Fixes

- Older fix.

## v1.0.0

- Initial release.
`;

const SAMPLE_ZH_CN = `# Changelog

## 未发布

### 修复

- 修复了更新 Docker 镜像后登录状态失效的问题。

## v2.9.0-rc.4 (2026-11-23)

### 工作台

- 新增浮动工作台窗口。

**完整更新日志**：https://github.com/funnycups/Luker/compare/v2.9.0-rc.3...v2.9.0-rc.4
`;

const SAMPLE_ZH_TW = `# Changelog

## 未發布

### 修復

- 修復了更新 Docker 映像檔後登入狀態失效的問題。

## v2.9.0-rc.4 (2026-11-23)

### 工作台

- 新增懸浮工作台視窗。

**完整更新日誌**：https://github.com/funnycups/Luker/compare/v2.9.0-rc.3...v2.9.0-rc.4
`;

afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('resolveChangelogLocale', () => {
    test('maps zh-cn to Simplified Chinese changelog and docs URL', () => {
        expect(resolveChangelogLocale('zh-cn')).toEqual({
            relativePath: 'docs/zh-CN/changelog.md',
            changelogUrl: 'https://luker.cups.moe/zh-CN/changelog',
            localeKey: 'zh-CN',
        });
        expect(resolveChangelogLocale('zh-Hans-CN')).toEqual({
            relativePath: 'docs/zh-CN/changelog.md',
            changelogUrl: 'https://luker.cups.moe/zh-CN/changelog',
            localeKey: 'zh-CN',
        });
    });

    test('maps zh-tw, zh-hk, zh-mo, and zh-hant to Traditional Chinese', () => {
        for (const loc of ['zh-tw', 'ZH-TW', 'zh-hk', 'zh-mo', 'zh-hant-tw']) {
            expect(resolveChangelogLocale(loc)).toEqual({
                relativePath: 'docs/zh-TW/changelog.md',
                changelogUrl: 'https://luker.cups.moe/zh-TW/changelog',
                localeKey: 'zh-TW',
            });
        }
    });

    test('maps en, other locales, and missing locale to English', () => {
        for (const loc of ['en', 'en-US', 'ja-jp', '', undefined]) {
            expect(resolveChangelogLocale(loc)).toEqual({
                relativePath: 'docs/changelog.md',
                changelogUrl: 'https://luker.cups.moe/changelog',
                localeKey: 'en',
            });
        }
    });
});

describe('parseChangelogMarkdown', () => {
    test('parses Unreleased, dated releases, undated releases, and strips compare footers in all 3 locales', () => {
        const en = parseChangelogMarkdown(SAMPLE_EN);
        expect(en.unreleased).toEqual({
            version: null,
            date: null,
            unreleased: true,
            markdown: '### Fixes\n\n- Fixed Docker session cookie naming.',
        });
        expect(en.releases.map(r => ({ version: r.version, date: r.date }))).toEqual([
            { version: '2.9.0-rc.4', date: '2026-11-23' },
            { version: '2.9.0-rc.3', date: '2026-11-21' },
            { version: '2.9.0-rc.2', date: '2026-11-11' },
            { version: '1.0.0', date: null },
        ]);
        expect(en.releases[0].markdown).not.toContain('Full Changelog');
        expect(en.releases[0].markdown).toContain('### Workbench');

        const cn = parseChangelogMarkdown(SAMPLE_ZH_CN);
        expect(cn.unreleased?.unreleased).toBe(true);
        expect(cn.unreleased?.markdown).toContain('修复了更新 Docker 镜像后登录状态失效的问题');
        expect(cn.releases[0].markdown).not.toContain('完整更新日志');

        const tw = parseChangelogMarkdown(SAMPLE_ZH_TW);
        expect(tw.unreleased?.unreleased).toBe(true);
        expect(tw.unreleased?.markdown).toContain('修復了更新 Docker 映像檔後登入狀態失效的問題');
        expect(tw.releases[0].markdown).not.toContain('完整更新日誌');
    });

    test('unwraps VitePress <span v-pre> wrappers while preserving inline code and other HTML tags', () => {
        const md = [
            '## Unreleased',
            '',
            '### Fixes',
            '',
            '- Fixed <span v-pre>`{{each}}`</span> containing <span v-pre>`}}`</span> such as <span v-pre>`{{each::{"a":1,"b":2}}}`</span>.',
            '- Kept `<span v-pre>` and `</span>` inside inline code, and <span v-pre>`</span>`</span> inside a wrapper.',
            '- Kept unclosed <span v-pre>`{{x}}` and unrelated <span>tags</span> intact.',
        ].join('\n');

        const parsed = parseChangelogMarkdown(md);
        expect(parsed.unreleased?.markdown).toBe([
            '### Fixes',
            '',
            '- Fixed `{{each}}` containing `}}` such as `{{each::{"a":1,"b":2}}}`.',
            '- Kept `<span v-pre>` and `</span>` inside inline code, and `</span>` inside a wrapper.',
            '- Kept unclosed <span v-pre>`{{x}}` and unrelated <span>tags</span> intact.',
        ].join('\n'));
    });
});

describe('loadChangelogForLocale', () => {
    test('returns empty sections with changelogUrl when changelog file is missing on disk', () => {
        const emptyDir = makeTempDir('luker-empty-cl-');
        const loaded = loadChangelogForLocale('zh-cn', { baseDir: emptyDir });
        expect(loaded).toEqual({
            unreleased: null,
            releases: [],
            changelogUrl: 'https://luker.cups.moe/zh-CN/changelog',
        });
    });
});

describe('getRuntimeIdentity and getInitialSeenVersionFields', () => {
    test('reads real runtime identity and builds initial seen fields for valid semver', async () => {
        const current = await getRuntimeIdentity();
        expect(typeof current.version).toBe('string');
        expect(current.version.length).toBeGreaterThan(0);
        expect(await getInitialSeenVersionFields({ version: '2.9.0-rc.4', revision: 'a8bd55a9e', branch: 'release' })).toEqual({
            lastSeenVersion: '2.9.0-rc.4',
            lastSeenRevision: 'a8bd55a9e',
        });
    });

    test('omits lastSeenVersion when current version is invalid', async () => {
        expect(await getInitialSeenVersionFields({ version: 'UNKNOWN', revision: null, branch: null })).toEqual({
            lastSeenRevision: null,
        });
    });
});

describe('evaluateWhatsNew', () => {
    test('returns show:false when current version is unparseable', () => {
        const baseDir = makeTempDir('luker-wn-');
        writeChangelogs(baseDir, { en: SAMPLE_EN });
        const result = evaluateWhatsNew({
            userRecord: { lastSeenVersion: '2.8.0' },
            current: { version: 'UNKNOWN', revision: null, branch: null },
            locale: 'en',
            baseDir,
        });
        expect(result).toEqual({ payload: { show: false }, silentSync: null });
    });

    test('shows current version once for pre-feature existing user with no lastSeenVersion', () => {
        const baseDir = makeTempDir('luker-wn-');
        writeChangelogs(baseDir, { en: SAMPLE_EN });
        const result = evaluateWhatsNew({
            userRecord: { handle: 'alice' },
            current: { version: '2.9.0-rc.4', revision: '9d17a9735', branch: 'release' },
            locale: 'en',
            baseDir,
        });
        expect(result.silentSync).toBeNull();
        expect(result.payload).toMatchObject({
            show: true,
            kind: 'release',
            previousVersion: null,
            currentVersion: '2.9.0-rc.4',
            changelogUrl: 'https://luker.cups.moe/changelog',
            compareUrl: null,
        });
        expect(result.payload.sections.map(s => (s.unreleased ? 'unreleased' : s.version))).toEqual([
            'unreleased',
            '2.9.0-rc.4',
        ]);
    });

    test('still shows modal with empty sections when changelog file is missing', () => {
        const emptyDir = makeTempDir('luker-wn-missing-');
        const result = evaluateWhatsNew({
            userRecord: { handle: 'alice' },
            current: { version: '2.9.9', revision: null, branch: null },
            locale: 'zh-cn',
            baseDir: emptyDir,
        });
        expect(result.silentSync).toBeNull();
        expect(result.payload).toMatchObject({
            show: true,
            kind: 'release',
            currentVersion: '2.9.9',
            sections: [],
            changelogUrl: 'https://luker.cups.moe/zh-CN/changelog',
            compareUrl: null,
        });
    });

    test('collects all versions strictly after lastSeenVersion up through currentVersion newest-first', () => {
        const baseDir = makeTempDir('luker-wn-multi-');
        writeChangelogs(baseDir, { en: SAMPLE_EN });
        const result = evaluateWhatsNew({
            userRecord: { lastSeenVersion: '2.9.0-rc.2', lastSeenRevision: '111111111' },
            current: { version: '2.9.0-rc.4', revision: 'a8bd55a9e', branch: 'release' },
            locale: 'en',
            baseDir,
        });
        expect(result.silentSync).toBeNull();
        expect(result.payload.show).toBe(true);
        expect(result.payload.kind).toBe('release');
        expect(result.payload.previousVersion).toBe('2.9.0-rc.2');
        expect(result.payload.compareUrl).toBeNull();
        expect(result.payload.sections.map(s => (s.unreleased ? 'unreleased' : s.version))).toEqual([
            'unreleased',
            '2.9.0-rc.4',
            '2.9.0-rc.3',
        ]);
    });

    test('downgrade silently syncs without showing modal', () => {
        const baseDir = makeTempDir('luker-wn-down-');
        writeChangelogs(baseDir, { en: SAMPLE_EN });
        const result = evaluateWhatsNew({
            userRecord: { lastSeenVersion: '2.9.0-rc.4', lastSeenRevision: 'a8bd55a9e' },
            current: { version: '2.9.0-rc.3', revision: '123456789', branch: 'release' },
            locale: 'en',
            baseDir,
        });
        expect(result).toEqual({
            payload: { show: false },
            silentSync: { lastSeenVersion: '2.9.0-rc.3', lastSeenRevision: '123456789' },
        });
    });

    test('detects dev revision update on same version with hex compareUrl and Unreleased section', () => {
        const baseDir = makeTempDir('luker-wn-dev-');
        writeChangelogs(baseDir, { zhCn: SAMPLE_ZH_CN });
        const result = evaluateWhatsNew({
            userRecord: { lastSeenVersion: '2.9.0-rc.4', lastSeenRevision: '9d17a9735' },
            current: { version: '2.9.0-rc.4', revision: 'a8bd55a9e', branch: 'release' },
            locale: 'zh-cn',
            baseDir,
        });
        expect(result.silentSync).toBeNull();
        expect(result.payload).toMatchObject({
            show: true,
            kind: 'dev',
            previousVersion: '2.9.0-rc.4',
            currentVersion: '2.9.0-rc.4',
            previousRevision: '9d17a9735',
            currentRevision: 'a8bd55a9e',
            branch: 'release',
            changelogUrl: 'https://luker.cups.moe/zh-CN/changelog',
            compareUrl: 'https://github.com/funnycups/Luker/compare/9d17a9735...a8bd55a9e',
        });
        expect(result.payload.sections).toHaveLength(1);
        expect(result.payload.sections[0].unreleased).toBe(true);
    });

    test('omits compareUrl on dev update when either revision is non-hex and returns empty sections when no Unreleased heading exists', () => {
        const baseDir = makeTempDir('luker-wn-nonhex-');
        writeChangelogs(baseDir, { en: '# Changelog\n\n## v2.9.0-rc.4 (2026-11-23)\n\n- Release item.\n' });
        const result = evaluateWhatsNew({
            userRecord: { lastSeenVersion: '2.9.0-rc.4', lastSeenRevision: 'dirty-local' },
            current: { version: '2.9.0-rc.4', revision: 'custom/ref', branch: 'dev' },
            locale: 'en',
            baseDir,
        });
        expect(result.silentSync).toBeNull();
        expect(result.payload).toMatchObject({
            show: true,
            kind: 'dev',
            compareUrl: null,
            sections: [],
        });
    });

    test('silently backfills missing lastSeenRevision on same version without showing modal', () => {
        const baseDir = makeTempDir('luker-wn-backfill-');
        writeChangelogs(baseDir, { en: SAMPLE_EN });
        const result = evaluateWhatsNew({
            userRecord: { lastSeenVersion: '2.9.0-rc.4' },
            current: { version: '2.9.0-rc.4', revision: 'a8bd55a9e', branch: 'release' },
            locale: 'en',
            baseDir,
        });
        expect(result).toEqual({
            payload: { show: false },
            silentSync: { lastSeenVersion: '2.9.0-rc.4', lastSeenRevision: 'a8bd55a9e' },
        });
    });

    test('returns show:false when version and revision match', () => {
        const baseDir = makeTempDir('luker-wn-same-');
        writeChangelogs(baseDir, { en: SAMPLE_EN });
        const result = evaluateWhatsNew({
            userRecord: { lastSeenVersion: '2.9.0-rc.4', lastSeenRevision: 'a8bd55a9e' },
            current: { version: '2.9.0-rc.4', revision: 'a8bd55a9e', branch: 'release' },
            locale: 'en',
            baseDir,
        });
        expect(result).toEqual({ payload: { show: false }, silentSync: null });
    });
});

describe('shouldApplyAck', () => {
    test('accepts matching version and revision, rejects stale versions or revisions', () => {
        const current = { version: '2.9.0-rc.4', revision: 'a8bd55a9e', branch: 'release' };
        expect(shouldApplyAck({ ackVersion: '2.9.0-rc.4', ackRevision: 'a8bd55a9e', current })).toBe(true);
        expect(shouldApplyAck({ ackVersion: '2.9.0-rc.3', ackRevision: 'a8bd55a9e', current })).toBe(false);
        expect(shouldApplyAck({ ackVersion: '2.9.0-rc.4', ackRevision: '9d17a9735', current })).toBe(false);
        expect(shouldApplyAck({ ackVersion: '2.9.0-rc.4', ackRevision: null, current })).toBe(false);

        const noRevCurrent = { version: '2.9.0-rc.4', revision: null, branch: null };
        expect(shouldApplyAck({ ackVersion: '2.9.0-rc.4', ackRevision: null, current: noRevCurrent })).toBe(true);
        expect(shouldApplyAck({ ackVersion: '2.9.0-rc.4', ackRevision: undefined, current: noRevCurrent })).toBe(true);
    });
});

describe('/api/users/whats-new HTTP endpoints and account seeding', () => {
    const prevDataRoot = globalThis.DATA_ROOT;
    let dataRoot;
    let server;
    let baseUrl;
    let activeHandle = 'default-user';

    let runtimeIdentity;

    beforeAll(async () => {
        const run = await ensureRun();
        const scope = trackScope(await run.scope({ kind: 'scenario', label: 'whats-new-http' }));
        dataRoot = (await scope.directory('luker-wn-http')).path;
        globalThis.DATA_ROOT = dataRoot;
        runtimeIdentity = await getRuntimeIdentity();
        await initUserStorage(dataRoot);

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = {};
            if (activeHandle) {
                req.user = { profile: { handle: activeHandle, admin: true } };
            }
            next();
        });
        app.use('/api/users', usersPublicRouter);
        app.use('/api/users', usersPrivateRouter);
        app.use('/api/users', usersAdminRouter);

        server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
        await storage.clear();
        globalThis.DATA_ROOT = prevDataRoot;
    });

    async function postJson(route, payload) {
        const res = await fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const text = await res.text();
        let body = null;
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
        }
        return { status: res.status, body };
    }

    test('fresh initUserStorage seeds default-user so /whats-new returns show:false', async () => {
        activeHandle = 'default-user';
        const stored = await storage.getItem(toKey('default-user'));
        expect(stored.lastSeenVersion).toBe(runtimeIdentity.version);
        expect(stored.lastSeenRevision).toBe(runtimeIdentity.revision);

        const res = await postJson('/api/users/whats-new', { locale: 'zh-cn' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ show: false });
    });

    test('multi-version upgrade, stale-tab ack rejection, valid ack, and dev revision update', async () => {
        activeHandle = 'default-user';
        const user = await storage.getItem(toKey('default-user'));
        user.lastSeenVersion = '2.9.0-rc.2';
        user.lastSeenRevision = '111111111';
        await storage.setItem(toKey('default-user'), user);

        const upgrade = await postJson('/api/users/whats-new', { locale: 'zh-cn' });
        expect(upgrade.status).toBe(200);
        expect(upgrade.body.show).toBe(true);
        expect(upgrade.body.kind).toBe('release');
        expect(upgrade.body.previousVersion).toBe('2.9.0-rc.2');
        expect(upgrade.body.currentVersion).toBe(runtimeIdentity.version);
        const releaseVersions = upgrade.body.sections.filter(s => !s.unreleased).map(s => s.version);
        expect(releaseVersions).toEqual(expect.arrayContaining(['2.9.0-rc.4', '2.9.0-rc.3']));

        // Missing/empty version -> 400
        const badAck = await postJson('/api/users/whats-new/ack', { version: '' });
        expect(badAck.status).toBe(400);

        // Stale tab ack (older version) -> 204 without advancing stored version
        const staleAck = await postJson('/api/users/whats-new/ack', {
            version: '2.9.0-rc.3',
            revision: runtimeIdentity.revision,
        });
        expect(staleAck.status).toBe(204);
        expect((await storage.getItem(toKey('default-user'))).lastSeenVersion).toBe('2.9.0-rc.2');

        // Matching ack -> persists version and clears prompt
        const okAck = await postJson('/api/users/whats-new/ack', {
            version: runtimeIdentity.version,
            revision: runtimeIdentity.revision,
        });
        expect(okAck.status).toBe(204);
        const afterAck = await postJson('/api/users/whats-new', { locale: 'zh-cn' });
        expect(afterAck.body).toEqual({ show: false });

        // Dev revision change on same semver -> kind: 'dev' with compareUrl
        expect(runtimeIdentity.revision).toBeTruthy();
        const devUser = await storage.getItem(toKey('default-user'));
        devUser.lastSeenVersion = runtimeIdentity.version;
        devUser.lastSeenRevision = '9d17a9735';
        await storage.setItem(toKey('default-user'), devUser);

        const devUpdate = await postJson('/api/users/whats-new', { locale: 'zh-cn' });
        expect(devUpdate.status).toBe(200);
        expect(devUpdate.body).toMatchObject({
            show: true,
            kind: 'dev',
            previousRevision: '9d17a9735',
            currentRevision: runtimeIdentity.revision,
            compareUrl: `https://github.com/funnycups/Luker/compare/9d17a9735...${runtimeIdentity.revision}`,
        });

        const devAck = await postJson('/api/users/whats-new/ack', {
            version: runtimeIdentity.version,
            revision: runtimeIdentity.revision,
        });
        expect(devAck.status).toBe(204);
        expect((await postJson('/api/users/whats-new', { locale: 'zh-cn' })).body).toEqual({ show: false });
    });

    test('concurrent whats-new ack and announcements mark-read preserve both userRecord fields', async () => {
        activeHandle = 'default-user';
        const user = await storage.getItem(toKey('default-user'));
        user.lastSeenVersion = '2.9.0-rc.3';
        user.lastSeenRevision = '111111111';
        user.readAnnouncementIds = [];
        await storage.setItem(toKey('default-user'), user);

        const [ackRes, markRes] = await Promise.all([
            postJson('/api/users/whats-new/ack', { version: runtimeIdentity.version, revision: runtimeIdentity.revision }),
            postJson('/api/users/announcements/me/mark-read', { ids: ['ann-1'] }),
        ]);
        expect(ackRes.status).toBe(204);
        expect(markRes.status).toBe(204);

        const stored = await storage.getItem(toKey('default-user'));
        expect(stored.lastSeenVersion).toBe(runtimeIdentity.version);
        expect(stored.lastSeenRevision).toBe(runtimeIdentity.revision);
        expect(stored.readAnnouncementIds).toContain('ann-1');
    });

    test('rejects unauthenticated requests with 403', async () => {
        activeHandle = '';
        expect((await postJson('/api/users/whats-new', { locale: 'en' })).status).toBe(403);
        expect((await postJson('/api/users/whats-new/ack', { version: runtimeIdentity.version })).status).toBe(403);
        activeHandle = 'default-user';
    });

    test('admin /create, self /register, and createUserFromOAuth all seed lastSeenVersion and lastSeenRevision', async () => {
        activeHandle = 'default-user';

        // 1. Admin POST /api/users/create
        const createdRes = await postJson('/api/users/create', {
            handle: 'admin-created',
            name: 'Admin Created',
            password: 'secret-password',
        });
        expect(createdRes.status).toBe(200);
        const adminCreated = await storage.getItem(toKey('admin-created'));
        expect(adminCreated.lastSeenVersion).toBe(runtimeIdentity.version);
        expect(adminCreated.lastSeenRevision).toBe(runtimeIdentity.revision);

        // 2. Self-registration POST /api/users/register
        await saveAdminSettings({ accountRegistration: { enabled: true } });
        const regRes = await postJson('/api/users/register', {
            handle: 'self-registered',
            name: 'Self Registered',
            password: 'secret-password',
        });
        expect(regRes.status).toBe(200);
        const selfRegistered = await storage.getItem(toKey('self-registered'));
        expect(selfRegistered.lastSeenVersion).toBe(runtimeIdentity.version);
        expect(selfRegistered.lastSeenRevision).toBe(runtimeIdentity.revision);

        // 3. OAuth auto-create
        const oauthUser = await createUserFromOAuth('github', {
            id: '99999',
            login: 'oauth-new',
            name: 'OAuth New',
            email: '',
        }, {});
        const storedOauth = await storage.getItem(toKey(oauthUser.handle));
        expect(storedOauth.lastSeenVersion).toBe(runtimeIdentity.version);
        expect(storedOauth.lastSeenRevision).toBe(runtimeIdentity.revision);

        // None of the freshly created accounts should see an update popup
        for (const handle of ['admin-created', 'self-registered', oauthUser.handle]) {
            activeHandle = handle;
            expect((await postJson('/api/users/whats-new', { locale: 'en' })).body).toEqual({ show: false });
        }
        activeHandle = 'default-user';
    });
});
