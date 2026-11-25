import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { makeEndpointHarness } from '../storage/harness/endpoint-harness.js';
import { router } from '../../src/endpoints/worldinfo.js';

/** Real HTTP router and filesystem repository, with an observational disk proxy. */
export async function createWorldInfoHarness() {
    return makeEndpointHarness({ mode: 'fs', mount: app => app.use('/api/worldinfo', router) });
}

export function worldInfoContext(harness, seed) {
    const file = name => path.join(harness.dirs.worlds, `${name}.json`);
    for (const [name, data] of Object.entries(seed)) fs.writeFileSync(file(name), JSON.stringify(data));
    const disk = new Proxy({}, {
        get: (_target, name) => fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : undefined,
        set: (_target, name, data) => { fs.writeFileSync(file(name), JSON.stringify(data)); return true; },
        deleteProperty: (_target, name) => { fs.rmSync(file(name), { force: true }); return true; },
        ownKeys: () => fs.readdirSync(harness.dirs.worlds).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)),
        getOwnPropertyDescriptor: (_target, name) => fs.existsSync(file(name)) ? { configurable: true, enumerable: true } : undefined,
    });
    const context = {
        getWorldInfoNames: () => Object.keys(disk),
        loadWorldInfo: async name => {
            const response = await request(harness.app).post('/api/worldinfo/get').send({ name }).expect(200);
            return response.body;
        },
        saveWorldInfo: async (name, data) => {
            await request(harness.app).post('/api/worldinfo/edit').send({ name, data }).expect(200);
        },
    };
    return { disk, context };
}
