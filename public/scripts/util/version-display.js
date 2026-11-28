// SPDX-License-Identifier: AGPL-3.0-or-later

const NPM_DEV_VERSION_RE = /^(\d+\.\d+\.\d+(?:-(?!0\.dev\.)[0-9A-Za-z.-]+)?)(?:-0)?\.dev\.(\d{8})\.(\d+)\.g([0-9a-f]{7,40})$/i;

/**
 * Parses an automated npm `@dev` snapshot version into readable parts.
 * Returns null for regular release/prerelease versions.
 * @param {unknown} version
 * @returns {{ baseVersion: string, date: string, runNumber: string, sha: string } | null}
 */
export function parseNpmDevVersion(version) {
    if (typeof version !== 'string') {
        return null;
    }
    const match = version.trim().match(NPM_DEV_VERSION_RE);
    if (!match) {
        return null;
    }
    return {
        baseVersion: match[1],
        date: match[2],
        runNumber: match[3],
        sha: match[4],
    };
}

/**
 * Formats a Luker version string for compact UI badges and headers, turning
 * verbose npm `@dev` SemVer snapshots into `<base>-dev (<sha>)`.
 * @param {unknown} version
 * @returns {string}
 */
export function formatCompactVersion(version) {
    const raw = String(version ?? '').trim();
    const dev = parseNpmDevVersion(raw);
    if (!dev) {
        return raw;
    }
    return `${dev.baseVersion}-dev (${dev.sha})`;
}

/**
 * Formats the main Luker display version shown on the welcome screen and
 * settings panel, matching the git `'branch' (sha)` layout for npm `@dev` builds.
 * @param {unknown} lukerVersion
 * @param {{ gitBranch?: string | null, gitRevision?: string | null }} [meta]
 * @returns {string}
 */
export function formatLukerDisplayVersion(lukerVersion, { gitBranch = null, gitRevision = null } = {}) {
    const raw = String(lukerVersion ?? '').trim();
    if (gitRevision && gitBranch) {
        return `Luker ${raw} '${gitBranch}' (${gitRevision})`;
    }
    const dev = parseNpmDevVersion(raw);
    if (dev) {
        return `Luker ${dev.baseVersion} 'dev' (${dev.sha})`;
    }
    return `Luker ${raw}`;
}
