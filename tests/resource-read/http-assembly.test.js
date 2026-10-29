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
