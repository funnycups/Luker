#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Intensity-preservation linter for bundled skill bodies.
 *
 * Plan 3 Unit 3. The original Plan 3 contract is that every bundled
 * `default/skills/global/<name>/SKILL.md` body is a verbatim extraction
 * from director-defaults.js (or another canonical source). A commit that
 * silently shrinks one of those bodies — paraphrasing, compressing, or
 * "tightening" — would erode prompt intensity in a way that ordinary
 * diff review tends to miss. This script gates that.
 *
 * Mechanism
 * ---------
 * For each commit between `baseRef` (default `origin/release`) and HEAD
 * that touches a `default/skills/global/*\/SKILL.md` file, compare the
 * file's line count BEFORE and AFTER the commit. If the file shrunk by
 * more than `SHRINK_THRESHOLD` (30%), the commit is flagged UNLESS its
 * message contains one of the allow-list tags:
 *
 *   `verbatim-from <source>`  the body is a clean re-extraction from
 *                             a different (smaller) source; intentional
 *   `intensity-ok`            human reviewed; shrinkage is acceptable
 *
 * New files (no `before`) and deletions (no `after`) are ignored — we
 * only care about modifications that erode intensity, not adds/removes.
 *
 * Exit code is non-zero when any violation is detected, so CI can wire
 * this into a pre-merge gate.
 *
 * Usage
 * -----
 *   node scripts/check-skill-intensity.js
 *   node scripts/check-skill-intensity.js --base-ref=origin/main
 *   node scripts/check-skill-intensity.js --base-ref=HEAD~10
 *
 * Status
 * ------
 * As of Plan 3 Unit 3 (2026-06), all Plan 3 commits on `feat/skills-
 * foundation` either GROW the skill bodies (Unit 1 verbatim extraction
 * from 13-line stubs to full bodies) or only adjust frontmatter / file
 * paths (Unit 2 rename reconciliation). Running this script with
 * `--base-ref=origin/release` should exit 0.
 */

import { execSync } from 'node:child_process';

const SHRINK_THRESHOLD = 0.30;  // 30% line-count shrinkage triggers a flag
const TAGS = ['verbatim-from', 'intensity-ok'];

/**
 * Run a git subcommand and return trimmed stdout. Throws if git exits
 * non-zero — callers wrap with try/catch where that's expected (e.g.
 * `git show` for a file that didn't exist at the parent commit).
 */
function git(args) {
    return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
}

/**
 * List commits between baseRef..HEAD that touched at least one bundled
 * SKILL.md. Uses the `:(glob)` pathspec magic so `**` correctly matches
 * any directory depth — plain `*` would only match a single segment.
 */
function getCommitsTouchingSkills(baseRef) {
    const out = git(`log --format=%H ${baseRef}..HEAD -- ':(glob)default/skills/global/**/SKILL.md'`);
    return out.split('\n').filter(Boolean);
}

function getCommitMessage(sha) {
    return git(`show -s --format=%B ${sha}`);
}

/**
 * Return the line count of `path` at commit `sha`, or 0 if the file
 * didn't exist at that commit. `git show <sha>:<path>` exits non-zero
 * for missing paths; we swallow that and report 0 so the caller treats
 * the file as new (and skips the shrinkage check). stderr is piped
 * (not inherited) because the missing-path case is expected — letting
 * git's `fatal:` lines through to the user's terminal would be noise.
 */
function getFileLineCountAtCommit(sha, path) {
    try {
        const content = execSync(
            `git show ${sha}:${path}`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        // Match `wc -l`: count of newline characters. Trailing newline
        // produces an empty final element in split('\n'); subtract.
        return content.split('\n').length - 1;
    } catch {
        return 0;
    }
}

/**
 * List the bundled SKILL.md files modified by a single commit. We rely
 * on `git show --name-only` rather than the pathspec passed to `git log`
 * because the latter returns commits where ANY matching file changed —
 * we still need the precise per-commit list of changed paths to compare
 * each one individually.
 */
function getChangedSkillMdFiles(sha) {
    return git(`show --format= --name-only ${sha}`).split('\n')
        .filter(f => /^default\/skills\/global\/[^/]+\/SKILL\.md$/.test(f));
}

const baseRefArg = process.argv.find(a => a.startsWith('--base-ref='));
const baseRef = baseRefArg ? baseRefArg.split('=')[1] : 'origin/release';

let commits;
try {
    commits = getCommitsTouchingSkills(baseRef);
} catch (err) {
    console.error(`[check-skill-intensity] failed to list commits between ${baseRef}..HEAD`);
    console.error(`  ${err.message}`);
    console.error('  Hint: pass a reachable base ref with --base-ref=<ref> (e.g. origin/main).');
    process.exit(2);
}

let violations = 0;

for (const sha of commits) {
    const msg = getCommitMessage(sha);
    const tagged = TAGS.some(t => msg.includes(t));
    if (tagged) continue;

    const files = getChangedSkillMdFiles(sha);
    for (const file of files) {
        const before = getFileLineCountAtCommit(`${sha}~1`, file);
        const after = getFileLineCountAtCommit(sha, file);
        if (before === 0 || after === 0) continue;  // new or deleted file
        const shrinkage = (before - after) / before;
        if (shrinkage > SHRINK_THRESHOLD) {
            console.error(`[shrinkage] ${sha.slice(0, 7)} ${file}: ${before} -> ${after} lines (${(shrinkage * 100).toFixed(1)}% shrunk)`);
            console.error(`  Commit msg: ${msg.split('\n')[0]}`);
            console.error('  If intentional, add \'verbatim-from <source>\' or \'intensity-ok\' to the commit message.');
            violations++;
        }
    }
}

if (violations > 0) {
    console.error(`\n${violations} potential intensity reduction(s) detected.`);
    process.exit(1);
}

console.log(`No skill intensity violations (${commits.length} commit(s) inspected between ${baseRef}..HEAD).`);
process.exit(0);
