// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary models for Vector Storage (Shared Retrieval &
// Rerank, World Info, File Vectorization, Chat Vectorization).
// All runtime checks mirror public/scripts/extensions/vectors/index.js and
// public/scripts/world-info.js. No DOM dependencies.

const SHARED_FIELDS = Object.freeze([
    'embeddingProfileId',
    'query',
    'scoreThreshold',
    'forceChunkDelimiter',
    'includeWi',
    'rerankEnabled',
    'rerankProfileId',
]);

const WORLD_INFO_SUBFIELDS = Object.freeze([
    'enabledForAll',
    'maxEntries',
]);

const FILE_SUBFIELDS = Object.freeze([
    'onlyCustomBoundary',
    'translateFiles',
    'sizeThreshold',
    'chunkSize',
    'overlapPercent',
    'chunkCount',
    'sizeThresholdDb',
    'chunkSizeDb',
    'overlapPercentDb',
    'chunkCountDb',
    'fileTemplateDb',
    'filePositionDb',
    'fileDepthDb',
    'fileDepthRoleDb',
]);

const CHAT_SUBFIELDS = Object.freeze([
    'keepHidden',
    'template',
    'position',
    'depth',
    'messageChunkSize',
    'protect',
    'insert',
    'summarize',
    'summarizeSent',
    'summarySource',
    'summaryPrompt',
    'summaryRetries',
    'summaryThreshold',
]);

const SUMMARY_SUBFIELDS = Object.freeze([
    'summarizeSent',
    'summarySource',
    'summaryPrompt',
    'summaryRetries',
    'summaryThreshold',
]);

function defaultTranslate(text, key = null) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? ''), key) : String(text ?? '');
}

function clampMinInt(raw, min, fallback) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, parsed);
}

function clampRangeInt(raw, min, max, fallback) {
    return Math.min(max, clampMinInt(raw, min, fallback));
}

function clampFloat(raw, min, max, fallback) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    const clamped = Math.max(min, Math.min(max, parsed));
    return Math.round(clamped * 10000) / 10000;
}

function resolvePromptPosition(raw, fallback = 0) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const num = isBlank ? NaN : Number(raw);
    if (num === 0 || num === 1 || num === 2) {
        return num;
    }
    return fallback;
}

function resolvePositionLabel(pos, translate) {
    switch (pos) {
        case 2:
            return translate('Before Main Prompt / Story String');
        case 1:
            return translate('In-chat @ Depth');
        case 0:
        default:
            return translate('After Main Prompt / Story String');
    }
}

function resolveRoleLabel(rawRole, translate) {
    const isBlank = rawRole === '' || rawRole === null || rawRole === undefined
        || (typeof rawRole === 'string' && rawRole.trim() === '');
    const num = isBlank ? 0 : Number(rawRole);
    switch (num) {
        case 1:
            return translate('User');
        case 2:
            return translate('Assistant');
        case 0:
        default:
            return translate('System');
    }
}

function resolveSummarySourceLabel(rawSource, translate) {
    const src = String(rawSource || 'main').trim().toLowerCase();
    if (src === 'webllm') {
        return translate('WebLLM Extension');
    }
    if (src === 'main' || !src) {
        return translate('Main API');
    }
    return String(rawSource);
}

function resolveCardTone(warnings) {
    if (warnings.some((w) => w.severity === 'danger')) {
        return 'danger';
    }
    if (warnings.length > 0) {
        return 'warn';
    }
    return 'active';
}

/**
 * Card 1: Shared Retrieval & Rerank summary.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildVectorsSharedSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;

    const enabledWorldInfo = Boolean(state.enabledWorldInfo);
    const enabledFiles = Boolean(state.enabledFiles);
    const enabledChats = Boolean(state.enabledChats);

    if (!enabledWorldInfo && !enabledFiles && !enabledChats) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Status'),
                tone: 'off',
                template: translate('All vector sources are off — enable ${enabledWorldInfo}, ${enabledFiles}, or ${enabledChats} below to activate shared retrieval and reranking.'),
                tokens: {
                    enabledWorldInfo: {
                        field: 'enabledWorldInfo',
                        text: translate('Enable for World Info'),
                        tone: 'off',
                    },
                    enabledFiles: {
                        field: 'enabledFiles',
                        text: translate('Enable for files'),
                        tone: 'off',
                    },
                    enabledChats: {
                        field: 'enabledChats',
                        text: translate('Enabled for chat messages'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [...SHARED_FIELDS],
        };
    }

    const embeddingProfileId = String(state.embeddingProfileId || '').trim();
    const embeddingProfileLabel = String(state.embeddingProfileLabel || '').trim();
    const query = clampRangeInt(state.query, 1, 99, 2);
    const scoreThreshold = clampFloat(state.scoreThreshold, 0, 1, 0.25);
    const includeWi = Boolean(state.includeWi);
    const rerankEnabled = Boolean(state.rerankEnabled);
    const rerankProfileId = String(state.rerankProfileId || '').trim();
    const rerankProfileLabel = String(state.rerankProfileLabel || '').trim();

    const hasScanSources = enabledFiles || enabledChats;
    const onlyWorldInfoActive = enabledWorldInfo && !hasScanSources;

    const retrievalRow = {
        role: translate('Retrieval'),
        template: translate('Embeds with ${embeddingProfileId}, matching the last ${query} messages at score >= ${scoreThreshold}.'),
        tokens: {
            embeddingProfileId: {
                field: 'embeddingProfileId',
                text: embeddingProfileId
                    ? (embeddingProfileLabel || embeddingProfileId)
                    : translate('none selected'),
                tone: embeddingProfileId ? 'active' : 'danger',
            },
            query: {
                field: 'query',
                text: String(query),
                tone: 'active',
            },
            scoreThreshold: {
                field: 'scoreThreshold',
                text: String(scoreThreshold),
                tone: 'active',
            },
        },
    };

    let rerankRow;
    if (rerankEnabled && rerankProfileId) {
        rerankRow = {
            role: translate('Rerank'),
            template: translate('${rerankEnabled} via ${rerankProfileId} — fetches max(4x, 20) candidates then reranks to top results.'),
            tokens: {
                rerankEnabled: {
                    field: 'rerankEnabled',
                    text: translate('Enable Rerank'),
                    tone: 'active',
                },
                rerankProfileId: {
                    field: 'rerankProfileId',
                    text: rerankProfileLabel || rerankProfileId,
                    tone: 'active',
                },
            },
        };
    } else if (rerankEnabled) {
        rerankRow = {
            role: translate('Rerank'),
            tone: 'warn',
            template: translate('${rerankEnabled} without ${rerankProfileId} — fetches max(4x, 20) candidates then skips rerank.'),
            tokens: {
                rerankEnabled: {
                    field: 'rerankEnabled',
                    text: translate('Enable Rerank'),
                    tone: 'warn',
                },
                rerankProfileId: {
                    field: 'rerankProfileId',
                    text: translate('none selected'),
                    tone: 'warn',
                },
            },
        };
    } else {
        rerankRow = {
            role: translate('Rerank'),
            tone: 'off',
            template: translate('${rerankEnabled} — uses raw embedding similarity scores directly.'),
            tokens: {
                rerankEnabled: {
                    field: 'rerankEnabled',
                    text: translate('Rerank off'),
                    tone: 'off',
                },
            },
        };
    }

    let wiScanRow;
    if (onlyWorldInfoActive) {
        wiScanRow = {
            role: translate('WI scan'),
            tone: 'off',
            template: translate('${includeWi} is dormant while only World Info is enabled — only Chat and Data Bank injections are scanned.'),
            tokens: {
                includeWi: {
                    field: 'includeWi',
                    text: translate('Include in World Info Scanning'),
                    tone: includeWi ? 'warn' : 'off',
                },
            },
        };
    } else if (includeWi) {
        wiScanRow = {
            role: translate('WI scan'),
            template: translate('${includeWi} — Chat and Data Bank injections enter World Info keyword scanning.'),
            tokens: {
                includeWi: {
                    field: 'includeWi',
                    text: translate('Include in World Info Scanning'),
                    tone: 'active',
                },
            },
        };
    } else {
        wiScanRow = {
            role: translate('WI scan'),
            tone: 'off',
            template: translate('${includeWi} — Chat and Data Bank injections bypass World Info keyword scanning.'),
            tokens: {
                includeWi: {
                    field: 'includeWi',
                    text: translate('WI scanning off'),
                    tone: 'off',
                },
            },
        };
    }

    const warnings = [];
    if (!embeddingProfileId) {
        warnings.push({
            severity: 'danger',
            template: translate('No ${embeddingProfileId} is selected — vectorization and similarity queries will fail until an embedding profile is chosen.'),
            tokens: {
                embeddingProfileId: {
                    field: 'embeddingProfileId',
                    text: translate('Embedding Profile'),
                    tone: 'danger',
                },
            },
        });
    }
    if (rerankEnabled && !rerankProfileId) {
        warnings.push({
            severity: 'warn',
            template: translate('${rerankEnabled} is on with no ${rerankProfileId} selected — queries still over-fetch up to max(4x, 20) candidates, then skip reranking and keep vector order.'),
            tokens: {
                rerankEnabled: {
                    field: 'rerankEnabled',
                    text: translate('Enable Rerank'),
                    tone: 'warn',
                },
                rerankProfileId: {
                    field: 'rerankProfileId',
                    text: translate('Rerank Profile'),
                    tone: 'warn',
                },
            },
        });
    }
    if (includeWi && onlyWorldInfoActive) {
        warnings.push({
            severity: 'warn',
            template: translate('${includeWi} has no effect when only World Info is enabled — it only passes Chat and Data Bank injections into World Info keyword scanning.'),
            tokens: {
                includeWi: {
                    field: 'includeWi',
                    text: translate('Include in World Info Scanning'),
                    tone: 'warn',
                },
            },
        });
    }

    const dormantFields = [];
    if (!rerankEnabled) {
        dormantFields.push('rerankProfileId');
    }
    if (onlyWorldInfoActive) {
        dormantFields.push('includeWi', 'forceChunkDelimiter');
    }

    return {
        tone: resolveCardTone(warnings),
        rows: [retrievalRow, rerankRow, wiScanRow],
        warnings,
        dormantFields,
    };
}

/**
 * Card 2: World Info vectorization summary.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildVectorsWorldInfoSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;

    if (!state.enabledWorldInfo) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Status'),
                tone: 'off',
                template: translate('${enabledWorldInfo} is off — World Info entries activate only by keywords or constant state.'),
                tokens: {
                    enabledWorldInfo: {
                        field: 'enabledWorldInfo',
                        text: translate('Enable for World Info'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [...WORLD_INFO_SUBFIELDS],
        };
    }

    const enabledForAll = Boolean(state.enabledForAll);
    const maxEntries = clampRangeInt(state.maxEntries, 1, 9999, 5);

    return {
        tone: 'active',
        rows: [{
            role: translate('Scope'),
            template: translate('Indexes ${enabledForAll} (skipping disabled or empty entries) and force-activates up to ${maxEntries} entries.'),
            tokens: {
                enabledForAll: {
                    field: 'enabledForAll',
                    text: enabledForAll
                        ? translate('all enabled entries')
                        : translate('🔗 vectorized entries only'),
                    tone: 'active',
                },
                maxEntries: {
                    field: 'maxEntries',
                    text: String(maxEntries),
                    tone: 'active',
                },
            },
        }],
        warnings: [],
        dormantFields: [],
    };
}

/**
 * Card 3: File vectorization summary (Message attachments + Data Bank).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildVectorsFilesSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;

    if (!state.enabledFiles) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Status'),
                tone: 'off',
                template: translate('${enabledFiles} is off — message attachments remain inline and Data Bank files are not retrieved.'),
                tokens: {
                    enabledFiles: {
                        field: 'enabledFiles',
                        text: translate('Enable for files'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [...FILE_SUBFIELDS],
        };
    }

    const onlyCustomBoundary = Boolean(state.onlyCustomBoundary);
    const forceChunkDelimiter = String(state.forceChunkDelimiter ?? '');
    const translateFiles = Boolean(state.translateFiles);
    const translationAvailable = state.translationAvailable !== undefined
        ? Boolean(state.translationAvailable)
        : true;

    const sizeThreshold = clampMinInt(state.sizeThreshold, 0, 10);
    const chunkSize = clampMinInt(state.chunkSize, 1, 5000);
    const overlapPercent = clampRangeInt(state.overlapPercent, 0, 99, 0);
    const chunkCount = clampMinInt(state.chunkCount, 1, 2);

    const sizeThresholdDb = clampMinInt(state.sizeThresholdDb, 0, 5);
    const chunkSizeDb = clampMinInt(state.chunkSizeDb, 1, 2500);
    const overlapPercentDb = clampRangeInt(state.overlapPercentDb, 0, 99, 0);
    const chunkCountDb = clampMinInt(state.chunkCountDb, 1, 5);

    const fileTemplateDb = state.fileTemplateDb === undefined
        ? 'Related information:\n{{text}}'
        : String(state.fileTemplateDb ?? '');
    const hasTemplateTextMacro = fileTemplateDb.includes('{{text}}');
    const filePositionDb = resolvePromptPosition(state.filePositionDb, 0);
    const isInChat = filePositionDb === 1;
    const fileDepthDb = clampMinInt(state.fileDepthDb, 0, 4);
    const fileDepthRoleDb = resolveRoleLabel(state.fileDepthRoleDb, translate);

    const attachmentsRow = {
        role: translate('Message attachments'),
        template: translate('Attachments >= ${sizeThreshold} KB split into ${chunkSize} char chunks (${overlapPercent}% overlap) and prepend top ${chunkCount} chunks.'),
        tokens: {
            sizeThreshold: { field: 'sizeThreshold', text: String(sizeThreshold), tone: 'active' },
            chunkSize: { field: 'chunkSize', text: String(chunkSize), tone: 'active' },
            overlapPercent: { field: 'overlapPercent', text: String(overlapPercent), tone: 'active' },
            chunkCount: { field: 'chunkCount', text: String(chunkCount), tone: 'active' },
        },
    };

    const dataBankTokens = {
        sizeThresholdDb: { field: 'sizeThresholdDb', text: String(sizeThresholdDb), tone: 'active' },
        chunkSizeDb: { field: 'chunkSizeDb', text: String(chunkSizeDb), tone: 'active' },
        overlapPercentDb: { field: 'overlapPercentDb', text: String(overlapPercentDb), tone: 'active' },
        chunkCountDb: { field: 'chunkCountDb', text: String(chunkCountDb), tone: 'active' },
        filePositionDb: { field: 'filePositionDb', text: resolvePositionLabel(filePositionDb, translate), tone: 'active' },
        fileTemplateDb: {
            field: 'fileTemplateDb',
            text: translate('Injection Template'),
            tone: hasTemplateTextMacro ? 'active' : 'danger',
        },
    };
    if (isInChat) {
        dataBankTokens.fileDepthDb = { field: 'fileDepthDb', text: String(fileDepthDb), tone: 'active' };
        dataBankTokens.fileDepthRoleDb = { field: 'fileDepthRoleDb', text: fileDepthRoleDb, tone: 'active' };
    }

    const dataBankRow = {
        role: translate('Data Bank files'),
        template: isInChat
            ? translate('Files > ${sizeThresholdDb} KB split into ${chunkSizeDb} char chunks (${overlapPercentDb}% overlap), injecting top ${chunkCountDb} at ${filePositionDb} depth ${fileDepthDb} as ${fileDepthRoleDb} via ${fileTemplateDb}.')
            : translate('Files > ${sizeThresholdDb} KB split into ${chunkSizeDb} char chunks (${overlapPercentDb}% overlap), injecting top ${chunkCountDb} at ${filePositionDb} via ${fileTemplateDb}.'),
        tokens: dataBankTokens,
    };

    const translateToken = translateFiles
        ? {
            field: 'translateFiles',
            text: translate('Translate files into English before processing'),
            tone: translationAvailable ? 'active' : 'warn',
        }
        : {
            field: 'translateFiles',
            text: translate('Original language (no translation)'),
            tone: 'off',
        };

    let optionsRow;
    if (onlyCustomBoundary && forceChunkDelimiter) {
        optionsRow = {
            role: translate('File options'),
            template: translate('${onlyCustomBoundary} on ${forceChunkDelimiter}, ${translateFiles}.'),
            tokens: {
                onlyCustomBoundary: {
                    field: 'onlyCustomBoundary',
                    text: translate('Only chunk on custom boundary'),
                    tone: 'active',
                },
                forceChunkDelimiter: {
                    field: 'forceChunkDelimiter',
                    text: forceChunkDelimiter,
                    tone: 'active',
                },
                translateFiles: translateToken,
            },
        };
    } else if (onlyCustomBoundary) {
        optionsRow = {
            role: translate('File options'),
            tone: 'warn',
            template: translate('${onlyCustomBoundary} (${forceChunkDelimiter} empty, falls back to default chunking), ${translateFiles}.'),
            tokens: {
                onlyCustomBoundary: {
                    field: 'onlyCustomBoundary',
                    text: translate('Only chunk on custom boundary'),
                    tone: 'warn',
                },
                forceChunkDelimiter: {
                    field: 'forceChunkDelimiter',
                    text: translate('Chunk boundary'),
                    tone: 'warn',
                },
                translateFiles: translateToken,
            },
        };
    } else {
        optionsRow = {
            role: translate('File options'),
            tone: translateFiles ? '' : 'off',
            template: translate('${onlyCustomBoundary}, ${translateFiles}.'),
            tokens: {
                onlyCustomBoundary: {
                    field: 'onlyCustomBoundary',
                    text: translate('Recursive boundary chunking'),
                    tone: 'off',
                },
                translateFiles: translateToken,
            },
        };
    }

    const warnings = [];
    if (onlyCustomBoundary && !forceChunkDelimiter) {
        warnings.push({
            severity: 'warn',
            template: translate('${onlyCustomBoundary} is checked with an empty ${forceChunkDelimiter} — files fall back to default recursive chunking.'),
            tokens: {
                onlyCustomBoundary: {
                    field: 'onlyCustomBoundary',
                    text: translate('Only chunk on custom boundary'),
                    tone: 'warn',
                },
                forceChunkDelimiter: {
                    field: 'forceChunkDelimiter',
                    text: translate('Chunk boundary'),
                    tone: 'warn',
                },
            },
        });
    }
    if (translateFiles && !translationAvailable) {
        warnings.push({
            severity: 'warn',
            template: translate('${translateFiles} is checked, but Chat Translation is unavailable — files are indexed in their original language.'),
            tokens: {
                translateFiles: {
                    field: 'translateFiles',
                    text: translate('Translate files into English before processing'),
                    tone: 'warn',
                },
            },
        });
    }
    if (!hasTemplateTextMacro) {
        warnings.push({
            severity: 'danger',
            template: translate('${fileTemplateDb} is missing {{text}} — retrieved Data Bank chunks are dropped before prompt injection.'),
            tokens: {
                fileTemplateDb: {
                    field: 'fileTemplateDb',
                    text: translate('Injection Template'),
                    tone: 'danger',
                },
            },
        });
    }

    return {
        tone: resolveCardTone(warnings),
        rows: [attachmentsRow, dataBankRow, optionsRow],
        warnings,
        dormantFields: isInChat ? [] : ['fileDepthDb', 'fileDepthRoleDb'],
    };
}

/**
 * Card 4: Chat vectorization & summarization summary.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildVectorsChatsSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;

    if (!state.enabledChats) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Status'),
                tone: 'off',
                template: translate('${enabledChats} is off — chat messages are not vectorized or recalled by similarity.'),
                tokens: {
                    enabledChats: {
                        field: 'enabledChats',
                        text: translate('Enabled for chat messages'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [...CHAT_SUBFIELDS],
        };
    }

    const keepHidden = Boolean(state.keepHidden);
    const template = state.template === undefined
        ? 'Past events:\n{{text}}'
        : String(state.template ?? '');
    const hasTemplateTextMacro = template.includes('{{text}}');
    const position = resolvePromptPosition(state.position, 0);
    const isInChat = position === 1;
    const depth = clampMinInt(state.depth, 0, 2);
    const messageChunkSize = clampMinInt(state.messageChunkSize, 0, 400);
    const protect = clampMinInt(state.protect, 1, 5);
    const insert = clampMinInt(state.insert, 1, 3);

    const summarize = Boolean(state.summarize);
    const summarizeSent = Boolean(state.summarizeSent);
    const summarySourceLabel = resolveSummarySourceLabel(state.summarySource, translate);
    const summaryPrompt = state.summaryPrompt === undefined ? 'default' : String(state.summaryPrompt ?? '');
    const hasSummaryPrompt = Boolean(summaryPrompt.trim());
    const summaryRetries = clampMinInt(state.summaryRetries, 1, 2);
    const summaryThreshold = clampMinInt(state.summaryThreshold, 0, 200);

    const recallRow = {
        role: translate('Recall'),
        template: messageChunkSize > 0
            ? translate('Keeps the last ${protect} messages untouched and recalls up to ${insert} relevant older messages (${messageChunkSize} char chunks, ${keepHidden}).')
            : translate('Keeps the last ${protect} messages untouched and recalls up to ${insert} relevant older messages (${messageChunkSize}, ${keepHidden}).'),
        tokens: {
            protect: { field: 'protect', text: String(protect), tone: 'active' },
            insert: { field: 'insert', text: String(insert), tone: 'active' },
            messageChunkSize: {
                field: 'messageChunkSize',
                text: messageChunkSize > 0 ? String(messageChunkSize) : translate('whole messages'),
                tone: messageChunkSize > 0 ? 'active' : 'off',
            },
            keepHidden: {
                field: 'keepHidden',
                text: keepHidden
                    ? translate('including hidden messages')
                    : translate('excluding hidden messages'),
                tone: keepHidden ? 'active' : 'off',
            },
        },
    };

    const injectionTokens = {
        position: { field: 'position', text: resolvePositionLabel(position, translate), tone: 'active' },
        template: {
            field: 'template',
            text: translate('Injection Template'),
            tone: hasTemplateTextMacro ? 'active' : 'danger',
        },
    };
    if (isInChat) {
        injectionTokens.depth = { field: 'depth', text: String(depth), tone: 'active' };
    }

    const injectionRow = {
        role: translate('Injection'),
        template: isInChat
            ? translate('Moves recalled messages out of history and injects at ${position} depth ${depth} via ${template}.')
            : translate('Moves recalled messages out of history and injects at ${position} via ${template}.'),
        tokens: injectionTokens,
    };

    let summaryRow;
    if (!summarize) {
        summaryRow = {
            role: translate('Summary'),
            tone: 'off',
            template: translate('${summarize} — embeds raw chat messages directly without LLM summarization.'),
            tokens: {
                summarize: {
                    field: 'summarize',
                    text: translate('Summarization off'),
                    tone: 'off',
                },
            },
        };
    } else {
        summaryRow = {
            role: translate('Summary'),
            template: summaryThreshold > 0
                ? translate('Summarizes via ${summarySource} (${summaryPrompt}) for messages >= ${summaryThreshold} chars (${summarizeSent}, up to ${summaryRetries} retries).')
                : translate('Summarizes via ${summarySource} (${summaryPrompt}) for ${summaryThreshold} (${summarizeSent}, up to ${summaryRetries} retries).'),
            tokens: {
                summarySource: { field: 'summarySource', text: summarySourceLabel, tone: 'active' },
                summaryPrompt: {
                    field: 'summaryPrompt',
                    text: hasSummaryPrompt ? translate('Summary Prompt') : translate('empty prompt'),
                    tone: hasSummaryPrompt ? 'active' : 'danger',
                },
                summaryThreshold: {
                    field: 'summaryThreshold',
                    text: summaryThreshold > 0 ? String(summaryThreshold) : translate('all message lengths'),
                    tone: 'active',
                },
                summarizeSent: {
                    field: 'summarizeSent',
                    text: summarizeSent
                        ? translate('also summarizes sent queries')
                        : translate('queries not summarized'),
                    tone: summarizeSent ? 'active' : 'off',
                },
                summaryRetries: { field: 'summaryRetries', text: String(summaryRetries), tone: 'active' },
            },
        };
    }

    const warnings = [];
    if (summarizeSent && !summarize) {
        warnings.push({
            severity: 'warn',
            template: translate('${summarizeSent} is dormant while ${summarize} is off — outgoing query messages are embedded directly without summarization.'),
            tokens: {
                summarizeSent: {
                    field: 'summarizeSent',
                    text: translate('Summarize chat messages when sending'),
                    tone: 'warn',
                },
                summarize: {
                    field: 'summarize',
                    text: translate('Summarize chat messages for vector generation'),
                    tone: 'warn',
                },
            },
        });
    }
    if (!hasTemplateTextMacro) {
        warnings.push({
            severity: 'danger',
            template: translate('${template} is missing {{text}} — recalled chat messages are dropped before prompt injection.'),
            tokens: {
                template: {
                    field: 'template',
                    text: translate('Injection Template'),
                    tone: 'danger',
                },
            },
        });
    }
    if (summarize && !hasSummaryPrompt) {
        warnings.push({
            severity: 'danger',
            template: translate('${summarize} is enabled with an empty ${summaryPrompt} — summarization fails until a prompt is filled in or reset.'),
            tokens: {
                summarize: {
                    field: 'summarize',
                    text: translate('Summarize chat messages for vector generation'),
                    tone: 'danger',
                },
                summaryPrompt: {
                    field: 'summaryPrompt',
                    text: translate('Summary Prompt'),
                    tone: 'danger',
                },
            },
        });
    }

    const dormantFields = [];
    if (!summarize) {
        dormantFields.push(...SUMMARY_SUBFIELDS);
    }
    if (!isInChat) {
        dormantFields.push('depth');
    }

    return {
        tone: resolveCardTone(warnings),
        rows: [recallRow, injectionRow, summaryRow],
        warnings,
        dormantFields,
    };
}
