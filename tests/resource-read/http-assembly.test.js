import http from 'node:http';

import express from 'express';

import {
    assembleResourceFields,
    invalidateResourceReads,
    readResourceJson,
    readResourceText,
    resetResourceReads,
} from '../../public/scripts/resource-read.js';

function listen(app) {
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, baseURL: `http://127.0.0.1:${port}` });
        });
    });
}

afterEach(() => {
    resetResourceReads();
});

test('rejects a changed field without publishing or retrying', async () => {
    let directoryRequests = 0;
    let releaseField;
    let fieldStarted;
    const fieldGate = new Promise((resolve) => { releaseField = resolve; });
    const fieldEntered = new Promise((resolve) => { fieldStarted = resolve; });

    const app = express();
    app.get('/directory', (request, response) => {
        directoryRequests += 1;
        response.json({
            containers: [{ path: '', keys: ['field'] }],
            fields: [{ path: '/field', etag: 'W/"v1"' }],
        });
    });
    app.get('/field', async (request, response) => {
        fieldStarted();
        await fieldGate;
        response.set('Cache-Control', 'private, no-cache');
        response.set('ETag', 'W/"v2"');
        response.type('application/json').send('"value2"');
    });

    const { server, baseURL } = await listen(app);
    const workObject = { field: 'value1' };
    try {
        const assembly = assembleResourceFields({
            directoryUrl: `${baseURL}/directory`,
            fieldUrl: path => `${baseURL}${path}`,
        });

        await fieldEntered;
        releaseField();

        await expect(assembly).rejects.toMatchObject({
            code: 'read_conflict',
            path: '/field',
            expected: 'W/"v1"',
            actual: 'W/"v2"',
        });
        expect(workObject).toEqual({ field: 'value1' });
        expect(directoryRequests).toBe(1);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('reports a field that disappeared after the directory as a conflict', async () => {
    const app = express();
    app.get('/directory', (request, response) => {
        response.json({
            containers: [{ path: '', keys: ['gone'] }],
            fields: [{ path: '/gone', etag: 'W/"gone"' }],
        });
    });
    app.get('/field', (request, response) => response.sendStatus(404));

    const { server, baseURL } = await listen(app);
    try {
        await expect(assembleResourceFields({
            directoryUrl: `${baseURL}/directory`,
            fieldUrl: () => `${baseURL}/field`,
        })).rejects.toMatchObject({ code: 'read_conflict', path: '/gone', expected: 'W/"gone"' });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('assembles matching field values and preserves JSON types', async () => {
    const app = express();
    app.get('/directory', (request, response) => {
        response.json({
            containers: [{ path: '', keys: ['flag', 'nullable', 'list', 'nested'] }],
            fields: [
                { path: '/flag', etag: 'W/"flag"' },
                { path: '/nullable', etag: 'W/"nullable"' },
                { path: '/list', etag: 'W/"list"' },
                { path: '/nested', etag: 'W/"nested"' },
            ],
        });
    });
    for (const [path, etag, body] of [
        ['/flag', 'W/"flag"', 'true'],
        ['/nullable', 'W/"nullable"', 'null'],
        ['/list', 'W/"list"', '[1,"two"]'],
        ['/nested', 'W/"nested"', '{"a":1}'],
    ]) {
        app.get(path, (request, response) => {
            response.set('ETag', etag);
            response.type('application/json').send(body);
        });
    }

    const { server, baseURL } = await listen(app);
    try {
        const assembled = await assembleResourceFields({
            directoryUrl: `${baseURL}/directory`,
            fieldUrl: path => `${baseURL}${path}`,
        });
        expect(assembled.values.get('/flag')).toBe(true);
        expect(assembled.values.get('/nullable')).toBeNull();
        expect(assembled.values.get('/list')).toEqual([1, 'two']);
        expect(assembled.values.get('/nested')).toEqual({ a: 1 });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

function addFieldDirectory(app, count) {
    app.get('/directory', (request, response) => response.json({
        fields: Array.from({ length: count }, (_, index) => ({
            path: `/field/${index}`,
            etag: `W/"field-${index}"`,
        })),
    }));
}

test('assembles a large directory within the field request concurrency budget', async () => {
    const app = express();
    addFieldDirectory(app, 200);
    let active = 0;
    let peak = 0;
    app.get('/field/:index', async (request, response) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
            if (active > 64) return response.sendStatus(503);
            await new Promise(resolve => setTimeout(resolve, 5));
            response.set('ETag', `W/"field-${request.params.index}"`);
            return response.json({ index: Number(request.params.index) });
        } finally {
            active -= 1;
        }
    });
    const { server, baseURL } = await listen(app);
    try {
        const { values } = await assembleResourceFields({
            directoryUrl: `${baseURL}/directory`,
            fieldUrl: path => `${baseURL}${path}`,
        });
        expect(values.size).toBe(200);
        for (let index = 0; index < 200; index += 1) {
            expect(values.get(`/field/${index}`)).toEqual({ index });
        }
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(64);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('aborting a large assembly leaves queued fields unread', async () => {
    const app = express();
    addFieldDirectory(app, 200);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let started;
    const firstField = new Promise(resolve => { started = resolve; });
    app.get('/field/:index', async (request, response) => {
        started();
        await gate;
        response.set('ETag', `W/"field-${request.params.index}"`).json(null);
    });
    const { server, baseURL } = await listen(app);
    const controller = new AbortController();
    const requested = [];
    try {
        const pending = assembleResourceFields({
            directoryUrl: `${baseURL}/directory`,
            fieldUrl: path => { requested.push(path); return `${baseURL}${path}`; },
            signal: controller.signal,
        });
        await firstField;
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(requested.length).toBeLessThanOrEqual(64);
    } finally {
        release();
        await new Promise(resolve => server.close(resolve));
    }
});

test.each(['missing', 'changed'])('a %s field stops the remaining directory from being queued', async (failure) => {
    const app = express();
    addFieldDirectory(app, 200);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    app.get('/field/:index', async (request, response) => {
        if (request.params.index === '0') {
            if (failure === 'missing') return response.sendStatus(404);
            return response.set('ETag', 'W/"changed"').json(null);
        }
        await gate;
        return response.set('ETag', `W/"field-${request.params.index}"`).json(null);
    });
    const { server, baseURL } = await listen(app);
    const requested = [];
    try {
        await expect(assembleResourceFields({
            directoryUrl: `${baseURL}/directory`,
            fieldUrl: path => { requested.push(path); return `${baseURL}${path}`; },
        })).rejects.toMatchObject({ code: 'read_conflict', path: '/field/0' });
    } finally {
        release();
        await new Promise(resolve => server.close(resolve));
    }
    expect(requested.length).toBeLessThanOrEqual(64);
});

test('preserves each subscriber when one caller cancels a shared request', async () => {
    let requests = 0;
    const app = express();
    app.get('/shared', async (request, response) => {
        requests += 1;
        await new Promise(resolve => setTimeout(resolve, 100));
        response.type('application/json').send('"shared"');
    });

    const { server, baseURL } = await listen(app);
    const url = `${baseURL}/shared`;
    try {
        const controller = new AbortController();
        const cancelled = readResourceText(url, { signal: controller.signal });
        const survivor = readResourceText(url);

        controller.abort();

        await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        await expect(survivor).resolves.toMatchObject({ text: '"shared"' });
        expect(requests).toBe(1);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('invalidates an in-flight read', async () => {
    let requests = 0;
    let started;
    const requestStarted = new Promise((resolve) => { started = resolve; });
    const app = express();
    app.get('/slow', async (request, response) => {
        requests += 1;
        started();
        await new Promise(resolve => setTimeout(resolve, 100));
        response.type('application/json').send('"late"');
    });

    const { server, baseURL } = await listen(app);
    const url = `${baseURL}/slow`;
    try {
        const pending = readResourceText(url);
        await requestStarted;
        invalidateResourceReads([url]);

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests).toBe(1);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('reports an invalid JSON body as a resource error', async () => {
    const app = express();
    app.get('/broken', (request, response) => {
        response.type('application/json').send('{not json');
    });

    const { server, baseURL } = await listen(app);
    try {
        await expect(readResourceJson(`${baseURL}/broken`)).rejects.toMatchObject({
            code: 'invalid_resource',
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
