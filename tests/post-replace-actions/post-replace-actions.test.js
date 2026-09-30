// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { jest } from '@jest/globals';

const mockConfirm = jest.fn(async () => null);
const mockGetWorldInfoNames = jest.fn(() => []);
const mockImportEmbeddedWorldInfo = jest.fn(async () => {});
const mockCharUpdatePrimaryWorld = jest.fn(async () => {});
const mockSelectCharacterById = jest.fn(async () => {});
const mockSetButtonClass = jest.fn();
const mockAccountStorageSet = jest.fn();
const mockDeleteWorldBook = jest.fn(async () => {});

const localCharacter = () => ({
    avatar: 'ash.png',
    name: 'Ash',
    data: { extensions: {} },
});

const mockContext = {
    characters: [localCharacter()],
    getWorldInfoNames: (...args) => mockGetWorldInfoNames(...args),
    importEmbeddedWorldInfo: (...args) => mockImportEmbeddedWorldInfo(...args),
    charUpdatePrimaryWorld: (...args) => mockCharUpdatePrimaryWorld(...args),
    selectCharacterById: (...args) => mockSelectCharacterById(...args),
    worldInfoEntry: { setButtonClass: (...args) => mockSetButtonClass(...args) },
    accountStorage: { setItem: (...args) => mockAccountStorageSet(...args) },
    deleteWorldBook: (...args) => mockDeleteWorldBook(...args),
};

jest.unstable_mockModule('/scripts/st-context.js', () => ({
    getContext: () => mockContext,
}));
jest.unstable_mockModule('/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce(
        (acc, part, index) => acc + part + (values[index] !== undefined ? String(values[index]) : ''),
        '',
    ),
}));
jest.unstable_mockModule('/scripts/popup.js', () => ({
    POPUP_RESULT: { CUSTOM1: 1001, CUSTOM2: 1002, CUSTOM3: 1003, CANCELLED: null },
    Popup: { show: { confirm: (...args) => mockConfirm(...args) } },
}));

const jqStub = { data: () => jqStub, show: () => jqStub, val: () => jqStub, trigger: () => jqStub };
globalThis.jQuery = () => jqStub;
globalThis.toastr = { error: () => {}, success: () => {}, warning: () => {}, info: () => {} };
globalThis.HTMLElement = globalThis.HTMLElement || class HTMLElement {};
globalThis.document = globalThis.document || { querySelectorAll: () => [] };

const {
    registerPostReplaceAction,
    listPostReplaceActions,
    computePostReplaceDetail,
    handlePostReplaceWorldBook,
    importEmbeddedBookForCharacter,
    rebindPreviousPrimaryBook,
} = await import('/scripts/character/post-replace-actions.js');

const makeAction = (id, overrides = {}) => ({
    id,
    label: () => `Label ${id}`,
    description: () => `Description ${id}`,
    isAvailable: () => false,
    run: jest.fn(async () => {}),
    ...overrides,
});

const embeddedCharacter = () => ({
    avatar: 'ash.png',
    name: 'Ash',
    data: {
        extensions: {},
        character_book: { name: 'new-book', entries: [{ content: 'x' }] },
    },
});

beforeEach(() => {
    mockConfirm.mockReset().mockResolvedValue(null);
    mockGetWorldInfoNames.mockReset().mockReturnValue([]);
    mockImportEmbeddedWorldInfo.mockReset().mockResolvedValue(undefined);
    mockCharUpdatePrimaryWorld.mockReset().mockResolvedValue(undefined);
    mockSelectCharacterById.mockReset().mockResolvedValue(undefined);
    mockSetButtonClass.mockReset();
    mockAccountStorageSet.mockReset();
    mockDeleteWorldBook.mockReset().mockResolvedValue(undefined);
    mockContext.characters = [localCharacter()];
});

test('core registers the world-book import and keep actions in order', () => {
    const ids = listPostReplaceActions().map(action => action.id);
    expect(ids).toEqual(expect.arrayContaining(['world-book-import', 'world-book-keep']));
    expect(ids.indexOf('world-book-import')).toBeLessThan(ids.indexOf('world-book-keep'));
});

test('registry rejects invalid descriptors', () => {
    expect(() => registerPostReplaceAction(null)).toThrow(/descriptor/);
    expect(() => registerPostReplaceAction({ id: 'incomplete' })).toThrow(/requires/);
    expect(() => registerPostReplaceAction(makeAction('bad.id'))).toThrow(/post-replace-actions/);
});

test('registry warns and replaces duplicate ids', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeAction('dup-action');
    const second = makeAction('dup-action');
    registerPostReplaceAction(first);
    registerPostReplaceAction(second);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('\'dup-action\''));
    const matches = listPostReplaceActions().filter(action => action.id === 'dup-action');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(second);
    warn.mockRestore();
});

test('computePostReplaceDetail reads the previous book and embedded-book state', () => {
    mockGetWorldInfoNames.mockReturnValue(['old-book']);
    const detail = computePostReplaceDetail(0, mockContext.characters[0], {
        avatar: 'ash.png',
        data: { extensions: { world: 'old-book' } },
    }, null);
    expect(detail.previousBookName).toBe('old-book');
    expect(detail.previousBookExists).toBe(true);
    expect(detail.hasNewEmbeddedBook).toBe(false);
    expect(detail.source).toBe('replace_update');

    const withEmbedded = computePostReplaceDetail(0, embeddedCharacter(), null, { bookName: 'old-book' });
    expect(withEmbedded.previousBookName).toBe('old-book');
    expect(withEmbedded.previousBookExists).toBe(true);
    expect(withEmbedded.hasNewEmbeddedBook).toBe(true);
});

test('no popup when no action is available', async () => {
    const result = await handlePostReplaceWorldBook({
        characterId: 0,
        previousCharacter: null,
        newCharacter: localCharacter(),
        previousLorebookSnapshot: null,
    });
    expect(result).toEqual({ actionId: null });
    expect(mockConfirm).not.toHaveBeenCalled();
});

test('import action is offered for a new embedded book and runs the import helper', async () => {
    mockConfirm.mockResolvedValue(1001); // CUSTOM1 = world-book-import
    mockContext.characters = [embeddedCharacter()];
    const result = await handlePostReplaceWorldBook({
        characterId: 0,
        previousCharacter: null,
        newCharacter: embeddedCharacter(),
        previousLorebookSnapshot: null,
    });
    expect(result).toEqual({ actionId: 'world-book-import' });
    const options = mockConfirm.mock.calls[0][2];
    expect(options.okButton).toBe(false);
    expect(options.cancelButton).toBe('Cancel');
    expect(options.customButtons.map(button => button.text)).toEqual(['Import new book']);
    expect(options.defaultResult).toBe(1001);
    expect(mockImportEmbeddedWorldInfo).toHaveBeenCalledWith(true);
    expect(mockCharUpdatePrimaryWorld).toHaveBeenCalledWith('new-book');
});

test('keep action re-binds the previous book when it still exists', async () => {
    mockGetWorldInfoNames.mockReturnValue(['old-book']);
    mockConfirm.mockResolvedValue(1001); // only available action = keep
    const result = await handlePostReplaceWorldBook({
        characterId: 0,
        previousCharacter: { avatar: 'ash.png', data: { extensions: { world: 'old-book' } } },
        newCharacter: localCharacter(),
        previousLorebookSnapshot: null,
    });
    expect(result).toEqual({ actionId: 'world-book-keep' });
    expect(mockConfirm.mock.calls[0][2].customButtons.map(button => button.text)).toEqual(['Keep old book']);
    expect(mockCharUpdatePrimaryWorld).toHaveBeenCalledWith('old-book');
});

test('cancel runs nothing', async () => {
    mockConfirm.mockResolvedValue(null);
    const result = await handlePostReplaceWorldBook({
        characterId: 0,
        previousCharacter: null,
        newCharacter: embeddedCharacter(),
        previousLorebookSnapshot: null,
    });
    expect(result).toEqual({ actionId: null });
    expect(mockImportEmbeddedWorldInfo).not.toHaveBeenCalled();
});

test('custom actions append in registration order and map to their own results', async () => {
    mockGetWorldInfoNames.mockReturnValue(['old-book']);
    const extra = makeAction('test-extra', { isAvailable: () => true });
    registerPostReplaceAction(extra);
    try {
        mockConfirm.mockResolvedValue(1002); // CUSTOM2 = test-extra (keep is CUSTOM1)
        const result = await handlePostReplaceWorldBook({
            characterId: 0,
            previousCharacter: { avatar: 'ash.png', data: { extensions: { world: 'old-book' } } },
            newCharacter: localCharacter(),
            previousLorebookSnapshot: null,
        });
        expect(result).toEqual({ actionId: 'test-extra' });
        expect(extra.run).toHaveBeenCalledTimes(1);
        expect(extra.run.mock.calls[0][0].characterId).toBe(0);
        expect(mockConfirm.mock.calls[0][2].customButtons.map(button => button.text))
            .toEqual(['Keep old book', 'Label test-extra']);
    } finally {
        registerPostReplaceAction(makeAction('test-extra', { isAvailable: () => false }));
    }
});

test('a throwing availability check is skipped and does not block other actions', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let shouldThrow = true;
    registerPostReplaceAction(makeAction('test-throwing-availability', {
        isAvailable: () => { if (shouldThrow) throw new Error('boom'); return false; },
    }));
    mockConfirm.mockResolvedValue(1001);
    try {
        const result = await handlePostReplaceWorldBook({
            characterId: 0,
            previousCharacter: null,
            newCharacter: embeddedCharacter(),
            previousLorebookSnapshot: null,
        });
        expect(result).toEqual({ actionId: 'world-book-import' });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('test-throwing-availability'), expect.any(Error));
    } finally {
        shouldThrow = false;
        warn.mockRestore();
    }
});

test('a throwing run is isolated and surfaces an error toast', async () => {
    const errorToast = jest.fn();
    const originalToastError = globalThis.toastr.error;
    globalThis.toastr.error = (...args) => errorToast(...args);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    registerPostReplaceAction(makeAction('test-failing-run', {
        isAvailable: () => true,
        run: jest.fn(async () => { throw new Error('run failed'); }),
    }));
    try {
        mockConfirm.mockResolvedValue(1001);
        const result = await handlePostReplaceWorldBook({
            characterId: 0,
            previousCharacter: null,
            newCharacter: localCharacter(),
            previousLorebookSnapshot: null,
        });
        expect(result).toEqual({ actionId: 'test-failing-run' });
        expect(errorToast).toHaveBeenCalledWith(expect.stringContaining('run failed'));
    } finally {
        registerPostReplaceAction(makeAction('test-failing-run', { isAvailable: () => false }));
        globalThis.toastr.error = originalToastError;
        warn.mockRestore();
    }
});

test('a throwing popup never breaks the replace flow', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockConfirm.mockRejectedValueOnce(new Error('popup exploded'));
    const result = await handlePostReplaceWorldBook({
        characterId: 0,
        previousCharacter: null,
        newCharacter: embeddedCharacter(),
        previousLorebookSnapshot: null,
    });
    expect(result).toEqual({ actionId: null });
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
});

test('more than nine available actions are truncated with a warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let enabled = true;
    for (let index = 0; index < 10; index++) {
        registerPostReplaceAction(makeAction(`test-many-${index}`, { isAvailable: () => enabled }));
    }
    mockConfirm.mockResolvedValue(null);
    try {
        await handlePostReplaceWorldBook({
            characterId: 0,
            previousCharacter: null,
            newCharacter: embeddedCharacter(),
            previousLorebookSnapshot: null,
        });
        expect(mockConfirm.mock.calls[0][2].customButtons).toHaveLength(9);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncating'));
    } finally {
        enabled = false;
        warn.mockRestore();
    }
});

test('the legacy embedded-world popup is suppressed and an open one is cancelled', async () => {
    const cancelClick = jest.fn();
    const cancelButton = new globalThis.HTMLElement();
    cancelButton.click = cancelClick;
    const fakeDialog = {
        querySelector: (selector) => {
            if (selector === '.popup-body, .popup-content') {
                return { textContent: 'This character has an embedded World/Lorebook.' };
            }
            if (selector === '.popup-button-cancel') {
                return cancelButton;
            }
            return null;
        },
    };
    const originalQuerySelectorAll = globalThis.document.querySelectorAll;
    globalThis.document.querySelectorAll = () => [fakeDialog];
    try {
        await handlePostReplaceWorldBook({
            characterId: 0,
            previousCharacter: null,
            newCharacter: localCharacter(),
            previousLorebookSnapshot: null,
        });
        expect(mockAccountStorageSet).toHaveBeenCalledWith('AlertWI_ash.png', 'true');
        expect(cancelClick).toHaveBeenCalled();
    } finally {
        globalThis.document.querySelectorAll = originalQuerySelectorAll;
    }
});

test('importEmbeddedBookForCharacter throws for a missing character', async () => {
    await expect(importEmbeddedBookForCharacter(99)).rejects.toThrow(/character not found/);
});

test('rebindPreviousPrimaryBook writes the binding through the context', async () => {
    await rebindPreviousPrimaryBook(0, 'old-book');
    expect(mockCharUpdatePrimaryWorld).toHaveBeenCalledWith('old-book');
});
