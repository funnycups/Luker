#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Format a Date (or ISO string) as UTC YYYYMMDD.
 * @param {Date | string} date
 * @returns {string}
 */
function formatUtcDateStamp(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) {
        throw new Error(`Invalid date for dev version: ${String(date)}`);
    }
    const year = String(d.getUTCFullYear());
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

/**
 * Build a SemVer-valid dev prerelease version that sorts strictly above the
 * current package version and strictly below the next rc/beta/alpha/release.
 *
 * - `2.9.0-rc.6` -> `2.9.0-rc.6.dev.20261128.42.g8d9ac4c`
 * - `2.9.0`      -> `2.9.1-0.dev.20261128.42.g8d9ac4c`
 *
 * The `g` prefix on the short commit hash ensures the identifier is always
 * non-numeric, avoiding invalid SemVer numeric identifiers with leading zeros.
 *
 * @param {string} pkgVersion
 * @param {{ date?: Date | string, runNumber: number | string, sha: string }} meta
 * @returns {string}
 */
export function buildDevVersion(pkgVersion, { date = new Date(), runNumber, sha }) {
    const match = String(pkgVersion || '').trim().match(SEMVER_RE);
    if (!match) {
        throw new Error(`Invalid package.json version: ${String(pkgVersion)}`);
    }

    const parsedRun = Number(runNumber);
    if (!Number.isInteger(parsedRun) || parsedRun < 0) {
        throw new Error(`Invalid runNumber for dev version: ${String(runNumber)}`);
    }

    const shortSha = String(sha || '').trim().toLowerCase().slice(0, 7);
    if (!/^[0-9a-f]{7}$/.test(shortSha)) {
        throw new Error(`Invalid commit sha for dev version: ${String(sha)}`);
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const prerelease = match[4] || '';
    const dateStamp = formatUtcDateStamp(date);
    const suffix = `dev.${dateStamp}.${parsedRun}.g${shortSha}`;

    if (prerelease) {
        return `${major}.${minor}.${patch}-${prerelease}.${suffix}`;
    }

    return `${major}.${minor}.${patch + 1}-0.${suffix}`;
}

/**
 * Resolve the npm dist-tag for a release version.
 * Stable versions use `latest`; prereleases use their leading identifier
 * (e.g. `2.9.0-rc.6` -> `rc`, `2.9.0-beta.1` -> `beta`).
 * @param {string} version
 * @returns {string}
 */
export function resolveReleaseDistTag(version) {
    const match = String(version || '').trim().match(SEMVER_RE);
    if (!match) {
        throw new Error(`Invalid release version: ${String(version)}`);
    }

    const prerelease = match[4];
    if (!prerelease) {
        return 'latest';
    }

    const leading = prerelease.split('.')[0];
    if (!leading || /^\d+$/.test(leading)) {
        return 'next';
    }
    return leading.toLowerCase();
}

/**
 * Resolve what version and dist-tag GitHub Actions should publish to npm.
 * @param {{
 *   eventName: string,
 *   ref: string,
 *   refName?: string,
 *   inputTag?: string,
 *   pkgVersion: string,
 *   runNumber?: number | string,
 *   sha?: string,
 *   date?: Date | string,
 * }} params
 * @returns {{ publishVersion: string, distTag: string, mutateVersion: boolean, mode: 'release' | 'dev' }}
 */
export function resolveNpmPublishPlan({
    eventName,
    ref = '',
    refName = '',
    inputTag = '',
    pkgVersion,
    runNumber = 0,
    sha = '',
    date = new Date(),
}) {
    const normalizedInputTag = String(inputTag || '').trim();
    const isTagPush = eventName === 'push' && String(ref).startsWith('refs/tags/');
    const isDispatchTag = eventName === 'workflow_dispatch'
        && normalizedInputTag.length > 0
        && normalizedInputTag.toLowerCase() !== 'dev';

    if (isTagPush || isDispatchTag) {
        const tag = isDispatchTag
            ? normalizedInputTag
            : (String(refName || '').trim() || String(ref).replace(/^refs\/tags\//, ''));
        const tagVersion = tag.replace(/^v/, '');
        if (tagVersion !== pkgVersion) {
            throw new Error(`Tag version (${tagVersion} from ${tag}) does not match package.json version (${pkgVersion}).`);
        }

        return {
            mode: 'release',
            publishVersion: pkgVersion,
            distTag: resolveReleaseDistTag(pkgVersion),
            mutateVersion: false,
        };
    }

    const isReleaseBranchPush = eventName === 'push' && ref === 'refs/heads/release';
    const isDispatchDev = eventName === 'workflow_dispatch'
        && (normalizedInputTag.length === 0 || normalizedInputTag.toLowerCase() === 'dev');

    if (isReleaseBranchPush || isDispatchDev) {
        return {
            mode: 'dev',
            publishVersion: buildDevVersion(pkgVersion, { date, runNumber, sha }),
            distTag: 'dev',
            mutateVersion: true,
        };
    }

    throw new Error(`Unsupported npm publish trigger: event=${eventName} ref=${ref}`);
}

function runCli() {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const plan = resolveNpmPublishPlan({
        eventName: process.env.GITHUB_EVENT_NAME || '',
        ref: process.env.GITHUB_REF || '',
        refName: process.env.GITHUB_REF_NAME || '',
        inputTag: process.env.INPUT_TAG || '',
        pkgVersion: pkg.version,
        runNumber: process.env.GITHUB_RUN_NUMBER || '0',
        sha: process.env.GITHUB_SHA || '',
    });

    const lines = [
        `mode=${plan.mode}`,
        `publish_version=${plan.publishVersion}`,
        `dist_tag=${plan.distTag}`,
        `mutate_version=${plan.mutateVersion}`,
    ];

    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
    } else {
        process.stdout.write(`${lines.join('\n')}\n`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    runCli();
}
