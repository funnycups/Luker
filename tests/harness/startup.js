import fs from 'node:fs';
import path from 'node:path';
import { recoverRuns } from './resources/recovery.js';
import { executionEnded } from './resources/writer-custody.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const terminal = new Set(['disposed', 'released']);
const admissions = new Map();

function isRealDirectory(directory) {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && fs.realpathSync(directory) === directory;
}

function identityKey(identity) {
    const n = identity?.native;
    if (!n) return null;
    return `${n.platform}:${n.bootId}:${n.pid}:${n.startTime}:${n.uid}`;
}

/**
 * Remove completed passing runs whose owning executions have ended and that hold
 * no pending diagnostics, exports, or live resources. Failed and cancelled runs
 * remain on disk for diagnostic slot inspection and lineage.
 */
export async function pruneCompletedRuns({ projectRoot, profiles }) {
    let runsDir = projectRoot;
    for (const component of ['test-results', 'harness', 'runs']) {
        runsDir = path.join(runsDir, component);
        try { if (!isRealDirectory(runsDir)) return 0; }
        catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    }
    const endedCache = new Map();
    const hasEnded = async (identity) => {
        if (!identity?.native || identity.native.pid === process.pid) return false;
        const key = identityKey(identity);
        if (!key) return false;
        if (endedCache.has(key)) return endedCache.get(key);
        const ended = await executionEnded(identity);
        endedCache.set(key, ended);
        return ended;
    };
    let pruned = 0;
    let entries;
    try {
        entries = fs.readdirSync(runsDir, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
    }
    for (const entry of entries) {
        if (!uuid.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const directory = path.join(runsDir, entry.name);
        const registryPath = path.join(directory, 'registry.json');
        let snapshot;
        try {
            const stat = fs.lstatSync(registryPath);
            if (!stat.isFile()) continue;
            snapshot = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        if (snapshot?.format !== 'resource-run-v2') continue;
        if (!profiles.includes(snapshot.profile)) continue;
        if (snapshot.runId !== entry.name || snapshot.projectRoot !== projectRoot) continue;
        if (snapshot.status !== 'passed' || snapshot.diagnosticIndex !== null) continue;
        if (snapshot.diagnostics) {
            const d = snapshot.diagnostics;
            if (d.stage !== 'discarded' || d.retentionPending !== false || d.bundle !== null || !Array.isArray(d.pending) || d.pending.length > 0) continue;
        }
        if (snapshot.environmentExport && (snapshot.environmentExport.state !== 'complete' || snapshot.environmentExport.cleanup?.state === 'removing')) continue;
        if (!Array.isArray(snapshot.resources) || !snapshot.resources.every(r => r && terminal.has(r.state))) continue;
        if (fs.existsSync(path.join(directory, 'writer-custody', 'execution.json'))) continue;
        const dataDir = path.join(directory, 'data');
        try {
            if (fs.readdirSync(dataDir).length > 0) continue;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (!await hasEnded(snapshot.owner) || !await hasEnded(snapshot.writer)) continue;
        try {
            fs.rmSync(directory, { recursive: true, force: false });
            pruned++;
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY' && error.code !== 'EBUSY') throw error;
        }
    }
    return pruned;
}

/** Recover selected profiles once before this command admits their resources. */
export function recoverBeforeRun({ projectRoot, profiles }) {
    const key = JSON.stringify([projectRoot, [...profiles].sort()]);
    let admission = admissions.get(key);
    if (!admission) {
        admission = (async () => {
            const { registerDatabaseProviders } = await import('./database.js');
            registerDatabaseProviders();
            const report = await recoverRuns({ projectRoot, profiles });
            await pruneCompletedRuns({ projectRoot, profiles });
            return report;
        })();
        admissions.set(key, admission);
    }
    return admission;
}
