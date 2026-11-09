/**
 * @jest-environment jsdom
 */
import { expect, test } from '@jest/globals';
import {
    escapeHtml, buildImageTag, buildFailedTag, stripIllustrationMarkup,
    findInsertionPoint, insertTagsAtAnchors, isAllowedImagePath, replaceIllustrationMarkup,
} from '../public/scripts/extensions/stable-diffusion/illustration/message.js';

test('escapes attribute text', () => {
    expect(escapeHtml('a"b<c>&')).toBe('a&quot;b&lt;c&gt;&amp;');
});

test('builds an image tag with data id and width', () => {
    const html = buildImageTag({ id: 'ill_1', imageUrl: '/user/images/a.png', prompt: '1girl, "smile"', width: 80 });
    expect(html).toContain('data-illustration-id="ill_1"');
    expect(html).toContain('src="/user/images/a.png"');
    expect(html).toContain('width: 80%');
    expect(html).toContain('&quot;smile&quot;');
});

test('builds a failed placeholder', () => {
    expect(buildFailedTag({ id: 'ill_1', prompt: 'x', error: 'boom' }))
        .toContain('data-illustration-id="ill_1"');
});

test('strips only illustration markup', () => {
    const text = 'a<img src="/user/images/1.png" data-illustration-id="x">b'
        + '<img src="/user/images/2.png">c<span data-illustration-id="y">bad</span>d';
    expect(stripIllustrationMarkup(text)).toBe('ab<img src="/user/images/2.png">cd');
});

test('finds the first ordered anchor pair with whitespace tolerance', () => {
    const text = 'garden.  The lantern glowed. garden. The lantern glowed.';
    expect(findInsertionPoint(text, 'garden.', 'The lantern')).toBe(8);
});

test('inserts left to right and appends missing anchors', () => {
    const text = 'alpha beta gamma delta';
    const result = insertTagsAtAnchors(text, [
        { id: 'b', html: '<b>', insertAfter: 'gamma', insertBefore: 'delta' },
        { id: 'a', html: '<a>', insertAfter: 'alpha', insertBefore: 'beta' },
        { id: 'c', html: '<c>', insertAfter: 'missing', insertBefore: 'none' },
    ]);
    expect(result.text).toContain('alpha <a> beta');
    expect(result.text).toContain('gamma <b> delta');
    expect(result.text.endsWith('<c>')).toBe(true);
    expect(result.missing).toEqual(['c']);
});

test('rejects non-local image paths', () => {
    expect(isAllowedImagePath('/user/images/a.png')).toBe(true);
    expect(isAllowedImagePath('user/images/a.png')).toBe(true);
    expect(isAllowedImagePath('javascript:alert(1)')).toBe(false);
});

test('replaces one illustration marker by id', () => {
    const text = 'a<img src="/user/images/1.png" data-illustration-id="x">b'
        + '<img src="/user/images/2.png" data-illustration-id="y">c';
    expect(replaceIllustrationMarkup(text, 'x', '<img src="/user/images/3.png" data-illustration-id="z">'))
        .toBe('a<img src="/user/images/3.png" data-illustration-id="z">b'
            + '<img src="/user/images/2.png" data-illustration-id="y">c');
});
