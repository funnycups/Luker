// Resolve packaged desktop build artifacts and the source Electron runtime
// for desktop E2E tests and preflight checks without loading Playwright.

import { createHash } from 'node:crypto';
import { constants as fsConstants, accessSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DESKTOP_APP_DIR = resolve(REPO_ROOT, 'desktop-app');
const requireDesktop = createRequire(resolve(DESKTOP_APP_DIR, 'package.json'));

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

function sha256File(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readDesktopManifest() {
    return JSON.parse(readFileSync(resolve(DESKTOP_APP_DIR, 'package.json'), 'utf8'));
}

function assertExecutableFile(filePath, label, ErrorClass, { requireExecutableBit = process.platform !== 'win32' } = {}) {
    if (!existsSync(filePath)) {
        throw new ErrorClass(`${label} does not exist at ${filePath}`, { executablePath: filePath });
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) {
        throw new ErrorClass(`${label} is not a regular file: ${filePath}`, { executablePath: filePath });
    }
    if (requireExecutableBit) {
        try {
            accessSync(filePath, fsConstants.X_OK);
        } catch (cause) {
            throw new ErrorClass(`${label} is not executable: ${filePath}`, { executablePath: filePath, cause });
        }
    }
}

function packagedCandidates(distDir, platform, arch) {
    const manifest = readDesktopManifest();
    const productName = manifest.build?.productName ?? manifest.productName;
    const explicitLinuxExecutable = manifest.build?.linux?.executableName ?? manifest.build?.executableName;
    const linuxExecutable = explicitLinuxExecutable ?? String(manifest.name).replace(/^@[^/]+\//, '').toLowerCase();

    if (platform === 'darwin') {
        const dirs = arch === 'arm64'
            ? [join(distDir, 'mac-arm64', `${productName}.app`)]
            : [join(distDir, 'mac', `${productName}.app`), join(distDir, 'mac-x64', `${productName}.app`)];
        return dirs.map(appDir => ({
            bundlePath: appDir,
            executablePath: join(appDir, 'Contents', 'MacOS', productName),
            resourcesDir: join(appDir, 'Contents', 'Resources'),
            metadataPath: join(distDir, 'latest-mac.yml'),
        }));
    }
    if (platform === 'linux') {
        const unpacked = arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
        const dir = join(distDir, unpacked);
        return [{
            bundlePath: dir,
            executablePath: join(dir, linuxExecutable),
            resourcesDir: join(dir, 'resources'),
            metadataPath: join(distDir, arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml'),
        }];
    }
    if (platform === 'win32') {
        const unpacked = arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked';
        const dir = join(distDir, unpacked);
        return [{
            bundlePath: dir,
            executablePath: join(dir, `${productName}.exe`),
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

    assertExecutableFile(
        resolvedExecutable,
        `Packaged desktop executable (${platform}-${arch})`,
        PackagedDesktopArtifactError,
        { requireExecutableBit: process.platform !== 'win32' && platform !== 'win32' },
    );
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
