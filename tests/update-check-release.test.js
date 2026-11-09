import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import http from 'node:http';

import { fetchLatestRelease, getGitHubRepository, selectDesktopAsset } from '../src/updater.js';
import { checkRemoteVersion, getVersion } from '../src/util.js';

/**
 * Starts a stub of the release API on an OS-assigned port. The stub answers
 * every request with the currently configured status and JSON body, and records
 * the requested paths so the test can pin which endpoint was called.
 */
function startReleaseStub() {
    let status = 200;
    let body = {};
    const requests = [];

    const server = http.createServer((request, response) => {
        requests.push(request.url);
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                requests,
                setResponse(nextStatus, nextBody) {
                    status = nextStatus;
                    body = nextBody;
                },
                stop() {
                    return new Promise((stopResolve, stopReject) => {
                        if (!server.listening) {
                            stopResolve();
                            return;
                        }
                        server.close(error => error ? stopReject(error) : stopResolve());
                    });
                },
            });
        });
    });
}

function releasePayload(tagName) {
    return {
        tag_name: tagName,
        name: `Luker ${tagName}`,
        html_url: `https://example.invalid/releases/tag/${tagName}`,
        published_at: '2026-01-02T03:04:05Z',
        assets: [
            {
                name: `Luker-${tagName}-mac-arm64.dmg`,
                browser_download_url: `https://example.invalid/downloads/Luker-${tagName}-mac-arm64.dmg`,
                size: 123456,
            },
        ],
    };
}

function aheadOf(version) {
    const [major, minor] = String(version).split('.').map(Number);
    return `${major}.${minor + 1}.0`;
}

describe('release lookup', () => {
    let stub;
    let pkgVersion;

    beforeAll(async () => {
        ({ pkgVersion } = await getVersion());
    });

    beforeEach(async () => {
        stub = await startReleaseStub();
        process.env.LUKER_GITHUB_API_BASE = stub.baseUrl;
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        delete process.env.LUKER_GITHUB_API_BASE;
        await stub.stop();
    });

    test('fetchLatestRelease queries the latest-release endpoint of the configured repository', async () => {
        const repository = getGitHubRepository();
        expect(repository).not.toBeNull();
        stub.setResponse(200, releasePayload('9.9.9'));

        const release = await fetchLatestRelease();

        const expectedPath = `/repos/${repository.owner}/${repository.repo}/releases/latest`;
        expect(stub.requests.some(requestPath => requestPath.endsWith(expectedPath))).toBe(true);
        expect(release).toEqual({
            tagName: '9.9.9',
            name: 'Luker 9.9.9',
            htmlUrl: 'https://example.invalid/releases/tag/9.9.9',
            publishedAt: '2026-01-02T03:04:05Z',
            assets: [
                {
                    name: 'Luker-9.9.9-mac-arm64.dmg',
                    url: 'https://example.invalid/downloads/Luker-9.9.9-mac-arm64.dmg',
                    size: 123456,
                },
            ],
        });
    });

    test('selects the highest semver release when pre-releases are included', async () => {
        const repository = getGitHubRepository();
        stub.setResponse(200, [
            releasePayload('2.8.0'),
            releasePayload('2.9.0-beta.2'),
            releasePayload('2.9.0-rc.1'),
        ]);

        const release = await fetchLatestRelease({ includePrerelease: true });

        const expectedPath = `/repos/${repository.owner}/${repository.repo}/releases?per_page=100`;
        expect(stub.requests).toContain(expectedPath);
        expect(release.tagName).toBe('2.9.0-rc.1');
    });

    test('ignores draft releases when pre-releases are included', async () => {
        stub.setResponse(200, [
            { ...releasePayload('2.9.0'), draft: true },
            releasePayload('2.8.0'),
        ]);

        const release = await fetchLatestRelease({ includePrerelease: true });

        expect(release.tagName).toBe('2.8.0');
    });

    test('treats an empty release list as no published release', async () => {
        stub.setResponse(200, []);

        await expect(fetchLatestRelease({ includePrerelease: true })).resolves.toBeNull();
    });

    test('checks pre-release updates when the caller includes them', async () => {
        const remoteTag = aheadOf(pkgVersion);
        stub.setResponse(200, [releasePayload(remoteTag)]);

        await expect(checkRemoteVersion({ includePrerelease: true })).resolves.toEqual({
            isLatest: false,
            tagName: remoteTag,
            htmlUrl: `https://example.invalid/releases/tag/${remoteTag}`,
        });
    });

    test('reports an available update when the remote tag is ahead of the local version', async () => {
        const remoteTag = aheadOf(pkgVersion);
        stub.setResponse(200, releasePayload(remoteTag));

        await expect(checkRemoteVersion()).resolves.toEqual({
            isLatest: false,
            tagName: remoteTag,
            htmlUrl: `https://example.invalid/releases/tag/${remoteTag}`,
        });
    });

    test('reports the latest version when the remote tag equals the local version', async () => {
        stub.setResponse(200, releasePayload(pkgVersion));

        await expect(checkRemoteVersion()).resolves.toEqual({
            isLatest: true,
            tagName: pkgVersion,
            htmlUrl: `https://example.invalid/releases/tag/${pkgVersion}`,
        });
    });

    test('reports the latest version when the remote tag is behind the local version', async () => {
        stub.setResponse(200, releasePayload('0.0.1'));

        await expect(checkRemoteVersion()).resolves.toEqual({
            isLatest: true,
            tagName: '0.0.1',
            htmlUrl: 'https://example.invalid/releases/tag/0.0.1',
        });
    });

    test.each([403, 429, 500])('reports a failed check when the release API answers %i', async (status) => {
        stub.setResponse(status, { message: 'nope' });

        const result = await checkRemoteVersion();

        expect(result.isLatest).toBe(true);
        expect(result.updateCheckFailed).toBe(true);
        expect(result.updateCheckError).toContain(String(status));
    });

    test('logs the failure when the release API answers 500', async () => {
        stub.setResponse(500, { message: 'boom' });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await checkRemoteVersion();

        expect(result.updateCheckFailed).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
        const [message, detail] = warn.mock.calls[0];
        expect(String(message)).toMatch(/update check failed/i);
        expect(`${message} ${detail}`).toContain('500');
    });

    test('reports a failed check when the release API is unreachable', async () => {
        await stub.stop();

        const result = await checkRemoteVersion();

        expect(result.isLatest).toBe(true);
        expect(result.updateCheckFailed).toBe(true);
        expect(typeof result.updateCheckError).toBe('string');
        expect(result.updateCheckError.length).toBeGreaterThan(0);
    });

    test('treats a repository without any release as the latest version without flagging a failure', async () => {
        stub.setResponse(404, { message: 'Not Found' });

        await expect(checkRemoteVersion()).resolves.toEqual({ isLatest: true });
    });
});

describe('desktop asset selection', () => {
    const macAssets = [
        { name: 'Luker-9.9.9-mac-arm64.zip', url: 'https://example.invalid/a.zip', size: 1 },
        { name: 'Luker-9.9.9-mac-arm64.dmg', url: 'https://example.invalid/a.dmg', size: 2 },
    ];

    const winAssets = [
        { name: 'Luker-9.9.9-win-x64.zip', url: 'https://example.invalid/b.zip', size: 3 },
        { name: 'Luker-9.9.9-win-x64.exe', url: 'https://example.invalid/b.exe', size: 4 },
    ];

    test('prefers the dmg installer for darwin arm64', () => {
        expect(selectDesktopAsset(macAssets, 'darwin', 'arm64')).toEqual({
            name: 'Luker-9.9.9-mac-arm64.dmg',
            url: 'https://example.invalid/a.dmg',
            size: 2,
        });
    });

    test('prefers the exe installer for win32 x64', () => {
        expect(selectDesktopAsset(winAssets, 'win32', 'x64')).toEqual({
            name: 'Luker-9.9.9-win-x64.exe',
            url: 'https://example.invalid/b.exe',
            size: 4,
        });
    });

    test('prefers the dmg installer for darwin x64', () => {
        const assets = [
            { name: 'Luker-9.9.9-mac-x64.zip', url: 'https://example.invalid/e.zip', size: 7 },
            { name: 'Luker-9.9.9-mac-x64.dmg', url: 'https://example.invalid/e.dmg', size: 8 },
        ];

        expect(selectDesktopAsset(assets, 'darwin', 'x64')).toEqual({
            name: 'Luker-9.9.9-mac-x64.dmg',
            url: 'https://example.invalid/e.dmg',
            size: 8,
        });
    });

    test('prefers the exe installer for win32 arm64', () => {
        const assets = [
            { name: 'Luker-9.9.9-win-arm64.zip', url: 'https://example.invalid/f.zip', size: 9 },
            { name: 'Luker-9.9.9-win-arm64.exe', url: 'https://example.invalid/f.exe', size: 10 },
        ];

        expect(selectDesktopAsset(assets, 'win32', 'arm64')).toEqual({
            name: 'Luker-9.9.9-win-arm64.exe',
            url: 'https://example.invalid/f.exe',
            size: 10,
        });
    });

    test('returns null instead of an asset built for another platform or architecture', () => {
        const mixedAssets = [
            { name: 'Luker-9.9.9-mac-x64.dmg', url: 'https://example.invalid/c.dmg', size: 5 },
            { name: 'Luker-9.9.9-win-x64.exe', url: 'https://example.invalid/d.exe', size: 6 },
        ];

        expect(selectDesktopAsset(mixedAssets, 'darwin', 'arm64')).toBeNull();
        expect(selectDesktopAsset(winAssets, 'darwin', 'x64')).toBeNull();
    });
});

describe('selectDesktopAsset on linux', () => {
    const release = [
        { name: 'Luker-2.9.0-linux-x86_64.AppImage', url: 'a', size: 1 },
        { name: 'Luker-2.9.0-linux-amd64.deb', url: 'b', size: 1 },
        { name: 'Luker-2.9.0-linux-x86_64.rpm', url: 'c', size: 1 },
        { name: 'Luker-2.9.0-linux-aarch64.rpm', url: 'e', size: 1 },
        { name: 'Luker-2.9.0-mac-arm64.dmg', url: 'd', size: 1 },
    ];

    test('picks the one format the flavour names', () => {
        expect(selectDesktopAsset(release, 'linux', 'x64', 'appimage').url).toBe('a');
        expect(selectDesktopAsset(release, 'linux', 'x64', 'deb').url).toBe('b');
        expect(selectDesktopAsset(release, 'linux', 'x64', 'rpm').url).toBe('c');
        expect(selectDesktopAsset(release, 'linux', 'arm64', 'rpm').url).toBe('e');
    });

    test('resolves to null when the flavour is unknown or absent', () => {
        expect(selectDesktopAsset(release, 'linux', 'x64', '')).toBeNull();
        expect(selectDesktopAsset(release, 'linux', 'x64', 'pacman')).toBeNull();
        expect(selectDesktopAsset(release, 'linux', 'x64')).toBeNull();
    });

    test('leaves the other platforms alone', () => {
        expect(selectDesktopAsset(release, 'darwin', 'arm64').url).toBe('d');
        expect(selectDesktopAsset(release, 'win32', 'x64', 'deb')).toBeNull();
    });
});
