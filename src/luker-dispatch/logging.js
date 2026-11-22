// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';

const loggingContext = new AsyncLocalStorage();

export function withDispatchLogging(isPrivate, callback) {
    return loggingContext.run({ isPrivate }, callback);
}

export const dispatchLog = new Proxy({}, {
    get(_target, method) {
        const actual = globalThis.console[method];
        if (typeof actual !== 'function') return actual;
        return (...args) => {
            if (!loggingContext.getStore()?.isPrivate) {
                return Reflect.apply(actual, globalThis.console, args);
            }
        };
    },
});
