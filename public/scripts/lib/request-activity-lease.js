// SPDX-License-Identifier: AGPL-3.0-or-later

import { acquireActivityLease, resolveRequestActivityLeaseOptions, withActivityLease } from '../activity-guard.js';

/**
 * Resolve activity lease options from a request options bag.
 * @param {object} [requestOptions]
 * @param {string} [defaultSource='core:custom-request']
 * @param {{ defaultLabel?: string }} [options]
 * @returns {object|null}
 */
export function resolveCustomRequestLeaseOptions(requestOptions, defaultSource = 'core:custom-request', options = {}) {
    const activity = requestOptions && typeof requestOptions === 'object' ? requestOptions.activity : undefined;
    return resolveRequestActivityLeaseOptions(activity, defaultSource, options);
}

/**
 * Run an async request callback under an optional activity lease.
 * @template T
 * @param {object|null} leaseOptions
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export function runWithRequestActivityLease(leaseOptions, fn) {
    return leaseOptions ? withActivityLease(leaseOptions, fn) : fn();
}

/**
 * Wrap an async generator factory so each stream consumption acquires and releases a fresh activity lease.
 * Leaving the returned factory un-invoked acquires no lease.
 * @template T
 * @param {object|null} leaseOptions
 * @param {() => AsyncGenerator<T>} createStream
 * @returns {() => AsyncGenerator<T>}
 */
export function wrapStreamFactoryWithActivityLease(leaseOptions, createStream) {
    if (!leaseOptions) {
        return createStream;
    }
    return async function* streamData() {
        const release = acquireActivityLease(leaseOptions);
        try {
            yield* createStream();
        } finally {
            release();
        }
    };
}

/**
 * Normalize positional or object arguments for generateRaw.
 * @param {IArguments | any[]} args
 * @returns {object}
 */
export function normalizeGenerateRawArgs(args) {
    if (args.length > 0 && typeof args[0] !== 'object') {
        const [
            prompt = '',
            api = null,
            instructOverride = false,
            quietToLoud = false,
            systemPrompt = '',
            responseLength = null,
            trimNames = true,
            prefill = '',
            jsonSchema = null,
            llmPresetName = '',
            apiPresetName = '',
            apiSettingsOverride = null,
            activity = true,
        ] = args;
        return {
            positional: true,
            params: {
                prompt,
                api,
                instructOverride,
                quietToLoud,
                systemPrompt,
                responseLength,
                trimNames,
                prefill,
                jsonSchema,
                llmPresetName,
                apiPresetName,
                apiSettingsOverride,
                activity,
            },
        };
    }
    const {
        prompt = '',
        api = null,
        instructOverride = false,
        quietToLoud = false,
        systemPrompt = '',
        responseLength = null,
        trimNames = true,
        prefill = '',
        jsonSchema = null,
        llmPresetName = '',
        apiPresetName = '',
        apiSettingsOverride = null,
        activity = true,
    } = args[0] || {};
    return {
        positional: false,
        params: {
            prompt,
            api,
            instructOverride,
            quietToLoud,
            systemPrompt,
            responseLength,
            trimNames,
            prefill,
            jsonSchema,
            llmPresetName,
            apiPresetName,
            apiSettingsOverride,
            activity,
        },
    };
}
