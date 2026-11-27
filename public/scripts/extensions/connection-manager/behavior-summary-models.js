// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary models for Connection Profile · Advanced
// (Plain-text Function Calling, Reliability/Throttling/Network/Auto-continue,
// Claude Prompt Caching, OpenRouter Gemini Prompt Caching). No DOM dependencies.

function defaultTranslate(text, key = null) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? ''), key) : String(text ?? '');
}

function clampPosInt(raw, fallback, { min = 1, max = Infinity } = {}) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    const rounded = Math.round(parsed);
    if (Number.isFinite(max)) {
        return Math.max(min, Math.min(max, rounded));
    }
    return Math.max(min, rounded);
}

function clampNonNegInt(raw, fallback = 0) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.floor(parsed);
}

function clampNonNegFloat(raw, fallback = 0) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function resolveCachingDepth(raw) {
    if (raw === '' || raw === null || raw === undefined) {
        return -1;
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) {
        return -1;
    }
    return numeric;
}

function resolvePostProcessingLabel(mode, translate) {
    switch (mode) {
        case '':
        case 'none':
            return translate('None', 'prompt_post_processing_none');
        case 'merge':
        case 'claude':
            return translate('Merge consecutive roles', 'prompt_post_processing_merge');
        case 'semi':
            return translate('Semi-strict (alternating roles)', 'prompt_post_processing_semi');
        case 'strict':
            return translate('Strict (user first, alternating roles)', 'prompt_post_processing_strict');
        case 'single':
            return translate('Single user message (no tools)', 'prompt_post_processing_single');
        default:
            return mode;
    }
}

/**
 * Card 1: Plain-text Function Calling summary.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildConnPlainTextFcSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;
    const hasProfile = Boolean(state.hasProfile);
    const profileMode = String(state.profileMode || '').trim().toLowerCase();

    if (hasProfile && profileMode !== 'cc') {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Scope'),
                tone: 'off',
                template: translate('Inactive for non-Chat-Completion profiles — ${plainText} only applies to Chat Completion connections.'),
                tokens: {
                    plainText: {
                        field: 'plainText',
                        text: translate('plain-text function calling'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: ['plainText', 'errorRetry', 'maxAttempts'],
        };
    }

    const plainText = Boolean(state.plainText);
    const errorRetry = Boolean(state.errorRetry);
    // Mirrors getPlainTextFunctionCallRetryConfig() in public/scripts/openai.js (minimum 1, no upper cap).
    const maxAttempts = clampPosInt(state.maxAttempts, 3, { min: 1 });

    if (!plainText) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Tool calls'),
                tone: 'off',
                template: translate('${plainText} — uses native provider tool calling without plain-text prompt injection.'),
                tokens: {
                    plainText: {
                        field: 'plainText',
                        text: translate('Plain-text function calling off'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: ['errorRetry', 'maxAttempts'],
        };
    }

    const toolCallsRow = {
        role: translate('Tool calls'),
        template: translate('${plainText} — converts tool calls into plain-text prompt syntax for models without native tool support.'),
        tokens: {
            plainText: {
                field: 'plainText',
                text: translate('Plain-text function calling on'),
                tone: 'active',
            },
        },
    };

    const retryRow = errorRetry
        ? {
            role: translate('Error retry'),
            template: translate('${errorRetry} up to ${maxAttempts} attempts when the model outputs a malformed plain-text tool call.'),
            tokens: {
                errorRetry: {
                    field: 'errorRetry',
                    text: translate('Retries automatically'),
                    tone: 'active',
                },
                maxAttempts: {
                    field: 'maxAttempts',
                    text: String(maxAttempts),
                    tone: 'active',
                },
            },
        }
        : {
            role: translate('Error retry'),
            tone: 'off',
            template: translate('${errorRetry} — malformed plain-text tool calls fail without retry.'),
            tokens: {
                errorRetry: {
                    field: 'errorRetry',
                    text: translate('Malformed-call retry off'),
                    tone: 'off',
                },
            },
        };

    return {
        tone: 'active',
        rows: [toolCallsRow, retryRow],
        warnings: [],
        dormantFields: errorRetry ? [] : ['maxAttempts'],
    };
}

/**
 * Card 2: Reliability, Throttling, Network & Auto-continue summary.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildConnReliabilitySummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;
    const hasProfile = Boolean(state.hasProfile);
    const profileMode = String(state.profileMode || '').trim().toLowerCase();

    if (!hasProfile || (profileMode !== 'cc' && profileMode !== 'tc')) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Profile scope'),
                tone: 'off',
                template: translate('No connection profile selected — RPM throttling, retries, status whitelist, timeout, network proxy, and auto-continue are disabled.'),
                tokens: {},
            }],
            warnings: [],
            dormantFields: [
                'rpmLimit',
                'maxRequestRetries',
                'retryStatusWhitelist',
                'requestTimeout',
                'networkProxy',
                'autoContinueOnTruncated',
                'autoContinueMaxAttempts',
            ],
        };
    }

    const isCc = profileMode === 'cc';
    const rpmLimit = clampNonNegInt(state.rpmLimit, 0);
    const maxRequestRetries = clampNonNegInt(state.maxRequestRetries, 0);
    const retryStatusWhitelist = String(state.retryStatusWhitelist ?? '').trim();
    const requestTimeout = clampNonNegFloat(state.requestTimeout, 0);
    const networkProxy = String(state.networkProxy ?? '').trim();
    const autoContinue = Boolean(state.autoContinueOnTruncated);
    const autoContinueMaxAttempts = clampPosInt(state.autoContinueMaxAttempts, 3, { min: 1 });

    const dormantFields = [];
    if (maxRequestRetries === 0) {
        dormantFields.push('retryStatusWhitelist');
    }
    if (!isCc) {
        dormantFields.push('networkProxy');
    }
    if (!autoContinue) {
        dormantFields.push('autoContinueMaxAttempts');
    }

    const rpmToken = {
        field: 'rpmLimit',
        text: rpmLimit > 0 ? String(rpmLimit) : translate('unlimited'),
        tone: rpmLimit > 0 ? 'active' : 'off',
    };

    const retriesToken = {
        field: 'maxRequestRetries',
        text: maxRequestRetries > 0 ? String(maxRequestRetries) : translate('No retries'),
        tone: maxRequestRetries > 0 ? 'active' : 'off',
    };

    const whitelistToken = maxRequestRetries === 0
        ? {
            field: 'retryStatusWhitelist',
            text: translate('retry whitelist'),
            tone: 'off',
        }
        : {
            field: 'retryStatusWhitelist',
            text: retryStatusWhitelist || translate('default 429 & 5xx'),
            tone: 'active',
        };

    let throttleTemplate;
    if (maxRequestRetries === 0) {
        throttleTemplate = rpmLimit > 0
            ? translate('Rate limit ${rpmLimit} req/min. ${maxRequestRetries} — ${retryStatusWhitelist} stays inactive.')
            : translate('Rate limit ${rpmLimit}. ${maxRequestRetries} — ${retryStatusWhitelist} stays inactive.');
    } else {
        throttleTemplate = rpmLimit > 0
            ? translate('Rate limit ${rpmLimit} req/min. Up to ${maxRequestRetries} retries for text and image generation on network errors or ${retryStatusWhitelist} — streaming responses are not retried once streaming begins.')
            : translate('Rate limit ${rpmLimit}. Up to ${maxRequestRetries} retries for text and image generation on network errors or ${retryStatusWhitelist} — streaming responses are not retried once streaming begins.');
    }

    const throttleRow = {
        role: translate('Throttle & retries'),
        template: throttleTemplate,
        tokens: {
            rpmLimit: rpmToken,
            maxRequestRetries: retriesToken,
            retryStatusWhitelist: whitelistToken,
        },
    };

    const hasTimeout = requestTimeout > 0;
    const timeoutToken = {
        field: 'requestTimeout',
        text: hasTimeout ? `${requestTimeout} s` : translate('disabled'),
        tone: hasTimeout ? 'active' : 'off',
    };

    let proxyToken;
    let networkTemplate;
    if (!isCc) {
        proxyToken = {
            field: 'networkProxy',
            text: translate('network proxy'),
            tone: 'off',
        };
        networkTemplate = hasTimeout
            ? translate('Timeout after ${requestTimeout} of stream silence or non-stream wait — ${networkProxy} applies to Chat Completion profiles only.')
            : translate('Request timeout ${requestTimeout} — ${networkProxy} applies to Chat Completion profiles only.');
    } else if (networkProxy) {
        proxyToken = {
            field: 'networkProxy',
            text: networkProxy,
            tone: 'active',
        };
        networkTemplate = hasTimeout
            ? translate('Timeout after ${requestTimeout} of stream silence or non-stream wait — chat requests proxy through ${networkProxy}.')
            : translate('Request timeout ${requestTimeout} — chat requests proxy through ${networkProxy}.');
    } else {
        proxyToken = {
            field: 'networkProxy',
            text: translate('global config.yaml proxy or direct'),
            tone: 'off',
        };
        networkTemplate = hasTimeout
            ? translate('Timeout after ${requestTimeout} of stream silence or non-stream wait — chat requests fall back to ${networkProxy}.')
            : translate('Request timeout ${requestTimeout} — chat requests fall back to ${networkProxy}.');
    }

    const networkRow = {
        role: translate('Timeout & proxy'),
        template: networkTemplate,
        tokens: {
            requestTimeout: timeoutToken,
            networkProxy: proxyToken,
        },
    };

    const autoContinueRow = autoContinue
        ? {
            role: translate('Auto-continue'),
            template: translate('${autoContinueOnTruncated} up to ${autoContinueMaxAttempts} attempts — main-chat only, triggers on output cap or safety cutoff and stops if a round adds no content.'),
            tokens: {
                autoContinueOnTruncated: {
                    field: 'autoContinueOnTruncated',
                    text: translate('Auto-continues on truncation'),
                    tone: 'active',
                },
                autoContinueMaxAttempts: {
                    field: 'autoContinueMaxAttempts',
                    text: String(autoContinueMaxAttempts),
                    tone: 'active',
                },
            },
        }
        : {
            role: translate('Auto-continue'),
            tone: 'off',
            template: translate('${autoContinueOnTruncated} — main-chat replies truncated by output cap or safety cutoff are not automatically continued.'),
            tokens: {
                autoContinueOnTruncated: {
                    field: 'autoContinueOnTruncated',
                    text: translate('Auto-continue off'),
                    tone: 'off',
                },
            },
        };

    return {
        tone: 'active',
        rows: [throttleRow, networkRow, autoContinueRow],
        warnings: [],
        dormantFields,
    };
}

/**
 * Card 3: Claude Prompt Caching summary (breakpoints, TTL, source scope, and
 * cross-panel post-processing conflict warnings).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildConnClaudeCacheSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;
    const hasProfile = Boolean(state.hasProfile);
    const profileMode = String(state.profileMode || '').trim().toLowerCase();

    if (hasProfile && profileMode !== 'cc') {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Scope'),
                tone: 'off',
                template: translate('Claude prompt caching is inactive for non-Chat-Completion profiles.'),
                tokens: {},
            }],
            warnings: [],
            dormantFields: ['enableSystemPromptCache', 'extendedTtl', 'cachingAtDepth'],
        };
    }

    const sysActive = Boolean(state.enableSystemPromptCache);
    const extendedTtl = Boolean(state.extendedTtl);
    const depth = resolveCachingDepth(state.cachingAtDepth);
    const historyActive = depth >= 0;
    const cachingActive = sysActive || historyActive;

    const source = String(state.source || '').trim().toLowerCase();
    const isClaudeSource = source === 'claude';
    const isOpenRouterSource = source === 'openrouter';

    const postProcessing = String(state.postProcessing || '').trim().toLowerCase();
    const onActivate = typeof state.onPostProcessingActivate === 'function'
        ? state.onPostProcessingActivate
        : null;
    const canActivate = Boolean(state.canActivatePostProcessing || onActivate);

    let postTone = 'active';
    if (cachingActive && isClaudeSource) {
        if (postProcessing === 'single') postTone = 'danger';
        else if (postProcessing === 'strict' || postProcessing === 'semi') postTone = 'warn';
    } else if (!postProcessing || postProcessing === 'none') {
        postTone = 'off';
    }

    const postProcessingToken = {
        field: canActivate ? 'postProcessing' : null,
        text: resolvePostProcessingLabel(postProcessing, translate),
        tone: postTone,
        ...(onActivate ? { onActivate } : {}),
    };

    let breakpointsRow;
    if (!cachingActive) {
        breakpointsRow = {
            role: translate('Breakpoints'),
            tone: 'off',
            template: translate('${enableSystemPromptCache} and ${cachingAtDepth} — no cache breakpoints sent (${extendedTtl} inactive).'),
            tokens: {
                enableSystemPromptCache: {
                    field: 'enableSystemPromptCache',
                    text: translate('System prompt cache off'),
                    tone: 'off',
                },
                cachingAtDepth: {
                    field: 'cachingAtDepth',
                    text: translate('history cache off'),
                    tone: 'off',
                },
                extendedTtl: {
                    field: 'extendedTtl',
                    text: translate('extended TTL'),
                    tone: 'off',
                },
            },
        };
    } else {
        let template;
        if (sysActive && historyActive) {
            template = extendedTtl
                ? translate('Caches ${enableSystemPromptCache} and message history at depth ${cachingAtDepth} with ${extendedTtl} TTL (writes 2x, reads 0.1x) — requires a stable prompt prefix.')
                : translate('Caches ${enableSystemPromptCache} and message history at depth ${cachingAtDepth} with ${extendedTtl} TTL (writes 1.25x, reads 0.1x) — requires a stable prompt prefix.');
        } else if (sysActive) {
            template = extendedTtl
                ? translate('Caches ${enableSystemPromptCache} only (${cachingAtDepth}) with ${extendedTtl} TTL (writes 2x, reads 0.1x) — requires a stable prompt prefix.')
                : translate('Caches ${enableSystemPromptCache} only (${cachingAtDepth}) with ${extendedTtl} TTL (writes 1.25x, reads 0.1x) — requires a stable prompt prefix.');
        } else {
            template = extendedTtl
                ? translate('Caches message history at depth ${cachingAtDepth} only (${enableSystemPromptCache}) with ${extendedTtl} TTL (writes 2x, reads 0.1x) — requires a stable prompt prefix.')
                : translate('Caches message history at depth ${cachingAtDepth} only (${enableSystemPromptCache}) with ${extendedTtl} TTL (writes 1.25x, reads 0.1x) — requires a stable prompt prefix.');
        }

        breakpointsRow = {
            role: translate('Breakpoints'),
            template,
            tokens: {
                enableSystemPromptCache: {
                    field: 'enableSystemPromptCache',
                    text: sysActive ? translate('system prompt') : translate('system prompt off'),
                    tone: sysActive ? 'active' : 'off',
                },
                cachingAtDepth: {
                    field: 'cachingAtDepth',
                    text: historyActive ? String(depth) : translate('history cache off'),
                    tone: historyActive ? 'active' : 'off',
                },
                extendedTtl: {
                    field: 'extendedTtl',
                    text: extendedTtl ? '1h' : '5m',
                    tone: 'active',
                },
            },
        };
    }

    let scopeRow;
    if (isOpenRouterSource) {
        scopeRow = {
            role: translate('Source scope'),
            template: translate('On OpenRouter, applies only to anthropic/claude* models — other providers ignore Claude cache markers.'),
            tokens: {},
        };
    } else if (isClaudeSource) {
        scopeRow = {
            role: translate('Prompt format'),
            template: translate('Prompt post-processing is ${postProcessing} — prefix stability is required for cache hits (avoid in-chat lorebook injections or random macros).'),
            tokens: {
                postProcessing: postProcessingToken,
            },
        };
    } else {
        scopeRow = {
            role: translate('Source scope'),
            template: translate('Applies to direct Claude API requests and OpenRouter anthropic/claude* routes.'),
            tokens: {},
        };
    }

    const warnings = [];
    if (isClaudeSource && cachingActive) {
        if (postProcessing === 'single') {
            warnings.push({
                severity: 'danger',
                template: translate('${postProcessing} collapses every turn into one user message — zero prefix reuse across requests (every request is a cache write with no read). Switch to None or Merge consecutive roles for caching to take effect.'),
                tokens: { postProcessing: postProcessingToken },
            });
        } else if (postProcessing === 'strict' || postProcessing === 'semi') {
            warnings.push({
                severity: 'warn',
                template: translate('${postProcessing} folds system messages after the first into a user turn — caching still works on the first user tail, but the dedicated system-prompt cache breakpoint is unavailable. None or Merge consecutive roles gives best coverage.'),
                tokens: { postProcessing: postProcessingToken },
            });
        }
    }

    let tone = 'active';
    if (warnings.some((w) => w.severity === 'danger')) {
        tone = 'danger';
    } else if (warnings.length > 0) {
        tone = 'warn';
    } else if (!cachingActive) {
        tone = 'dormant';
    }

    return {
        tone,
        rows: [breakpointsRow, scopeRow],
        warnings,
        dormantFields: cachingActive ? [] : ['extendedTtl'],
    };
}

/**
 * Card 4: OpenRouter Gemini Prompt Caching summary (history caching precedence,
 * uncached tail turns + current input, and unsupported-model error warning).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildConnGeminiCacheSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;
    const hasProfile = Boolean(state.hasProfile);
    const profileMode = String(state.profileMode || '').trim().toLowerCase();

    if (hasProfile && profileMode !== 'cc') {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Scope'),
                tone: 'off',
                template: translate('OpenRouter Gemini prompt caching is inactive for non-Chat-Completion profiles.'),
                tokens: {},
            }],
            warnings: [],
            dormantFields: ['enableSystemPromptCache', 'enableHistoryCache', 'keepRecentTurns'],
        };
    }

    const enableSystemPromptCache = Boolean(state.enableSystemPromptCache);
    const enableHistoryCache = Boolean(state.enableHistoryCache);
    const keepRecentTurns = clampPosInt(state.keepRecentTurns, 2, { min: 1 });

    if (enableHistoryCache) {
        const historyRow = {
            role: translate('History cache'),
            template: translate('${enableHistoryCache} supersedes ${enableSystemPromptCache} — caches system prompts and stable history while leaving the latest ${keepRecentTurns} turns plus current input uncached.'),
            tokens: {
                enableHistoryCache: {
                    field: 'enableHistoryCache',
                    text: translate('History caching on'),
                    tone: 'active',
                },
                enableSystemPromptCache: {
                    field: 'enableSystemPromptCache',
                    text: translate('system-only caching'),
                    tone: 'off',
                },
                keepRecentTurns: {
                    field: 'keepRecentTurns',
                    text: String(keepRecentTurns),
                    tone: 'active',
                },
            },
        };

        const lifecycleRow = {
            role: translate('Lifecycle'),
            template: translate('Applies only to OpenRouter google/gemini* routes — reuses a fixed prefix for up to 5 minutes before advancing (edits to earlier history rebuild the prefix).'),
            tokens: {},
        };

        const warnings = [{
            severity: 'warn',
            template: translate('Models without explicit caching support will error when ${enableHistoryCache} is enabled.'),
            tokens: {
                enableHistoryCache: {
                    field: 'enableHistoryCache',
                    text: translate('Cache stable chat history'),
                    tone: 'warn',
                },
            },
        }];

        return {
            tone: 'warn',
            rows: [historyRow, lifecycleRow],
            warnings,
            dormantFields: ['enableSystemPromptCache'],
        };
    }

    if (enableSystemPromptCache) {
        return {
            tone: 'active',
            rows: [
                {
                    role: translate('Cache scope'),
                    template: translate('Caches ${enableSystemPromptCache} only (${enableHistoryCache} — ${keepRecentTurns} is inactive).'),
                    tokens: {
                        enableSystemPromptCache: {
                            field: 'enableSystemPromptCache',
                            text: translate('system prompt'),
                            tone: 'active',
                        },
                        enableHistoryCache: {
                            field: 'enableHistoryCache',
                            text: translate('history caching off'),
                            tone: 'off',
                        },
                        keepRecentTurns: {
                            field: 'keepRecentTurns',
                            text: translate('recent-turn setting'),
                            tone: 'off',
                        },
                    },
                },
                {
                    role: translate('Scope'),
                    template: translate('Applies only when OpenRouter routes to a Gemini model that supports caching — requires a stable prefix.'),
                    tokens: {},
                },
            ],
            warnings: [],
            dormantFields: ['keepRecentTurns'],
        };
    }

    return {
        tone: 'dormant',
        rows: [{
            role: translate('Cache scope'),
            tone: 'off',
            template: translate('${enableSystemPromptCache} and ${enableHistoryCache} — no Gemini prompt cache markers are sent (${keepRecentTurns} inactive).'),
            tokens: {
                enableSystemPromptCache: {
                    field: 'enableSystemPromptCache',
                    text: translate('System prompt cache off'),
                    tone: 'off',
                },
                enableHistoryCache: {
                    field: 'enableHistoryCache',
                    text: translate('history caching off'),
                    tone: 'off',
                },
                keepRecentTurns: {
                    field: 'keepRecentTurns',
                    text: translate('recent-turn setting'),
                    tone: 'off',
                },
            },
        }],
        warnings: [],
        dormantFields: ['keepRecentTurns'],
    };
}
