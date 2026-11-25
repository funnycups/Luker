// Launch the desktop shell (desktop-app/) under Playwright's Electron
// driver, so a spec drives the same window a user sees: the shell spawns
// the backend in-process, then swaps its loading page for the local URL.
//
// The shell reads `--port=<n>` (the port to prefer), `LUKER_DESKTOP_USER_DATA`
// (an explicit data root override), and `LUKER_DESKTOP_DEFAULT_USER_DATA`
// (isolating the pointer location and default data root).

import { _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { constants as fsConstants, accessSync, existsSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { failureFrom, failureGroup } from '../../harness/resources/errors.js';
import { materializeSeed } from '../../harness/seed.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const DESKTOP_APP_DIR = resolve(REPO_ROOT, 'desktop-app');
const requireDesktop = createRequire(resolve(DESKTOP_APP_DIR, 'package.json'));

// The shell loads a bundled file:// page first and swaps to the backend
// origin once the server announces it is up. `browserLaunch.hostname` is
// `auto`, so the host may be either loopback spelling.
const BACKEND_URL = /^https?:\/\/(127\.0\.0\.1|localhost):\d+\//;

export class PackagedDesktopArtifactError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'PackagedDesktopArtifactError';
        this.code = 'PACKAGED_DESKTOP_ARTIFACT_MISSING';
        Object.assign(this, details);
    }
}

export class DesktopRuntimeError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DesktopRuntimeError';
        this.code = 'DESKTOP_RUNTIME_MISSING';
        Object.assign(this, details);
    }
}

function isSettled(url) {
    return BACKEND_URL.test(url.href) || (url.protocol === 'file:' && url.searchParams.has('error'));
}

function sha256File(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        return true;
    }
}

async function waitForPidExit(pid, timeoutMs = 10_000) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isProcessAlive(pid)) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
}

function assertExecutableFile(filePath, label, ErrorClass) {
    if (!existsSync(filePath)) {
        throw new ErrorClass(`${label} does not exist at ${filePath}`, { executablePath: filePath });
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) {
        throw new ErrorClass(`${label} is not a regular file: ${filePath}`, { executablePath: filePath });
    }
    if (process.platform !== 'win32') {
        try {
            accessSync(filePath, fsConstants.X_OK);
        } catch (cause) {
            throw new ErrorClass(`${label} is not executable: ${filePath}`, { executablePath: filePath, cause });
        }
    }
}

function packagedCandidates(distDir, platform, arch) {
    if (platform === 'darwin') {
        const dirs = arch === 'arm64'
            ? [join(distDir, 'mac-arm64', 'Luker.app')]
            : [join(distDir, 'mac-x64', 'Luker.app'), join(distDir, 'mac', 'Luker.app')];
        return dirs.map(appDir => ({
            bundlePath: appDir,
            executablePath: join(appDir, 'Contents', 'MacOS', 'Luker'),
            resourcesDir: join(appDir, 'Contents', 'Resources'),
            metadataPath: join(distDir, 'latest-mac.yml'),
        }));
    }
    if (platform === 'linux') {
        const unpacked = arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
        const dir = join(distDir, unpacked);
        return ['luker', 'Luker'].map(bin => ({
            bundlePath: dir,
            executablePath: join(dir, bin),
            resourcesDir: join(dir, 'resources'),
            metadataPath: join(distDir, arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml'),
        }));
    }
    if (platform === 'win32') {
        const unpacked = arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked';
        const dir = join(distDir, unpacked);
        return [{
            bundlePath: dir,
            executablePath: join(dir, 'Luker.exe'),
            resourcesDir: join(dir, 'resources'),
            metadataPath: join(distDir, 'latest.yml'),
        }];
    }
    return [];
}

/**
 * Resolve explicit packaged desktop build metadata for the target platform.
 * Fails preflight cleanly when missing and never falls back to source Electron.
 */
export function resolvePackagedDesktopArtifact({
    artifactDir = process.env.LUKER_DESKTOP_ARTIFACT_DIR || null,
    artifactManifest = process.env.LUKER_DESKTOP_ARTIFACT_MANIFEST || null,
    executablePath = process.env.LUKER_DESKTOP_PACKAGED_EXECUTABLE || null,
    resourcesDir = process.env.LUKER_DESKTOP_PACKAGED_RESOURCES_DIR || null,
    platform = process.platform,
    arch = process.arch,
} = {}) {
    let source = 'dist';
    let resolvedExecutable = executablePath;
    let resolvedResources = resourcesDir;
    let bundlePath = null;
    let manifestPath = null;
    let metadataPath = null;

    if (artifactManifest) {
        source = 'manifest';
        manifestPath = resolve(artifactManifest);
        if (!existsSync(manifestPath)) {
            throw new PackagedDesktopArtifactError(
                `Packaged desktop artifact manifest not found for ${platform}-${arch}: ${manifestPath}`,
                { platform, arch, manifestPath },
            );
        }
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.platform && manifest.platform !== platform) {
            throw new PackagedDesktopArtifactError(
                `Packaged desktop artifact manifest targets ${manifest.platform}, not ${platform}`,
                { platform, arch, manifestPath },
            );
        }
        if (manifest.arch && manifest.arch !== arch) {
            throw new PackagedDesktopArtifactError(
                `Packaged desktop artifact manifest targets ${manifest.arch}, not ${arch}`,
                { platform, arch, manifestPath },
            );
        }
        if (!manifest.executablePath || !manifest.resourcesDir) {
            throw new PackagedDesktopArtifactError(
                `Packaged desktop artifact manifest must declare executablePath and resourcesDir: ${manifestPath}`,
                { platform, arch, manifestPath },
            );
        }
        resolvedExecutable = resolve(manifest.executablePath);
        resolvedResources = resolve(manifest.resourcesDir);
        bundlePath = manifest.bundlePath ? resolve(manifest.bundlePath) : null;
    } else if (resolvedExecutable || resolvedResources) {
        source = 'env';
        if (!resolvedExecutable || !resolvedResources || !isAbsolute(resolvedExecutable) || !isAbsolute(resolvedResources)) {
            throw new PackagedDesktopArtifactError(
                `Packaged desktop artifact for ${platform}-${arch} requires absolute executablePath and resourcesDir`,
                { platform, arch, executablePath: resolvedExecutable, resourcesDir: resolvedResources },
            );
        }
    } else {
        const distDir = artifactDir ? resolve(artifactDir) : resolve(DESKTOP_APP_DIR, 'dist');
        const candidates = packagedCandidates(distDir, platform, arch);
        if (!candidates.length) {
            throw new PackagedDesktopArtifactError(
                `Packaged desktop artifact layout is unsupported on ${platform}-${arch}`,
                { platform, arch, distDir },
            );
        }
        const match = candidates.find(candidate => existsSync(candidate.executablePath) && existsSync(candidate.resourcesDir))
            ?? candidates[0];
        resolvedExecutable = match.executablePath;
        resolvedResources = match.resourcesDir;
        bundlePath = match.bundlePath;
        metadataPath = existsSync(match.metadataPath) ? match.metadataPath : null;
    }

    if (!existsSync(resolvedExecutable) || !existsSync(resolvedResources)) {
        throw new PackagedDesktopArtifactError(
            `Packaged desktop artifact is missing for ${platform}-${arch}. Expected executable at ${resolvedExecutable} and resources at ${resolvedResources}. Build desktop-app/dist or provide LUKER_DESKTOP_ARTIFACT_DIR / LUKER_DESKTOP_ARTIFACT_MANIFEST.`,
            { platform, arch, executablePath: resolvedExecutable, resourcesDir: resolvedResources },
        );
    }

    assertExecutableFile(resolvedExecutable, `Packaged desktop executable (${platform}-${arch})`, PackagedDesktopArtifactError);
    if (!statSync(resolvedResources).isDirectory()) {
        throw new PackagedDesktopArtifactError(
            `Packaged desktop resources path is not a directory for ${platform}-${arch}: ${resolvedResources}`,
            { platform, arch, resourcesDir: resolvedResources },
        );
    }

    const backendPackagePath = join(resolvedResources, 'luker', 'package.json');
    if (!existsSync(backendPackagePath)) {
        throw new PackagedDesktopArtifactError(
            `Packaged desktop artifact is missing embedded backend manifest at ${backendPackagePath}`,
            { platform, arch, executablePath: resolvedExecutable, resourcesDir: resolvedResources, backendPackagePath },
        );
    }

    const realExecutable = realpathSync(resolvedExecutable);
    const realResources = realpathSync(resolvedResources);
    const realBackendPkg = realpathSync(backendPackagePath);
    const backendPkg = JSON.parse(readFileSync(realBackendPkg, 'utf8'));

    return Object.freeze({
        kind: 'packaged',
        source,
        platform,
        arch,
        bundlePath: bundlePath && existsSync(bundlePath) ? realpathSync(bundlePath) : null,
        executablePath: realExecutable,
        resourcesDir: realResources,
        backendPackagePath: realBackendPkg,
        appVersion: typeof backendPkg.version === 'string' ? backendPkg.version : null,
        executableSHA256: sha256File(realExecutable),
        backendPackageSHA256: sha256File(realBackendPkg),
        manifestPath,
        metadataPath,
    });
}

/**
 * Resolve the source desktop runtime (Electron binary + app directory).
 */
export function resolveSourceDesktopRuntime({
    electronPath = process.env.LUKER_DESKTOP_ELECTRON_PATH || null,
    appDir = DESKTOP_APP_DIR,
} = {}) {
    let resolvedExecutable = electronPath ? resolve(electronPath) : null;
    if (!resolvedExecutable) {
        try {
            resolvedExecutable = requireDesktop('electron');
        } catch (cause) {
            throw new DesktopRuntimeError(
                `Source desktop Electron runtime is not installed in ${DESKTOP_APP_DIR}. Install desktop-app dependencies or set LUKER_DESKTOP_ELECTRON_PATH.`,
                { appDir, cause },
            );
        }
    }
    assertExecutableFile(resolvedExecutable, 'Source desktop Electron executable', DesktopRuntimeError);
    const resolvedAppDir = resolve(appDir);
    if (!existsSync(resolvedAppDir) || !statSync(resolvedAppDir).isDirectory()) {
        throw new DesktopRuntimeError(`Desktop application directory does not exist: ${resolvedAppDir}`, { appDir: resolvedAppDir });
    }
    const pkgPath = join(resolvedAppDir, 'package.json');
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
    return Object.freeze({
        kind: 'source',
        source: electronPath ? 'explicit' : 'desktop-app',
        platform: process.platform,
        arch: process.arch,
        executablePath: realpathSync(resolvedExecutable),
        appDir: realpathSync(resolvedAppDir),
        appVersion: typeof pkg?.version === 'string' ? pkg.version : null,
    });
}

function assertManagedScope(scope, requiredMethods) {
    if (!scope || requiredMethods.some(name => typeof scope[name] !== 'function')) {
        throw new TypeError(`Desktop startup requires a managed resource scope with ${requiredMethods.join(', ')}`);
    }
}

async function resolveManagedDirectory(scope, receipt, label) {
    if (!receipt || typeof receipt !== 'object') {
        throw new TypeError(`Desktop ${label} must be a managed owned or borrowed directory receipt`);
    }
    if (receipt.ownership === 'borrowed') {
        if (typeof receipt.path !== 'string' || !isAbsolute(receipt.path)) {
            throw new TypeError(`Desktop borrowed ${label} requires an absolute path`);
        }
        return await scope.borrowDirectory(receipt.path);
    }
    if (receipt.ownership === 'owned' || typeof receipt.resourceId === 'string') {
        return await scope.verifyDirectory(receipt);
    }
    throw new TypeError(`Desktop ${label} receipt must declare owned or borrowed ownership`);
}

async function forceTerminateElectronApp(electronApp) {
    if (!electronApp) return;
    const child = typeof electronApp.process === 'function' ? electronApp.process() : null;
    const pid = child?.pid ?? null;
    let closeError = null;
    try {
        await electronApp.close();
    } catch (error) {
        closeError = failureFrom(error, 'Desktop Electron close failed');
    }
    if (child && child.exitCode === null && child.signalCode === null && isProcessAlive(pid)) {
        try { child.kill('SIGTERM'); } catch { /* fall through to SIGKILL */ }
        await waitForPidExit(pid, 2_000);
    }
    if (isProcessAlive(pid)) {
        try {
            if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            else process.kill(pid, 'SIGKILL');
        } catch (error) {
            if (error?.code !== 'ESRCH') {
                const killError = failureFrom(error, `Cannot terminate desktop Electron process ${pid}`);
                throw closeError ? failureGroup([closeError, killError], 'Desktop Electron close and termination failed') : killError;
            }
        }
        await waitForPidExit(pid, 5_000);
    }
    if (isProcessAlive(pid)) {
        const aliveError = new Error(`Desktop Electron process ${pid} remained alive after SIGKILL`);
        throw closeError ? failureGroup([closeError, aliveError], 'Desktop Electron process did not terminate') : aliveError;
    }
    if (closeError) throw closeError;
}

function sanitizeDiagnosticSegment(value) {
    return String(value ?? 'default').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

/**
 * @param {{
 *   scope: object,
 *   scenarioId?: string,
 *   passPort?: boolean,
 *   port?: number|null,
 *   userData?: object|null,
 *   defaultUserData?: object|null,
 *   seed?: boolean,
 *   extraEnv?: Record<string, string>,
 *   packaged?: boolean,
 *   waitForSettle?: boolean,
 *   waitForWindow?: boolean,
 *   launchTimeout?: number,
 *   firstWindowTimeout?: number,
 *   settleTimeout?: number,
 *   electronPath?: string|null,
 *   appDir?: string,
 *   artifactDir?: string|null,
 *   artifactManifest?: string|null,
 *   signal?: AbortSignal,
 * }} [options]
 */
export async function launchLukerDesktop({
    scope,
    scenarioId = 'default',
    passPort = true,
    port = null,
    userData = null,
    defaultUserData = null,
    seed = true,
    extraEnv = {},
    packaged = false,
    waitForSettle = true,
    waitForWindow = true,
    launchTimeout,
    firstWindowTimeout,
    settleTimeout = 60_000,
    electronPath = null,
    appDir = DESKTOP_APP_DIR,
    artifactDir = null,
    artifactManifest = null,
    signal,
} = {}) {
    assertManagedScope(scope, ['directory', 'verifyDirectory', 'borrowDirectory', 'onFinalize', 'release', 'captureDiagnostic']);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new TypeError('Desktop port must be an integer TCP port from 1 to 65535');
    }

    // Preflight runtime / packaged artifact BEFORE allocating any directories or resources.
    const artifact = packaged
        ? resolvePackagedDesktopArtifact({
            ...(artifactDir ? { artifactDir } : {}),
            ...(artifactManifest ? { artifactManifest } : {}),
        })
        : resolveSourceDesktopRuntime({
            ...(electronPath ? { electronPath } : {}),
            appDir,
        });

    const verifiedDefault = defaultUserData
        ? await resolveManagedDirectory(scope, defaultUserData, 'defaultUserData')
        : null;
    const verifiedUserData = !verifiedDefault && userData
        ? await resolveManagedDirectory(scope, userData, 'userData')
        : null;
    const autoDirectory = (!verifiedDefault && !verifiedUserData)
        ? await scope.directory(`desktop ${scenarioId}`)
        : null;
    const directory = verifiedDefault ?? verifiedUserData ?? autoDirectory;
    const resolvedUserData = directory.path;

    let autoDirectoryReleased = false;
    let inFlightLaunch = null;
    let launchAborted = false;
    let finalizing = false;

    const releaseAutoDirectory = async () => {
        if (!autoDirectory || autoDirectoryReleased) return;
        autoDirectoryReleased = true;
        const releaseErrors = await scope.release(autoDirectory);
        if (Array.isArray(releaseErrors) && releaseErrors.length) {
            throw failureGroup(releaseErrors, `Cannot release auto-created desktop userData ${autoDirectory.path}`);
        }
    };

    const handle = {
        electronApp: null,
        pid: null,
        page: null,
        baseURL: null,
        port: null,
        dataRoot: resolve(resolvedUserData, 'data'),
        userData: resolvedUserData,
        userDataDirectory: directory,
        defaultUserData: verifiedDefault ? verifiedDefault.path : null,
        packaged: Boolean(packaged),
        platform: artifact.platform,
        arch: artifact.arch,
        artifact,
    };

    const closeApp = async () => {
        launchAborted = true;
        const errors = [];
        if (inFlightLaunch) {
            const pending = inFlightLaunch;
            inFlightLaunch = null;
            try {
                const lateApp = await pending;
                if (lateApp && lateApp !== handle.electronApp) {
                    try { await forceTerminateElectronApp(lateApp); }
                    catch (error) { errors.push(error); }
                }
            } catch {
                // Launch already rejected; original error is owned by open().
            }
        }
        const electronApp = handle.electronApp;
        handle.electronApp = null;
        handle.pid = null;
        handle.page = null;
        handle.baseURL = null;
        handle.port = null;
        if (electronApp) {
            try { await forceTerminateElectronApp(electronApp); }
            catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw failureGroup(errors, `Desktop shutdown failed for ${scenarioId}`);
    };

    handle.close = async ({ removeData = true } = {}) => {
        const errors = [];
        try { await closeApp(); }
        catch (error) { errors.push(error); }
        if (removeData) {
            try { await releaseAutoDirectory(); }
            catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw failureGroup(errors, `Desktop close failed for ${scenarioId}`);
    };

    // Register framework ownership BEFORE seeding or spawning Electron so any failure,
    // interruption, or missing test cleanup hook still terminates Electron and reclaims data.
    await scope.onFinalize({
        label: `desktop:${scenarioId}`,
        stage: 'drain',
        callback: async () => {
            finalizing = true;
            await closeApp();
        },
    });

    await scope.captureDiagnostic({
        name: `desktop-runtime-${sanitizeDiagnosticSegment(scenarioId)}.json`,
        contentType: 'application/json',
        bytes: Buffer.from(JSON.stringify({
            scenarioId,
            ...artifact,
            userDataOwnership: autoDirectory ? 'auto-owned' : directory.ownership,
        }, null, 2)),
    });

    if (!userData && seed !== false) {
        const seeded = await materializeSeed(scope, {
            settingsOverrides: { firstRun: false, power_user: { auto_connect: false } },
        });
        renameSync(seeded.dataRoot, resolve(resolvedUserData, 'data'));
    }

    const open = async () => {
        if (finalizing || signal?.aborted) {
            throw signal?.reason ?? new Error(`Desktop launch aborted for ${scenarioId}`);
        }
        launchAborted = false;
        const launchEnv = { ...process.env };
        if (verifiedDefault) {
            delete launchEnv.LUKER_DESKTOP_USER_DATA;
            launchEnv.LUKER_DESKTOP_DEFAULT_USER_DATA = resolvedUserData;
        } else {
            launchEnv.LUKER_DESKTOP_USER_DATA = resolvedUserData;
        }
        if (
            extraEnv.LUKER_GITHUB_API_BASE === undefined
            && extraEnv.LUKER_DISABLEUPDATECHECK === undefined
            && launchEnv.LUKER_GITHUB_API_BASE === undefined
            && launchEnv.LUKER_DISABLEUPDATECHECK === undefined
        ) {
            launchEnv.LUKER_DISABLEUPDATECHECK = 'true';
        }
        Object.assign(launchEnv, extraEnv);

        const launchOptions = {
            executablePath: artifact.executablePath,
            args: [
                ...(packaged ? [] : [artifact.appDir]),
                ...(passPort && port !== null ? [`--port=${port}`] : []),
            ],
            env: launchEnv,
            ...(launchTimeout !== undefined ? { timeout: launchTimeout } : {}),
        };

        const launchPromise = electron.launch(launchOptions);
        inFlightLaunch = launchPromise;

        const onAbort = () => { launchAborted = true; };
        signal?.addEventListener('abort', onAbort, { once: true });

        let electronApp;
        try {
            electronApp = await launchPromise;
        } finally {
            signal?.removeEventListener('abort', onAbort);
            if (inFlightLaunch === launchPromise) inFlightLaunch = null;
        }

        // Record handle ownership immediately BEFORE firstWindow / waitForURL so any
        // subsequent failure or interruption terminates this exact process.
        handle.electronApp = electronApp;
        handle.pid = electronApp.process()?.pid ?? null;

        if (launchAborted || finalizing || signal?.aborted) {
            await closeApp();
            throw signal?.reason ?? new Error(`Desktop launch was aborted before readiness for ${scenarioId}`);
        }

        try {
            if (!waitForWindow) {
                handle.page = null;
                handle.baseURL = null;
                handle.port = null;
                return;
            }
            const page = await electronApp.firstWindow(
                firstWindowTimeout !== undefined ? { timeout: firstWindowTimeout } : undefined,
            );
            page.on('dialog', (dlg) => {
                if (dlg.type() !== 'beforeunload') {
                    dlg.dismiss().catch(() => {});
                }
            });
            if (waitForSettle) {
                await page.waitForURL(u => isSettled(u), { timeout: settleTimeout });
            }
            const actual = new URL(page.url());
            handle.page = page;
            if (BACKEND_URL.test(actual.href)) {
                handle.baseURL = actual.origin;
                handle.port = Number(actual.port);
            } else {
                handle.baseURL = null;
                handle.port = null;
            }
        } catch (error) {
            const primary = failureFrom(error, `Desktop readiness failed for ${scenarioId}`);
            try { await closeApp(); }
            catch (cleanupError) {
                throw failureGroup([primary, cleanupError], `Desktop readiness and shutdown failed for ${scenarioId}`);
            }
            throw primary;
        }
    };

    handle.relaunch = async () => {
        if (autoDirectoryReleased) {
            throw new Error(`Cannot relaunch desktop ${scenarioId}: auto-created userData was already released`);
        }
        await handle.close({ removeData: false });
        await open();
    };

    handle.waitForExit = async () => {
        const electronApp = handle.electronApp;
        if (!electronApp) return;
        const child = electronApp.process();
        if (child.exitCode === null) {
            await new Promise((resolvePromise, rejectPromise) => {
                const timeout = setTimeout(
                    () => rejectPromise(new Error('Timed out waiting for the desktop app to exit.')),
                    60_000,
                );
                const finish = () => {
                    clearTimeout(timeout);
                    resolvePromise();
                };
                electronApp.once('close', finish);
                if (child.exitCode !== null) finish();
            });
        }
        handle.electronApp = null;
        handle.pid = null;
        handle.page = null;
        handle.baseURL = null;
        handle.port = null;
    };

    try {
        await open();
    } catch (error) {
        const primary = failureFrom(error, `Desktop startup failed for ${scenarioId}`);
        const errors = [primary];
        try { await closeApp(); }
        catch (cleanupError) { errors.push(cleanupError); }
        try { await releaseAutoDirectory(); }
        catch (releaseError) { errors.push(releaseError); }
        throw errors.length === 1 ? primary : failureGroup(errors, `Desktop startup and cleanup failed for ${scenarioId}`);
    }

    return handle;
}

/**
 * Launch the shell through the managed process owner without Playwright's
 * Electron driver for startups expected to quit before showing a window.
 */
export async function spawnLukerDesktop({
    scope,
    defaultUserData,
    port = null,
    extraEnv = {},
    packaged = false,
    electronPath = null,
    appDir = DESKTOP_APP_DIR,
    artifactDir = null,
    artifactManifest = null,
    expectedExit = { code: 0 },
} = {}) {
    assertManagedScope(scope, ['process', 'verifyDirectory', 'borrowDirectory']);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new TypeError('Desktop port must be an integer TCP port from 1 to 65535');
    }
    const verifiedDefault = await resolveManagedDirectory(scope, defaultUserData, 'defaultUserData');
    const artifact = packaged
        ? resolvePackagedDesktopArtifact({
            ...(artifactDir ? { artifactDir } : {}),
            ...(artifactManifest ? { artifactManifest } : {}),
        })
        : resolveSourceDesktopRuntime({
            ...(electronPath ? { electronPath } : {}),
            appDir,
        });

    const env = { ...process.env };
    delete env.LUKER_DESKTOP_USER_DATA;
    env.LUKER_DESKTOP_DEFAULT_USER_DATA = verifiedDefault.path;
    Object.assign(env, extraEnv);

    const command = [
        artifact.executablePath,
        ...(packaged ? [] : [artifact.appDir]),
        ...(port !== null ? [`--port=${port}`] : []),
    ];
    const dependsOn = verifiedDefault.ownership === 'owned' && verifiedDefault.resourceId
        ? [verifiedDefault.resourceId]
        : [];

    const lease = await scope.process({
        label: packaged ? 'desktop-packaged-spawn' : 'desktop-source-spawn',
        command,
        env,
        readyLine: { onSpawn: true },
        expectedExit,
        dependsOn,
    });

    const waitForExit = async (timeoutMs = 30_000) => {
        const exitedPromise = typeof lease.waitForExit === 'function' ? lease.waitForExit() : lease.exited;
        let timer;
        try {
            return await Promise.race([
                exitedPromise,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('Timed out waiting for the desktop app to exit.')),
                        timeoutMs,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    };

    return Object.freeze({
        resourceId: lease.resourceId,
        pid: lease.pid,
        waitForExit,
        stop: () => lease.stop(),
        kill: signal => lease.kill(signal),
    });
}
