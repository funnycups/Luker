// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import fs from 'node:fs';
import path from 'node:path';

import { compareSemver, parseSemverLikeVersion } from './semver.js';
import { serverDirectory } from './server-directory.js';
import { getVersion } from './util.js';

const DOCS_ORIGIN = 'https://luker.cups.moe';
const GITHUB_COMPARE_PREFIX = 'https://github.com/funnycups/Luker/compare/';
const HEX_REVISION_RE = /^[0-9a-f]{6,40}$/i;
const UNRELEASED_HEADING_RE = /^##\s+(?:Unreleased|未发布|未發布)\s*$/i;
const RELEASE_HEADING_RE = /^##\s+v([^\s(]+)(?:\s*\(([^)]+)\))?\s*$/i;
const COMPARE_FOOTER_LINE_RE = /^\*\*(?:Full Changelog|完整更新日志|完整更新日誌)\*\*[：:].*$/i;
const INLINE_OR_VPRE_RE = /`[^`]+`|<span\s+v-pre\s*>|<span(?:\s[^>]*)?>|<\/span\s*>/gi;
const VPRE_OPEN_RE = /^<span\s+v-pre\s*>$/i;

/**
 * @typedef {Object} ChangelogSection
 * @property {string | null} version
 * @property {string | null} date
 * @property {boolean} unreleased
 * @property {string} markdown
 */

/**
 * @typedef {Object} RuntimeIdentity
 * @property {string} version
 * @property {string | null} revision
 * @property {string | null} branch
 */

/** @type {Promise<RuntimeIdentity> | null} */
let cachedIdentityPromise = null;

/**
 * Resolves a client locale string to the matching local changelog file and docs URL.
 * @param {string} [locale]
 * @returns {{ relativePath: string, changelogUrl: string, localeKey: 'en' | 'zh-CN' | 'zh-TW' }}
 */
export function resolveChangelogLocale(locale) {
    const normalized = String(locale || '').trim().toLowerCase().replaceAll('_', '-');
    if (
        normalized === 'zh-tw'
        || normalized === 'zh-hk'
        || normalized === 'zh-mo'
        || normalized.startsWith('zh-hant')
    ) {
        return {
            relativePath: 'docs/zh-TW/changelog.md',
            changelogUrl: `${DOCS_ORIGIN}/zh-TW/changelog`,
            localeKey: 'zh-TW',
        };
    }

    if (normalized === 'zh' || normalized.startsWith('zh-')) {
        return {
            relativePath: 'docs/zh-CN/changelog.md',
            changelogUrl: `${DOCS_ORIGIN}/zh-CN/changelog`,
            localeKey: 'zh-CN',
        };
    }

    return {
        relativePath: 'docs/changelog.md',
        changelogUrl: `${DOCS_ORIGIN}/changelog`,
        localeKey: 'en',
    };
}

/**
 * Unwraps VitePress `<span v-pre>...</span >` wrappers used to shield `{{...}}`
 * macro literals from Vue template compilation, while preserving inline code
 * spans and all other HTML tags verbatim.
 * @param {string} line
 * @returns {string}
 */
function stripVitePressVPre(line) {
    const str = String(line || '');
    let out = '';
    let last = 0;
    let openTag = null;
    let inner = '';
    let innerSpanDepth = 0;

    for (const match of str.matchAll(INLINE_OR_VPRE_RE)) {
        const token = match[0];
        const idx = match.index ?? 0;
        const between = str.slice(last, idx);

        if (openTag !== null) {
            inner += between;
        } else {
            out += between;
        }

        if (token.startsWith('`')) {
            if (openTag !== null) {
                inner += token;
            } else {
                out += token;
            }
        } else if (token.startsWith('</')) {
            if (openTag !== null) {
                if (innerSpanDepth > 0) {
                    innerSpanDepth -= 1;
                    inner += token;
                } else {
                    out += inner;
                    openTag = null;
                    inner = '';
                }
            } else {
                out += token;
            }
        } else if (VPRE_OPEN_RE.test(token)) {
            if (openTag !== null) {
                out += openTag + inner;
            }
            openTag = token;
            inner = '';
            innerSpanDepth = 0;
        } else if (openTag !== null) {
            innerSpanDepth += 1;
            inner += token;
        } else {
            out += token;
        }

        last = idx + token.length;
    }

    const tail = str.slice(last);
    return openTag !== null ? out + openTag + inner + tail : out + tail;
}

/**
 * Cleans a raw changelog section body by stripping per-version compare footers,
 * VitePress `v-pre` wrappers, and surrounding blank lines.
 * @param {string[]} bodyLines
 * @returns {string}
 */
function normalizeSectionBody(bodyLines) {
    const filtered = bodyLines
        .filter(line => !COMPARE_FOOTER_LINE_RE.test(line.trim()))
        .map(stripVitePressVPre);
    return filtered.join('\n').trim();
}

/**
 * Parses a Luker trilingual changelog Markdown file into optional `unreleased`
 * and ordered `releases` sections (preserving file order, newest first).
 * @param {string} content
 * @returns {{ unreleased: ChangelogSection | null, releases: ChangelogSection[] }}
 */
export function parseChangelogMarkdown(content) {
    const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
    /** @type {ChangelogSection | null} */
    let unreleased = null;
    /** @type {ChangelogSection[]} */
    const releases = [];

    /** @type {{ version: string | null, date: string | null, unreleased: boolean, lines: string[] } | null} */
    let current = null;

    const flush = () => {
        if (!current) return;
        const markdown = normalizeSectionBody(current.lines);
        if (markdown.length > 0) {
            const section = {
                version: current.version,
                date: current.date,
                unreleased: current.unreleased,
                markdown,
            };
            if (section.unreleased) {
                if (!unreleased) unreleased = section;
            } else {
                releases.push(section);
            }
        }
        current = null;
    };

    for (const line of lines) {
        if (line.startsWith('## ')) {
            flush();
            if (UNRELEASED_HEADING_RE.test(line)) {
                current = { version: null, date: null, unreleased: true, lines: [] };
                continue;
            }
            const match = line.match(RELEASE_HEADING_RE);
            if (match && parseSemverLikeVersion(match[1])) {
                current = {
                    version: match[1].trim(),
                    date: match[2] ? match[2].trim() : null,
                    unreleased: false,
                    lines: [],
                };
            }
            continue;
        }

        if (current) {
            current.lines.push(line);
        }
    }
    flush();

    return { unreleased, releases };
}

/**
 * Loads and parses the bundled changelog for a client locale.
 * @param {string} [locale]
 * @param {{ baseDir?: string }} [options]
 * @returns {{ unreleased: ChangelogSection | null, releases: ChangelogSection[], changelogUrl: string }}
 */
export function loadChangelogForLocale(locale, { baseDir = serverDirectory } = {}) {
    const resolved = resolveChangelogLocale(locale);
    const fullPath = path.join(baseDir, resolved.relativePath);
    if (!fs.existsSync(fullPath)) {
        console.warn(`[whats-new] Changelog file not found at ${fullPath}`);
        return { unreleased: null, releases: [], changelogUrl: resolved.changelogUrl };
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const parsed = parseChangelogMarkdown(content);
    return { ...parsed, changelogUrl: resolved.changelogUrl };
}

/**
 * Snapshots the running Luker version and git metadata once per server boot.
 * @returns {Promise<RuntimeIdentity>}
 */
export function getRuntimeIdentity() {
    if (!cachedIdentityPromise) {
        cachedIdentityPromise = getVersion().then(info => ({
            version: String(info?.lukerVersion || '').trim(),
            revision: info?.gitRevision ? String(info.gitRevision).trim() : null,
            branch: info?.gitBranch ? String(info.gitBranch).trim() : null,
        }));
    }
    return cachedIdentityPromise;
}

/**
 * Returns the initial seen-version fields stamped onto brand-new user accounts.
 * @param {RuntimeIdentity | null} [identity]
 * @returns {Promise<{ lastSeenVersion?: string, lastSeenRevision: string | null }>}
 */
export async function getInitialSeenVersionFields(identity = null) {
    const current = identity ?? await getRuntimeIdentity();
    const fields = { lastSeenRevision: current.revision ?? null };
    if (parseSemverLikeVersion(current.version)) {
        fields.lastSeenVersion = current.version;
    }
    return fields;
}

/**
 * Builds a GitHub compare URL when both revisions are valid hex commit hashes.
 * @param {string | null | undefined} previousRevision
 * @param {string | null | undefined} currentRevision
 * @returns {string | null}
 */
function buildCompareUrl(previousRevision, currentRevision) {
    if (!previousRevision || !currentRevision) return null;
    if (!HEX_REVISION_RE.test(previousRevision) || !HEX_REVISION_RE.test(currentRevision)) return null;
    return `${GITHUB_COMPARE_PREFIX}${encodeURIComponent(previousRevision)}...${encodeURIComponent(currentRevision)}`;
}

/**
 * Evaluates whether a user should see the post-update modal, which changelog
 * sections to display, and whether their stored record needs a silent sync
 * (downgrade or initial revision backfill).
 *
 * @param {{ userRecord: Record<string, any> | null | undefined, current: RuntimeIdentity, locale?: string, baseDir?: string }} params
 * @returns {{ payload: Record<string, any>, silentSync: { lastSeenVersion: string, lastSeenRevision: string | null } | null }}
 */
export function evaluateWhatsNew({ userRecord, current, locale, baseDir } = {}) {
    if (!userRecord || !current || !parseSemverLikeVersion(current.version)) {
        return { payload: { show: false }, silentSync: null };
    }

    const lastSeenVersion = typeof userRecord.lastSeenVersion === 'string' && userRecord.lastSeenVersion.trim()
        ? userRecord.lastSeenVersion.trim()
        : null;
    const lastSeenRevision = typeof userRecord.lastSeenRevision === 'string' && userRecord.lastSeenRevision.trim()
        ? userRecord.lastSeenRevision.trim()
        : null;
    const currentRevision = current.revision ? String(current.revision).trim() : null;
    const branch = current.branch ? String(current.branch).trim() : null;

    // Pre-feature existing account: show current version once on first upgrade.
    if (!lastSeenVersion) {
        const { unreleased, releases, changelogUrl } = loadChangelogForLocale(locale, { baseDir });
        const sections = [];
        if (unreleased) sections.push(unreleased);
        const exact = releases.find(s => s.version && compareSemver(s.version, current.version) === 0);
        if (exact) sections.push(exact);
        return {
            payload: {
                show: true,
                kind: 'release',
                currentVersion: current.version,
                previousVersion: null,
                currentRevision,
                previousRevision: lastSeenRevision,
                branch,
                sections,
                changelogUrl,
                compareUrl: null,
            },
            silentSync: null,
        };
    }

    const versionCmp = compareSemver(current.version, lastSeenVersion);

    if (versionCmp > 0) {
        const { unreleased, releases, changelogUrl } = loadChangelogForLocale(locale, { baseDir });
        const sections = [];
        if (unreleased) sections.push(unreleased);
        for (const section of releases) {
            if (
                section.version
                && compareSemver(section.version, lastSeenVersion) > 0
                && compareSemver(section.version, current.version) <= 0
            ) {
                sections.push(section);
            }
        }
        return {
            payload: {
                show: true,
                kind: 'release',
                currentVersion: current.version,
                previousVersion: lastSeenVersion,
                currentRevision,
                previousRevision: lastSeenRevision,
                branch,
                sections,
                changelogUrl,
                compareUrl: null,
            },
            silentSync: null,
        };
    }

    if (versionCmp < 0) {
        return {
            payload: { show: false },
            silentSync: {
                lastSeenVersion: current.version,
                lastSeenRevision: currentRevision,
            },
        };
    }

    // Same semver: check for dev / git-pull revision change.
    if (currentRevision && lastSeenRevision && currentRevision !== lastSeenRevision) {
        const { unreleased, changelogUrl } = loadChangelogForLocale(locale, { baseDir });
        return {
            payload: {
                show: true,
                kind: 'dev',
                currentVersion: current.version,
                previousVersion: lastSeenVersion,
                currentRevision,
                previousRevision: lastSeenRevision,
                branch,
                sections: unreleased ? [unreleased] : [],
                changelogUrl,
                compareUrl: buildCompareUrl(lastSeenRevision, currentRevision),
            },
            silentSync: null,
        };
    }

    if (currentRevision && !lastSeenRevision) {
        return {
            payload: { show: false },
            silentSync: {
                lastSeenVersion: current.version,
                lastSeenRevision: currentRevision,
            },
        };
    }

    return { payload: { show: false }, silentSync: null };
}

/**
 * Verifies that a client ack targets the server's currently running version and
 * revision so a stale tab from an older deployment cannot acknowledge a newer one.
 * @param {{ ackVersion: string, ackRevision?: string | null, current: RuntimeIdentity }} params
 * @returns {boolean}
 */
export function shouldApplyAck({ ackVersion, ackRevision, current }) {
    if (!current || typeof ackVersion !== 'string' || ackVersion.trim() !== current.version) {
        return false;
    }
    if (current.revision) {
        const normalizedAckRev = typeof ackRevision === 'string' ? ackRevision.trim() : '';
        return normalizedAckRev === current.revision;
    }
    return true;
}
