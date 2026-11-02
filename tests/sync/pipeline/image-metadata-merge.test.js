import { describe, test, expect } from '@jest/globals';
import { mergeImageMetadataDocuments } from '../../../src/sync/pipeline/image-metadata-merge.js';
import { serializeImageMetadataIndex } from '../../../src/image-metadata-index.js';

const doc = (images = {}, folders = []) => ({ version: 2, images, folders });
const img = (addedTimestamp, folderIds = []) => ({ addedTimestamp, folderIds });
const folder = (id, name, thumbnailFile = '') => ({ id, name, thumbnailFile });

describe('image-metadata.json merge', () => {
    test('two fresh installs union their images by path and keep the earlier added time', () => {
        const ours = doc({ 'backgrounds/__transparent.png': img(500), 'backgrounds/glade.png': img(700) });
        const theirs = doc({ 'backgrounds/__transparent.png': img(300), 'backgrounds/river.png': img(900) });
        expect(mergeImageMetadataDocuments(null, ours, theirs)).toEqual({
            conflicted: false,
            value: doc({ 'backgrounds/__transparent.png': img(300), 'backgrounds/glade.png': img(700), 'backgrounds/river.png': img(900) }),
        });
    });

    test('version 1 sides merge on their synced fields only', () => {
        const legacy = (hash, dominantColor, mtime, folderIds) => ({ hash, aspectRatio: 1, isAnimated: false, dominantColor, folderIds, addedTimestamp: 10, thumbnailResolution: 14400, mtime });
        const ours = { version: 1, images: { 'backgrounds/a.png': legacy('h1', '#111111', 1, ['f1']) }, folders: [folder('f1', 'Dawn')] };
        const theirs = { version: 1, images: { 'backgrounds/a.png': legacy('h2', '#222222', 2, []) }, folders: [folder('f1', 'Dawn')] };
        expect(mergeImageMetadataDocuments(null, ours, theirs)).toEqual({ conflicted: false, value: doc({ 'backgrounds/a.png': img(10, ['f1']) }, [folder('f1', 'Dawn')]) });
    });

    test('folders union by id, ours first, and a folder change on one side is taken', () => {
        const base = doc({}, [folder('f1', 'Dawn')]);
        const ours = doc({}, [folder('f1', 'Dawn'), folder('f2', 'Dusk')]);
        const theirs = doc({}, [folder('f3', 'Noon'), folder('f1', 'Dawn Skies', 'glade.png')]);
        expect(mergeImageMetadataDocuments(base, ours, theirs)).toEqual({
            conflicted: false,
            value: doc({}, [folder('f1', 'Dawn Skies', 'glade.png'), folder('f2', 'Dusk'), folder('f3', 'Noon')]),
        });
    });

    test('a folder both sides renamed differently is a conflict that keeps ours', () => {
        const base = doc({}, [folder('f1', 'Dawn')]);
        const merged = mergeImageMetadataDocuments(base, doc({}, [folder('f1', 'Dusk')]), doc({}, [folder('f1', 'Noon')]));
        expect(merged).toEqual({ conflicted: true, value: doc({}, [folder('f1', 'Dusk')]) });
    });

    test('an image moved on one side takes the move', () => {
        const folders = [folder('f1', 'Dawn'), folder('f2', 'Dusk')];
        const base = doc({ 'backgrounds/a.png': img(1, ['f1']) }, folders);
        const merged = mergeImageMetadataDocuments(base, doc({ 'backgrounds/a.png': img(1, ['f1']) }, folders), doc({ 'backgrounds/a.png': img(1, ['f2']) }, folders));
        expect(merged).toEqual({ conflicted: false, value: doc({ 'backgrounds/a.png': img(1, ['f2']) }, folders) });
    });

    test('an image both sides moved to different folders is a conflict that keeps ours', () => {
        const folders = [folder('f1', 'Dawn'), folder('f2', 'Dusk'), folder('f3', 'Noon')];
        const base = doc({ 'backgrounds/a.png': img(1, ['f1']) }, folders);
        const merged = mergeImageMetadataDocuments(base, doc({ 'backgrounds/a.png': img(1, ['f2']) }, folders), doc({ 'backgrounds/a.png': img(1, ['f3']) }, folders));
        expect(merged).toEqual({ conflicted: true, value: doc({ 'backgrounds/a.png': img(1, ['f2']) }, folders) });
    });

    test('an image new on one side counts as unassigned in base', () => {
        const folders = [folder('f1', 'Dawn')];
        const merged = mergeImageMetadataDocuments(doc({}, folders), doc({ 'backgrounds/a.png': img(5, ['f1']) }, folders), doc({ 'backgrounds/a.png': img(4) }, folders));
        expect(merged).toEqual({ conflicted: false, value: doc({ 'backgrounds/a.png': img(4, ['f1']) }, folders) });
    });

    test('a folder deleted on one side is removed with its assignments', () => {
        const base = doc({ 'backgrounds/a.png': img(1, ['f1']) }, [folder('f1', 'Dawn')]);
        const ours = doc({ 'backgrounds/a.png': img(1) }, []);
        const theirs = doc({ 'backgrounds/a.png': img(1, ['f1']), 'backgrounds/b.png': img(2, ['f1']) }, [folder('f1', 'Dawn')]);
        expect(mergeImageMetadataDocuments(base, ours, theirs)).toEqual({ conflicted: false, value: doc({ 'backgrounds/a.png': img(1), 'backgrounds/b.png': img(2) }, []) });
    });

    test('a folder deleted on one side and renamed on the other is a conflict', () => {
        const base = doc({}, [folder('f1', 'Dawn')]);
        expect(mergeImageMetadataDocuments(base, doc({}, []), doc({}, [folder('f1', 'Dusk')])).conflicted).toBe(true);
    });

    test('an image removed on one side is removed unless the other side reassigned it', () => {
        const folders = [folder('f1', 'Dawn')];
        const base = doc({ 'backgrounds/a.png': img(1), 'backgrounds/b.png': img(2) }, folders);
        const ours = doc({}, folders);
        const theirs = doc({ 'backgrounds/a.png': img(1), 'backgrounds/b.png': img(2, ['f1']) }, folders);
        expect(mergeImageMetadataDocuments(base, ours, theirs)).toEqual({ conflicted: true, value: doc({ 'backgrounds/b.png': img(2, ['f1']) }, folders) });
        expect(mergeImageMetadataDocuments(base, ours, doc(base.images, folders))).toEqual({ conflicted: false, value: doc({}, folders) });
    });

    test('an image removed on one side whose added time alone changed on the other is removed', () => {
        const base = doc({ 'backgrounds/a.png': img(5) });
        expect(mergeImageMetadataDocuments(base, doc({}), doc({ 'backgrounds/a.png': img(3) }))).toEqual({ conflicted: false, value: doc({}) });
        expect(mergeImageMetadataDocuments(base, doc({ 'backgrounds/a.png': img(3) }), doc({}))).toEqual({ conflicted: false, value: doc({}) });
    });

    test('a side that is not an object gives no merge', () => {
        expect(mergeImageMetadataDocuments(null, 'oops', doc())).toBeNull();
        expect(mergeImageMetadataDocuments(null, doc(), [1])).toBeNull();
    });

    test('the merged bytes do not depend on the key order of the sides', () => {
        const a = mergeImageMetadataDocuments(null, doc({ 'backgrounds/b.png': img(2), 'backgrounds/a.png': img(1) }), doc({ 'backgrounds/c.png': img(3) }));
        const b = mergeImageMetadataDocuments(null, doc({ 'backgrounds/a.png': img(1), 'backgrounds/b.png': img(2) }), doc({ 'backgrounds/c.png': img(3) }));
        expect(serializeImageMetadataIndex(a.value)).toBe(serializeImageMetadataIndex(b.value));
        expect(Object.keys(JSON.parse(serializeImageMetadataIndex(a.value)).images)).toEqual(['backgrounds/a.png', 'backgrounds/b.png', 'backgrounds/c.png']);
    });
});
