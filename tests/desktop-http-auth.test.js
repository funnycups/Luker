import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    HttpAuthStore,
    createHttpAuthController,
    httpAuthKey,
} from '../desktop-app/http-auth.js';

function tempStorePath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-http-auth-'));
    return path.join(dir, 'http-auth.json');
}

function fakeStore(entries = []) {
    const data = new Map(entries);
    return {
        data,
        load: jest.fn((host, port, realm) => data.get(httpAuthKey(host, port, realm)) ?? null),
        save: jest.fn((host, port, realm, credentials) => {
            data.set(httpAuthKey(host, port, realm), credentials);
        }),
        clear: jest.fn((host, port, realm) => {
            data.delete(httpAuthKey(host, port, realm));
        }),
    };
}

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('desktop HTTP authentication store', () => {
    it('round-trips credentials per endpoint and realm', () => {
        const store = new HttpAuthStore(tempStorePath());
        expect(store.load('example.com', 443, 'Luker')).toBeNull();

        store.save('example.com', 443, 'Luker', { username: 'user', password: 'secret' });

        expect(store.load('Example.COM', 443, 'Luker')).toEqual({ username: 'user', password: 'secret' });
        expect(store.load('example.com', 443, 'Other')).toBeNull();

        store.clear('example.com', 443, 'Luker');
        expect(store.load('example.com', 443, 'Luker')).toBeNull();
    });

    it('rejects a corrupted store instead of discarding credentials', () => {
        const filePath = tempStorePath();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'not json');

        expect(() => new HttpAuthStore(filePath).load('example.com', 443, 'Luker')).toThrow();
    });
});

describe('desktop HTTP authentication controller', () => {
    it('uses stored credentials without prompting', () => {
        const store = fakeStore([
            [httpAuthKey('example.com', 443, 'Luker'), { username: 'user', password: 'secret' }],
        ]);
        const prompt = jest.fn();
        const controller = createHttpAuthController({ store, prompt });
        const callback = jest.fn();

        controller.handle({ host: 'example.com', port: 443, realm: 'Luker' }, callback);

        expect(prompt).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith('user', 'secret');
    });

    it('clears rejected credentials, prefills the dialog and saves the correction', async () => {
        const key = httpAuthKey('example.com', 443, 'Luker');
        const store = fakeStore([[key, { username: 'user', password: 'wrong' }]]);
        const prompt = jest.fn(async () => ({ username: 'user', password: 'right' }));
        const controller = createHttpAuthController({ store, prompt });
        const first = jest.fn();

        controller.handle({ host: 'example.com', port: 443, realm: 'Luker' }, first);
        expect(first).toHaveBeenCalledWith('user', 'wrong');

        const second = jest.fn();
        controller.handle({ host: 'example.com', port: 443, realm: 'Luker' }, second);
        await flush();

        expect(store.clear).toHaveBeenCalledWith('example.com', 443, 'Luker');
        expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
            host: 'example.com',
            port: 443,
            realm: 'Luker',
            prefill: { username: 'user', password: 'wrong' },
        }));
        expect(second).toHaveBeenCalledWith('user', 'right');
        expect(store.save).toHaveBeenCalledWith(
            'example.com',
            443,
            'Luker',
            { username: 'user', password: 'right' },
        );
    });

    it('cancels the challenge when the dialog is dismissed', async () => {
        const store = fakeStore();
        const prompt = jest.fn(async () => null);
        const controller = createHttpAuthController({ store, prompt });
        const callback = jest.fn();

        controller.handle({ host: 'example.com', port: 443, realm: 'Luker' }, callback);
        await flush();

        expect(prompt).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith();
        expect(store.save).not.toHaveBeenCalled();
    });

    it('answers queued challenges for the same endpoint with the submitted credentials', async () => {
        const store = fakeStore();
        let resolvePrompt = null;
        const prompt = jest.fn(() => new Promise((resolve) => {
            resolvePrompt = resolve;
        }));
        const controller = createHttpAuthController({ store, prompt });
        const first = jest.fn();
        const second = jest.fn();

        controller.handle({ host: 'example.com', port: 443, realm: 'Luker' }, first);
        controller.handle({ host: 'example.com', port: 443, realm: 'Luker' }, second);
        await flush();
        expect(prompt).toHaveBeenCalledTimes(1);

        resolvePrompt({ username: 'user', password: 'secret' });
        await flush();

        expect(first).toHaveBeenCalledWith('user', 'secret');
        expect(second).toHaveBeenCalledWith('user', 'secret');
    });

    it('reuses stored credentials after the finished page resets the attempts', () => {
        const store = fakeStore([
            [httpAuthKey('example.com', 443, 'Luker'), { username: 'user', password: 'secret' }],
        ]);
        const prompt = jest.fn();
        const controller = createHttpAuthController({ store, prompt });

        controller.handle({ host: 'example.com', port: 443, realm: 'Luker' }, jest.fn());
        controller.resetAttempts();
        const callback = jest.fn();
        controller.handle({ host: 'example.com', port: 443, realm: 'Luker' }, callback);

        expect(prompt).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith('user', 'secret');
        expect(store.clear).not.toHaveBeenCalled();
    });
});
