import './_mocks/luker-zh.js';
import { afterEach, beforeEach, test } from '@jest/globals';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAskPage } from '../../public/scripts/extensions/workbench/pages/ask.js';
import { createIteratePage } from '../../public/scripts/extensions/workbench/pages/iterate.js';
import { createSessionStore } from '../../public/scripts/extensions/workbench/model/sessions.js';
import { createMemoryStorage } from '../../public/scripts/extensions/orchestrator/lens/model/recorder.js';

let dom;
beforeEach(() => {
    dom = new JSDOM();
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.requestAnimationFrame = fn => fn();
});
afterEach(() => {
    dom.window.close();
    delete globalThis.document;
    delete globalThis.Node;
    delete globalThis.requestAnimationFrame;
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const reply = Promise.withResolvers();
    const called = Promise.withResolvers();
    const app = {
        sessions: createSessionStore(createMemoryStorage()),
        snapshot: () => ({ preset: { name: 'first' } }),
        settings: () => ({ ask: { sources: {}, redact: true }, reviewChanges: true }),
        suggestions: () => [],
        refreshBadges() {},
        source: {
            askOverview: async () => ({}),
            askReaders: () => ({}),
            aiRequest: () => { called.resolve(); return reply.promise; },
            iterate: {
                scopes: () => ({ preset: { global: true } }),
                load: () => ({ live: {}, target: { ref: 'first' }, title: 'first' }),
                lastReply: () => '',
                systemPrompt: () => 'System',
                tools: () => [],
                units: () => new Map(),
            },
        },
    };
    return { app, reply, called };
}

for (const kind of ['ask', 'iterate']) {
    for (const action of ['switch', 'new']) {
        test(kind + ' keeps a delayed answer in the original conversation after ' + action, async () => {
            const { app, reply, called } = fixture();
            const other = app.sessions.create({ kind, ws: 'preset', scope: 'global', title: 'other' });
            const page = kind === 'ask' ? createAskPage(app) : createIteratePage(app);
            await page.show({ ws: 'preset' });
            page.el.querySelector('textarea').value = 'original';
            page.el.querySelector('.wb-send').click();
            await called.promise;
            const owner = app.sessions.list(kind).find(s => s.title === 'original');
            if (kind === 'ask' && action === 'switch') {
                const select = page.el.querySelector('.wb-chat-hist');
                select.value = other.id;
                select.dispatchEvent(new dom.window.Event('change'));
            } else if (kind === 'iterate' && action === 'switch') {
                await page.show({ sessionId: other.id });
            } else {
                page.el.querySelector(kind === 'ask' ? '.wb-chat-new' : '.wb-sess-head button').click();
            }
            reply.resolve({ text: 'original answer', calls: [] });
            await tick();
            assert.equal(app.sessions.get(owner.id).turns.at(-1)[kind === 'ask' ? 'answer' : 'text'], 'original answer');
            assert.deepEqual(app.sessions.get(other.id).turns, []);
            assert.ok(!page.el.querySelector('.wb-chat-body').textContent.includes('original answer'));
        });
    }
}

test('starting another conversation during the overview keeps the request in its original session', async () => {
    const { app } = fixture();
    const overview = Promise.withResolvers();
    app.source.askOverview = () => overview.promise;
    app.source.aiRequest = async () => ({ text: 'answer to first', calls: [] });
    const page = createAskPage(app);
    page.show();
    page.el.querySelector('textarea').value = 'first';
    page.el.querySelector('.wb-send').click();
    page.el.querySelector('.wb-chat-new').click();
    overview.resolve({});
    await tick();
    assert.equal(app.sessions.list()[0].turns.at(-1).answer, 'answer to first');
    assert.ok(!page.el.querySelector('.wb-chat-body').textContent.includes('answer to first'));
});
