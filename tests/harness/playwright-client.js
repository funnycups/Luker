import fs from 'node:fs';
import { requestAuthority } from './resources/authority.js';
import { failureGroup } from './resources/errors.js';

const STAGES = ['capture', 'drain', 'complete'];
const scopeFinalizers = new Map();

function getScopeFinalizers(scopeId) {
    let entries = scopeFinalizers.get(scopeId);
    if (!entries) {
        entries = [];
        scopeFinalizers.set(scopeId, entries);
    }
    return entries;
}

async function runScopeFinalizers(scopeId, message) {
    const entries = scopeFinalizers.get(scopeId);
    if (!entries) return;
    scopeFinalizers.delete(scopeId);
    const errors = [];
    for (const stage of STAGES) {
        const stageEntries = entries.filter(entry => entry.stage === stage);
        for (const { callback } of stageEntries.reverse()) {
            try { await callback(); }
            catch (error) { errors.push(error); }
        }
    }
    if (errors.length) throw failureGroup(errors, message);
}

export function projectAuthority(name) {
    if (!process.env.LUKER_BROWSER_RESOURCES) throw new Error('Native browser resources require the managed global setup and reporter');
    const projects = JSON.parse(process.env.LUKER_BROWSER_RESOURCES);
    if (!Object.hasOwn(projects, name)) throw new Error(`Native browser project has no registered execution: ${name}`);
    return projects[name];
}

export function resourceClient(identity, descriptor) {
    const request = (command, payload = {}) => requestAuthority(identity, 'resource', { ...payload, command, scopeId: descriptor.scopeId });
    const childScopeIds = [];
    const client = Object.freeze({
        ...descriptor,
        transport: 'remote',
        async child(value) {
            const childDesc = await request('child', { descriptor: value });
            childScopeIds.push(childDesc.scopeId);
            return resourceClient(identity, childDesc);
        },
        async scenario(file) {
            const scenarioDesc = await request('scenario', { file });
            if (!childScopeIds.includes(scenarioDesc.scopeId)) childScopeIds.push(scenarioDesc.scopeId);
            return resourceClient(identity, scenarioDesc);
        },
        async frontendApplication() { return Object.freeze(await request('frontend-application')); },
        async directory(label) { return Object.freeze(await request('directory', { label })); },
        async acquire(provider) {
            if (!provider || typeof provider.kind !== 'string') throw new TypeError('Browser resource acquisition requires a provider kind');
            return Object.freeze(await request('acquire', { kind: provider.kind, label: provider.label, options: provider.options }));
        },
        async onFinalize({ label, stage = 'drain', callback }) {
            if (typeof label !== 'string' || !label) throw new TypeError('Browser resource finalization requires a nonempty label');
            if (!STAGES.includes(stage)) throw new TypeError(`Browser resource finalization requires capture/drain/complete stage: ${stage}`);
            if (typeof callback !== 'function') throw new TypeError('Browser resource finalization requires a callback');
            getScopeFinalizers(descriptor.scopeId).push({ label, stage, callback });
            return Object.freeze({ label, stage });
        },
        async diagnostic({ name, contentType, produce, stage = 'capture' }) {
            if (typeof name !== 'string' || !name || typeof contentType !== 'string' || !contentType || typeof produce !== 'function') {
                throw new TypeError('Browser deferred diagnostic requires a name, contentType, and produce callback');
            }
            if (!['capture', 'complete'].includes(stage)) {
                throw new TypeError(`Browser deferred diagnostic requires capture/complete stage: ${stage}`);
            }
            return client.onFinalize({
                label: name,
                stage,
                callback: async () => {
                    const bytes = await produce();
                    await client.captureDiagnostic({ name, bytes, contentType });
                },
            });
        },
        async verifyDirectory(directory) { return Object.freeze(await request('verify-directory', { directory })); },
        borrowDirectory(path) { return request('borrow-directory', { path }); },
        async release(resource) {
            const resourceId = typeof resource === 'string' ? resource : resource?.resourceId;
            if (typeof resourceId !== 'string' || !resourceId) throw new TypeError('Browser resource release requires a resource identity');
            await request('release', { resource: resourceId });
            return [];
        },
        async process(options) {
            const lease = await request('process', { options });
            return Object.freeze({
                ...lease,
                get output() { return fs.readFileSync(lease.outputPath, 'utf8'); },
                kill: signal => request('kill-process', { resourceId: lease.resourceId, signal }),
                expectExit: expected => request('expect-process-exit', { resourceId: lease.resourceId, expected }),
                waitForExit: () => request('wait-process-exit', { resourceId: lease.resourceId }),
                stop: () => request('stop-process', { resourceId: lease.resourceId }),
            });
        },
        captureDiagnostic({ name, bytes, contentType }) {
            if (!(bytes instanceof Uint8Array)) throw new TypeError('Browser diagnostic bytes must be a byte array');
            return request('capture', { name, bytes: Buffer.from(bytes).toString('base64'), contentType });
        },
        async case(info) { return resourceClient(identity, await request('case', { testId: info.testId, retry: info.retry })); },
        async closeScope() {
            const errors = [];
            for (const childId of childScopeIds.splice(0).reverse()) {
                try { await runScopeFinalizers(childId, `Browser child scope ${childId} finalization failed`); }
                catch (error) { errors.push(error); }
            }
            try { await runScopeFinalizers(descriptor.scopeId, `Browser scope ${descriptor.scopeId} finalization failed`); }
            catch (error) { errors.push(error); }
            if (errors.length) throw failureGroup(errors, `Browser scope ${descriptor.scopeId} finalization failed`);
        },
        async closeWorker() {
            const errors = [];
            try { await client.closeScope(); }
            catch (error) { errors.push(error); }
            for (const remainingScopeId of [...scopeFinalizers.keys()].reverse()) {
                try { await runScopeFinalizers(remainingScopeId, `Browser scope ${remainingScopeId} finalization failed`); }
                catch (error) { errors.push(error); }
            }
            try { await request('worker-done'); }
            catch (error) { errors.push(error); }
            if (errors.length) throw failureGroup(errors, 'Browser worker finalization failed');
            return { closed: true };
        },
    });
    return client;
}

export async function workerClient(info) {
    const identity = projectAuthority(info.project.name);
    const descriptor = await requestAuthority(identity, 'resource', { command: 'worker', workerIndex: info.workerIndex, parallelIndex: info.parallelIndex });
    return resourceClient(identity, descriptor);
}
