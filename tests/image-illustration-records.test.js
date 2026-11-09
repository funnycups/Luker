/**
 * @jest-environment jsdom
 */
import { expect, test } from '@jest/globals';
import {
    createIllustrationRecord, getIllustrationRecord, appendIllustrationRecords,
    removeIllustrationRecord, applyIllustrationResult, syncMessageSwipeData,
    clearSwipeIllustrationRecords,
} from '../public/scripts/extensions/stable-diffusion/illustration/records.js';

function makeMessage() {
    return {
        mes: 'alpha beta gamma delta',
        swipe_id: 0,
        swipes: ['alpha beta gamma delta'],
        swipe_info: [{ extra: {} }],
        extra: {},
    };
}

test('applies records inline and syncs the current swipe', () => {
    const message = makeMessage();
    const record = createIllustrationRecord({
        id: 'ill_1', prompt: 'p', imageUrl: '/user/images/a.png', status: 'ready',
        error: '', parentId: null, anchorAfter: 'alpha', anchorBefore: 'beta', createdAt: 1,
    });
    const result = applyIllustrationResult({
        message, records: [record], imageDisplayWidth: 100, ensureSwipes: () => {},
    });
    expect(result.inserted).toEqual(['ill_1']);
    expect(message.mes).toContain('data-illustration-id="ill_1"');
    expect(message.extra.illustrations).toHaveLength(1);
    expect(message.swipes[0]).toBe(message.mes);
    expect(message.swipe_info[0].extra.illustrations).toHaveLength(1);
});

test('failed records use the failed placeholder', () => {
    const message = makeMessage();
    const record = createIllustrationRecord({
        id: 'ill_1', prompt: 'p', imageUrl: '', status: 'failed', error: 'boom',
        parentId: null, anchorAfter: 'alpha', anchorBefore: 'beta', createdAt: 1,
    });
    applyIllustrationResult({
        message, records: [record], imageDisplayWidth: 100, ensureSwipes: () => {},
        failedLabel: 'Image generation failed',
    });
    expect(message.mes).toContain('Image generation failed');
    expect(message.mes).toContain('data-illustration-id="ill_1"');
});

test('removing a record removes its descendants and keeps ancestors', () => {
    const message = makeMessage();
    const parent = createIllustrationRecord({ id: 'p', prompt: 'p', imageUrl: '/user/images/p.png', status: 'ready', error: '', parentId: null, anchorAfter: 'a', anchorBefore: 'b', createdAt: 1 });
    const child = createIllustrationRecord({ id: 'c', prompt: 'c', imageUrl: '/user/images/c.png', status: 'ready', error: '', parentId: 'p', anchorAfter: 'a', anchorBefore: 'b', createdAt: 2 });
    appendIllustrationRecords(message, [parent, child]);
    expect(getIllustrationRecord(message, 'c')).not.toBeNull();
    const removed = removeIllustrationRecord(message, 'c');
    expect(removed.map(r => r.id)).toEqual(['c']);
    expect(getIllustrationRecord(message, 'p')).not.toBeNull();
});

test('a freshly generated swipe drops records copied from the previous swipe', () => {
    const message = makeMessage();
    const record = createIllustrationRecord({
        id: 'ill_1', prompt: 'p', imageUrl: '/user/images/a.png', status: 'ready',
        parentId: null, anchorAfter: 'alpha', anchorBefore: 'beta', createdAt: 1,
    });
    appendIllustrationRecords(message, [record]);
    message.swipe_id = 1;
    message.mes = '...';
    message.swipes = ['alpha beta', '...'];
    message.swipe_info = [
        { extra: { illustrations: [record] } },
        { extra: { illustrations: [record] } },
    ];

    const removed = clearSwipeIllustrationRecords(message);

    expect(removed).toEqual([record]);
    expect(message.extra.illustrations).toBeUndefined();
    expect(message.swipe_info[1].extra.illustrations).toBeUndefined();
    expect(message.swipe_info[0].extra.illustrations).toHaveLength(1);
});

test('clearing copied records does not materialize a pending swipe slot', () => {
    const message = makeMessage();
    const record = createIllustrationRecord({
        id: 'ill_1', prompt: 'p', imageUrl: '/user/images/a.png', status: 'ready',
        parentId: null, anchorAfter: 'alpha', anchorBefore: 'beta', createdAt: 1,
    });
    appendIllustrationRecords(message, [record]);
    message.swipe_id = 1;
    message.mes = '';
    message.swipes = ['alpha beta'];
    message.swipe_info = [{ extra: { illustrations: [record] } }];

    clearSwipeIllustrationRecords(message);

    expect(message.extra.illustrations).toBeUndefined();
    expect(message.swipes).toHaveLength(1);
    expect(message.swipe_info).toHaveLength(1);
});

test('swipe sync clones extra into the current swipe info', () => {
    const message = makeMessage();
    message.mes = 'changed';
    syncMessageSwipeData(message, () => {});
    expect(message.swipes[0]).toBe('changed');
    expect(message.swipe_info[0].extra).toEqual(message.extra);
});
