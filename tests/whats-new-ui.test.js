/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
    initWhatsNew,
    renderChangelogMarkdown,
    resetWhatsNewInitForTests,
    resolveWhatsNewTheme,
    showWhatsNewModal,
} from '../public/scripts/whats-new.js';

afterEach(() => {
    resetWhatsNewInitForTests();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    delete document.documentElement.dataset.theme;
    localStorage.clear();
    delete window.toastr;
});

describe('renderChangelogMarkdown', () => {
    test('renders category headings, bullet lists, inline bold, and inline code safely', () => {
        const md = [
            '### Workbench',
            '',
            '- Added **floating** window with `tokens.css` support.',
            '- Improved layout.',
        ].join('\n');

        const root = renderChangelogMarkdown(md);
        expect(root.querySelector('h4')?.textContent).toBe('Workbench');
        const items = root.querySelectorAll('ul > li');
        expect(items).toHaveLength(2);
        expect(items[0].querySelector('strong')?.textContent).toBe('floating');
        expect(items[0].querySelector('code')?.textContent).toBe('tokens.css');
    });

    test('rewrites root-relative docs links to luker.cups.moe and linkifies bare https URLs', () => {
        const md = [
            '- Added [Workbench Guide](/zh-CN/features/workbench) and [API](/development/extension-api/workbench).',
            '* @user contributed in https://github.com/funnycups/Luker/pull/64',
        ].join('\n');

        const root = renderChangelogMarkdown(md);
        const links = Array.from(root.querySelectorAll('a'));
        expect(links).toHaveLength(3);
        expect(links[0].getAttribute('href')).toBe('https://luker.cups.moe/zh-CN/features/workbench');
        expect(links[0].getAttribute('target')).toBe('_blank');
        expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
        expect(links[0].textContent).toBe('Workbench Guide');

        expect(links[1].getAttribute('href')).toBe('https://luker.cups.moe/development/extension-api/workbench');
        expect(links[2].getAttribute('href')).toBe('https://github.com/funnycups/Luker/pull/64');
    });

    test('rejects unsafe link protocols without leaving stray parens and escapes raw HTML tags as text', () => {
        const md = [
            '- [Click me](javascript:alert(1)) and [Data](data:text/html,hi)',
            '- Raw <script>window.__xss = 1</script> payload.',
        ].join('\n');

        const root = renderChangelogMarkdown(md);
        expect(root.querySelectorAll('a')).toHaveLength(0);
        expect(root.querySelectorAll('script')).toHaveLength(0);
        expect(root.textContent).toContain('Click me and Data');
        expect(root.textContent).not.toContain('Click me)');
        expect(root.textContent).toContain('<script>window.__xss = 1</script>');
    });

    test('renders inline code and links nested inside bold spans and preserves balanced parentheses in URLs', () => {
        const md = [
            '- **New API (`updateCharacterData`) with [Docs](/features/workbench).**',
            '- See [Article](https://en.wikipedia.org/wiki/Foo_(bar)) for details.',
        ].join('\n');

        const root = renderChangelogMarkdown(md);
        const items = root.querySelectorAll('ul > li');
        expect(items).toHaveLength(2);

        const strong = items[0].querySelector('strong');
        expect(strong).not.toBeNull();
        expect(strong.querySelector('code')?.textContent).toBe('updateCharacterData');
        expect(strong.querySelector('a')?.getAttribute('href')).toBe('https://luker.cups.moe/features/workbench');
        expect(strong.textContent).not.toContain('`');

        const wikiLink = items[1].querySelector('a');
        expect(wikiLink?.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
        expect(wikiLink?.textContent).toBe('Article');
        expect(items[1].textContent).toBe('See Article for details.');
    });
});

describe('resolveWhatsNewTheme', () => {
    test('prefers workbench pref over document dataset and media query', () => {
        document.documentElement.dataset.theme = 'light';
        localStorage.setItem('workbench.prefs.v1', JSON.stringify({ theme: 'dark' }));
        expect(resolveWhatsNewTheme()).toBe('dark');

        localStorage.setItem('workbench.prefs.v1', JSON.stringify({ theme: 'light' }));
        expect(resolveWhatsNewTheme()).toBe('light');

        localStorage.clear();
        expect(resolveWhatsNewTheme()).toBe('light');
    });
});

describe('showWhatsNewModal', () => {
    const releasePayload = {
        show: true,
        kind: 'release',
        currentVersion: '2.9.0-rc.4',
        previousVersion: '2.9.0-rc.2',
        currentRevision: 'a8bd55a9e',
        previousRevision: '111111111',
        branch: 'release',
        sections: [
            { version: null, date: null, unreleased: true, markdown: '### Fixes\n\n- Fixed session naming.' },
            { version: '2.9.0-rc.4', date: '2026-11-23', unreleased: false, markdown: '### Workbench\n\n- Added floating window.' },
            { version: '2.9.0-rc.3', date: '2026-11-21', unreleased: false, markdown: '### Docs\n\n- Added [Guide](/guide/getting-started).' },
        ],
        changelogUrl: 'https://luker.cups.moe/changelog',
        compareUrl: null,
    };

    test('renders Workbench-styled modal with multi-version sections and calls onAck once on Got it', async () => {
        const onAck = jest.fn(async () => {});
        const modalPromise = showWhatsNewModal(releasePayload, { onAck });

        const backdrop = document.querySelector('.lw-dialog-backdrop.lw-surface.wn-backdrop');
        expect(backdrop).not.toBeNull();
        expect(backdrop.querySelector('.lw-dialog-title')?.textContent).toBe('Updated to Luker v2.9.0-rc.4');
        expect(backdrop.querySelector('.wn-range-pill')?.textContent).toBe('v2.9.0-rc.2 → v2.9.0-rc.4');

        const versionCards = backdrop.querySelectorAll('.wn-version');
        expect(versionCards).toHaveLength(3);
        expect(versionCards[0].textContent).toContain('Unreleased');
        expect(versionCards[1].textContent).toContain('v2.9.0-rc.4');
        expect(versionCards[2].textContent).toContain('v2.9.0-rc.3');

        const fullLink = backdrop.querySelector('a.wn-changelog-link');
        expect(fullLink?.getAttribute('href')).toBe('https://luker.cups.moe/changelog');

        const gotItBtn = /** @type {HTMLButtonElement} */ (backdrop.querySelector('button.lw-btn.is-primary'));
        gotItBtn.click();
        await modalPromise;

        expect(document.querySelector('.wn-backdrop')).toBeNull();
        expect(onAck).toHaveBeenCalledTimes(1);
    });

    test('renders dev update title, revision range, and compare link', async () => {
        const devPayload = {
            show: true,
            kind: 'dev',
            currentVersion: '2.9.0-rc.4',
            previousVersion: '2.9.0-rc.4',
            currentRevision: 'a8bd55a9e',
            previousRevision: '9d17a9735',
            branch: 'release',
            sections: [],
            changelogUrl: 'https://luker.cups.moe/changelog',
            compareUrl: 'https://github.com/funnycups/Luker/compare/9d17a9735...a8bd55a9e',
        };
        const onAck = jest.fn(async () => {});
        const modalPromise = showWhatsNewModal(devPayload, { onAck });

        const backdrop = document.querySelector('.wn-backdrop');
        expect(backdrop.querySelector('.lw-dialog-title')?.textContent).toBe('Updated to Luker dev build a8bd55a9e');
        expect(backdrop.querySelector('.wn-range-pill')?.textContent).toBe('9d17a9735 → a8bd55a9e');
        expect(backdrop.querySelector('.wn-empty-note')?.textContent).toContain('dev build');
        expect(backdrop.querySelector('a.wn-compare-link')?.getAttribute('href')).toBe(devPayload.compareUrl);

        // Dismiss via Escape key
        backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await modalPromise;
        expect(onAck).toHaveBeenCalledTimes(1);
    });

    test('dismisses via close button and backdrop click, and surfaces ack errors via toastr', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const toastrError = jest.fn();
        window.toastr = { error: toastrError };

        const failingAck = jest.fn(async () => {
            throw new Error('network down');
        });
        const p1 = showWhatsNewModal({ ...releasePayload, sections: [] }, { onAck: failingAck });
        const closeBtn = /** @type {HTMLButtonElement} */ (document.querySelector('.wn-backdrop .lw-ibtn'));
        closeBtn.click();
        await p1;

        expect(failingAck).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalled();
        expect(toastrError).toHaveBeenCalled();

        const okAck = jest.fn(async () => {});
        const p2 = showWhatsNewModal({ ...releasePayload, sections: [] }, { onAck: okAck });
        const backdrop = document.querySelector('.wn-backdrop');
        backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await p2;
        expect(okAck).toHaveBeenCalledTimes(1);

        errorSpy.mockRestore();
    });

    test('traps Tab focus inside dialog and dismisses on document-level Escape even when focus is outside', async () => {
        const outsideBtn = document.createElement('button');
        outsideBtn.textContent = 'Outside';
        document.body.appendChild(outsideBtn);
        outsideBtn.focus();

        const onAck = jest.fn(async () => {});
        const modalPromise = showWhatsNewModal({ ...releasePayload, sections: [] }, { onAck });

        const dialog = document.querySelector('.wn-dialog');
        const closeBtn = /** @type {HTMLButtonElement} */ (dialog.querySelector('.lw-ibtn'));
        const gotItBtn = /** @type {HTMLButtonElement} */ (dialog.querySelector('button.lw-btn.is-primary'));

        // Tab from last focusable wraps to first focusable inside dialog.
        gotItBtn.focus();
        const tabForward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        document.dispatchEvent(tabForward);
        expect(tabForward.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(closeBtn);

        // Shift+Tab from first focusable wraps to last focusable inside dialog.
        const tabBackward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(tabBackward);
        expect(tabBackward.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(gotItBtn);

        // Escape dispatched on document while focus is outside still dismisses modal.
        outsideBtn.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await modalPromise;

        expect(document.querySelector('.wn-backdrop')).toBeNull();
        expect(onAck).toHaveBeenCalledTimes(1);
    });
});

describe('initWhatsNew coordination', () => {
    test('waits for announcements gate (even if it rejects), fetches whats-new, and posts ack on dismiss', async () => {
        let releaseGate;
        const gate = new Promise((_resolve, reject) => {
            releaseGate = () => reject(new Error('announcements failed'));
        });

        const calls = [];
        const fetchImpl = jest.fn(async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (url === '/api/users/whats-new') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        show: true,
                        kind: 'release',
                        currentVersion: '2.9.0-rc.4',
                        previousVersion: '2.9.0-rc.3',
                        currentRevision: 'a8bd55a9e',
                        previousRevision: '9d17a9735',
                        sections: [],
                        changelogUrl: 'https://luker.cups.moe/zh-CN/changelog',
                        compareUrl: null,
                    }),
                };
            }
            return { ok: true, status: 204, json: async () => null };
        });

        const runPromise = initWhatsNew({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' }),
            getLocale: () => 'zh-cn',
            waitForAnnouncements: () => gate,
            fetchImpl,
        });

        // Must not fetch before announcements gate settles
        await Promise.resolve();
        expect(calls).toHaveLength(0);

        releaseGate();
        // Wait for modal to mount
        for (let i = 0; i < 20 && !document.querySelector('.wn-backdrop'); i++) {
            await new Promise(r => setTimeout(r, 5));
        }
        expect(calls).toEqual([{ url: '/api/users/whats-new', body: { locale: 'zh-cn' } }]);
        expect(document.querySelector('.wn-backdrop')).not.toBeNull();

        /** @type {HTMLButtonElement} */ (document.querySelector('.wn-backdrop button.lw-btn.is-primary')).click();
        await runPromise;

        expect(calls).toEqual([
            { url: '/api/users/whats-new', body: { locale: 'zh-cn' } },
            { url: '/api/users/whats-new/ack', body: { version: '2.9.0-rc.4', revision: 'a8bd55a9e' } },
        ]);
    });
});
