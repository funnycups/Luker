// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary models for Memory Graph settings (1A–1D),
// Custom Cadence modal, and Schema Type Editor (1E). No DOM dependencies.

import { i18n, i18nFormat } from '../i18n.js';
import { detectVisibilityGap } from './settings-model.js';

const IDENTITY_CANDIDATES = ['title', 'name', 'aliases'];

function safeInt(raw, fallback, { min = -Infinity, max = Infinity } = {}) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const num = isBlank ? NaN : Number(raw);
    let value = Math.floor(Number.isFinite(num) ? num : fallback);
    if (Number.isFinite(min)) value = Math.max(min, value);
    if (Number.isFinite(max)) value = Math.min(max, value);
    return value;
}

function presetToken(field, rawValue, list, fallbackLabelKey) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return { field, text: i18n(fallbackLabelKey), tone: 'active' };
    }
    const missing = Array.isArray(list) && !list.includes(value);
    return {
        field,
        text: missing ? i18nFormat('${0} (missing)', value) : value,
        tone: missing ? 'warn' : 'active',
    };
}

function profileToken(field, rawId, profiles) {
    const id = String(rawId || '').trim();
    if (!id) {
        return { field, text: i18n('unset'), tone: 'warn' };
    }
    const list = Array.isArray(profiles) ? profiles : null;
    const match = list ? list.find(p => String(p?.id || '') === id) : null;
    if (match) {
        return { field, text: String(match.name || match.id || id), tone: 'active' };
    }
    if (list) {
        return { field, text: i18nFormat('${0} (missing)', id), tone: 'warn' };
    }
    return { field, text: id, tone: 'active' };
}

function resolvePositionLabel(posVal, positions) {
    const p = positions || {};
    const num = Number(posVal);
    if (num === Number(p.before)) return i18n('Before Character Definitions');
    if (num === Number(p.after)) return i18n('After Character Definitions');
    if (num === Number(p.ANTop)) return i18n('Before Author\'s Note');
    if (num === Number(p.ANBottom)) return i18n('After Author\'s Note');
    if (num === Number(p.EMTop)) return i18n('Before Example Messages');
    if (num === Number(p.EMBottom)) return i18n('After Example Messages');
    if (num === Number(p.atDepth)) return i18n('At Chat Depth');
    return String(posVal ?? '');
}

function resolveRoleLabel(roleVal, roles) {
    const r = roles || {};
    const num = Number(roleVal);
    if (num === Number(r.SYSTEM)) return i18n('System');
    if (num === Number(r.USER)) return i18n('User');
    if (num === Number(r.ASSISTANT)) return i18n('Assistant');
    return String(roleVal ?? '');
}

function buildVisibilityGapWarning({ every, exclude, visible, gap }) {
    if (!gap?.hasGap) return null;
    const tokens = {
        updateEvery: { field: 'updateEvery', text: String(every), tone: 'warn' },
        llmVisibleRecentMessages: { field: 'llmVisibleRecentMessages', text: String(visible), tone: 'warn' },
        maxUnextracted: { field: null, text: String(gap.maxUnextracted), tone: 'warn' },
        recommended: { field: null, text: String(gap.minRecommendedVisible), tone: 'active' },
    };
    if (exclude > 0) {
        tokens.extractExcludeRecentTurns = { field: 'extractExcludeRecentTurns', text: String(exclude), tone: 'warn' };
        return {
            severity: 'warn',
            tone: 'warn',
            template: i18n('Visibility gap — with cadence ${updateEvery} and exclusion ${extractExcludeRecentTurns}, keeping ${llmVisibleRecentMessages} messages visible can hide up to ${maxUnextracted} unextracted turns before extraction runs. Keep at least ${recommended} or set 0.'),
            tokens,
        };
    }
    return {
        severity: 'warn',
        tone: 'warn',
        template: i18n('Visibility gap — with cadence ${updateEvery}, keeping ${llmVisibleRecentMessages} messages visible can hide up to ${maxUnextracted} unextracted turns before extraction runs. Keep at least ${recommended} or set 0.'),
        tokens,
    };
}

function buildMainModelRow(visible, hasGap) {
    if (visible <= 0) {
        return {
            role: i18n('Main model'),
            template: i18n('Keeps ${llmVisibleRecentMessages} visible to the generation model (no floor hiding).'),
            tokens: {
                llmVisibleRecentMessages: {
                    field: 'llmVisibleRecentMessages',
                    text: i18n('0 (all raw chat history)'),
                    tone: 'off',
                },
            },
        };
    }
    return {
        role: i18n('Main model'),
        template: i18n('Keeps only ${llmVisibleRecentMessages} visible to the generation model and hides older floors (replaced by memory graph injection).'),
        tokens: {
            llmVisibleRecentMessages: {
                field: 'llmVisibleRecentMessages',
                text: i18nFormat('${0} messages', visible),
                tone: hasGap ? 'warn' : 'active',
            },
        },
    };
}

function resolvePrimaryKeyText(draft) {
    const columns = Array.isArray(draft?.columns) ? draft.columns : [];
    const byKey = new Map(columns.map(c => [c.key, (c.label || '').trim() || c.key]));
    const rawKeys = Array.isArray(draft?.raw?.primaryKeyColumns) ? draft.raw.primaryKeyColumns : [];
    let activeKeys = rawKeys.map(k => String(k ?? '').trim()).filter(k => k && byKey.has(k));
    if (draft?.latestOnly && activeKeys.length === 0) {
        activeKeys = IDENTITY_CANDIDATES.filter(k => byKey.has(k));
        if (activeKeys.length === 0 && columns.length > 0) activeKeys = [columns[0].key];
    }
    const labels = activeKeys.map(k => byKey.get(k)).filter(Boolean);
    return labels.join(', ') || 'title';
}

/**
 * Master toggle notice displayed in the top Enabled group when Memory Graph is off.
 * Returns null when enabled.
 */
export function buildMgMasterNoticeModel({ enabled } = {}) {
    if (enabled) return null;
    return {
        tone: 'dormant',
        rows: [
            {
                role: i18n('Memory Graph'),
                template: i18n('Memory Graph is ${enabled} — extraction, floor hiding, persistent injection, and recall will not run until enabled'),
                tokens: {
                    enabled: {
                        field: 'enabled',
                        text: i18n('disabled'),
                        tone: 'off',
                    },
                },
            },
        ],
    };
}

/**
 * Section 1 (1A): Full 10-field Extraction Cadence & Floor Hiding summary.
 */
export function buildMgExtractionSectionModel({ values = {}, advanced = {}, options = {} } = {}) {
    const autoExtract = values?.autoExtractionEnabled !== false;
    const autoCompress = values?.autoCompressionEnabled !== false;
    const includeWi = advanced?.extractIncludeWorldInfo !== false;
    const every = safeInt(advanced?.updateEvery, 2, { min: 1 });
    const batch = safeInt(advanced?.extractBatchTurns, 2, { min: 1 });
    const ctx = safeInt(advanced?.extractContextTurns, 2, { min: 1, max: 32 });
    const exclude = safeInt(advanced?.extractExcludeRecentTurns, 0, { min: 0 });
    const visible = safeInt(advanced?.llmVisibleRecentMessages, 5, { min: 0, max: 200 });

    const gap = detectVisibilityGap({
        updateEvery: every,
        extractExcludeRecentTurns: exclude,
        llmVisibleRecentMessages: visible,
    });

    const extractTokens = {
        autoExtractionEnabled: {
            field: 'autoExtractionEnabled',
            text: autoExtract ? i18n('auto') : i18n('off'),
            tone: autoExtract ? 'active' : 'off',
        },
        extractBatchTurns: {
            field: 'extractBatchTurns',
            text: String(batch),
            tone: 'active',
        },
        extractContextTurns: {
            field: 'extractContextTurns',
            text: String(ctx),
            tone: 'active',
        },
        extractIncludeWorldInfo: {
            field: 'extractIncludeWorldInfo',
            text: includeWi ? i18n('with world info') : i18n('without world info'),
            tone: includeWi ? 'active' : 'off',
        },
        extractApiPresetName: presetToken('extractApiPresetName', values?.extractApiPresetName, options?.connections, 'Current API'),
        extractPresetName: presetToken('extractPresetName', values?.extractPresetName, options?.presets, 'Current preset'),
        autoCompressionEnabled: {
            field: 'autoCompressionEnabled',
            text: autoCompress ? i18n('auto compression on') : i18n('auto compression off'),
            tone: autoCompress ? 'active' : 'off',
        },
    };

    let updateRow;
    if (!autoExtract) {
        updateRow = {
            role: i18n('Memory update'),
            tone: 'off',
            template: i18n('${autoExtractionEnabled} — automatic extraction will not run on new replies (manual Fill/Rebuild still reads ${extractContextTurns} raw replies unaffected by floor hiding at ${extractBatchTurns} per batch, ${extractIncludeWorldInfo}, via ${extractApiPresetName} + ${extractPresetName}, ${autoCompressionEnabled}).'),
            tokens: extractTokens,
        };
    } else if (exclude > 0) {
        updateRow = {
            role: i18n('Memory update'),
            template: i18n('${autoExtractionEnabled} — extracts every ${updateEvery} assistant replies (${extractBatchTurns} per batch, reading ${extractContextTurns} preceding raw replies unaffected by floor hiding, skipping latest ${extractExcludeRecentTurns}), ${extractIncludeWorldInfo}, via ${extractApiPresetName} + ${extractPresetName}, with ${autoCompressionEnabled}.'),
            tokens: {
                ...extractTokens,
                updateEvery: { field: 'updateEvery', text: String(every), tone: gap.hasGap ? 'warn' : 'active' },
                extractExcludeRecentTurns: { field: 'extractExcludeRecentTurns', text: String(exclude), tone: gap.hasGap ? 'warn' : 'active' },
            },
        };
    } else {
        updateRow = {
            role: i18n('Memory update'),
            template: i18n('${autoExtractionEnabled} — extracts every ${updateEvery} assistant replies (${extractBatchTurns} per batch, reading ${extractContextTurns} preceding raw replies unaffected by floor hiding), ${extractIncludeWorldInfo}, via ${extractApiPresetName} + ${extractPresetName}, with ${autoCompressionEnabled}.'),
            tokens: {
                ...extractTokens,
                updateEvery: { field: 'updateEvery', text: String(every), tone: gap.hasGap ? 'warn' : 'active' },
            },
        };
    }

    const warnings = [];
    const gapWarn = buildVisibilityGapWarning({ every, exclude, visible, gap });
    if (gapWarn) warnings.push(gapWarn);

    const tone = gap.hasGap
        ? 'warn'
        : (!autoExtract && visible === 0 ? 'dormant' : 'active');

    return {
        tone,
        rows: [updateRow, buildMainModelRow(visible, gap.hasGap)],
        warnings,
        dormantFields: autoExtract
            ? []
            : ['extractApiPresetName', 'extractPresetName', 'extractIncludeWorldInfo'],
    };
}

/**
 * Custom Cadence & Floor Hiding modal (1A 5-field card): every token maps 1:1 to modal inputs.
 */
export function buildMgCustomCadenceModalModel({ draft = {}, autoExtractionEnabled = true } = {}) {
    const autoExtract = autoExtractionEnabled !== false;
    const every = safeInt(draft?.updateEvery, 2, { min: 1 });
    const batch = safeInt(draft?.extractBatchTurns, 2, { min: 1 });
    const ctx = safeInt(draft?.extractContextTurns, 2, { min: 1, max: 32 });
    const exclude = safeInt(draft?.extractExcludeRecentTurns, 0, { min: 0 });
    const visible = safeInt(draft?.llmVisibleRecentMessages, 5, { min: 0, max: 200 });

    const gap = detectVisibilityGap({
        updateEvery: every,
        extractExcludeRecentTurns: exclude,
        llmVisibleRecentMessages: visible,
    });

    const baseTokens = {
        updateEvery: { field: 'updateEvery', text: String(every), tone: gap.hasGap ? 'warn' : (autoExtract ? 'active' : 'off') },
        extractBatchTurns: { field: 'extractBatchTurns', text: String(batch), tone: 'active' },
        extractContextTurns: { field: 'extractContextTurns', text: String(ctx), tone: 'active' },
    };

    let updateRow;
    if (!autoExtract) {
        updateRow = {
            role: i18n('Memory update'),
            tone: 'off',
            template: exclude > 0
                ? i18n('Auto extraction is off (would run every ${updateEvery} replies, skipping latest ${extractExcludeRecentTurns}). Manual Fill/Rebuild reads ${extractContextTurns} preceding raw replies unaffected by floor hiding at ${extractBatchTurns} per batch.')
                : i18n('Auto extraction is off (would run every ${updateEvery} replies). Manual Fill/Rebuild reads ${extractContextTurns} preceding raw replies unaffected by floor hiding at ${extractBatchTurns} per batch.'),
            tokens: exclude > 0
                ? {
                    ...baseTokens,
                    extractExcludeRecentTurns: { field: 'extractExcludeRecentTurns', text: String(exclude), tone: 'off' },
                }
                : baseTokens,
        };
    } else if (exclude > 0) {
        updateRow = {
            role: i18n('Memory update'),
            template: i18n('Extracts every ${updateEvery} assistant replies (${extractBatchTurns} per batch, reading ${extractContextTurns} preceding raw replies unaffected by floor hiding, skipping latest ${extractExcludeRecentTurns}).'),
            tokens: {
                ...baseTokens,
                extractExcludeRecentTurns: { field: 'extractExcludeRecentTurns', text: String(exclude), tone: gap.hasGap ? 'warn' : 'active' },
            },
        };
    } else {
        updateRow = {
            role: i18n('Memory update'),
            template: i18n('Extracts every ${updateEvery} assistant replies (${extractBatchTurns} per batch, reading ${extractContextTurns} preceding raw replies unaffected by floor hiding).'),
            tokens: baseTokens,
        };
    }

    const warnings = [];
    const gapWarn = buildVisibilityGapWarning({ every, exclude, visible, gap });
    if (gapWarn) warnings.push(gapWarn);

    const tone = gap.hasGap
        ? 'warn'
        : (!autoExtract && visible === 0 ? 'dormant' : 'active');

    return {
        tone,
        rows: [updateRow, buildMainModelRow(visible, gap.hasGap)],
        warnings,
        dormantFields: autoExtract
            ? []
            : ['updateEvery', 'extractBatchTurns', 'extractContextTurns', 'extractExcludeRecentTurns'],
    };
}

/**
 * Section 2 (1B): Extraction Mode & Crawl summary.
 */
export function buildMgExtractionModeModel({ advanced = {} } = {}) {
    const isCrawl = String(advanced?.extractMode || 'oneshot').trim().toLowerCase() === 'crawl';
    if (!isCrawl) {
        return {
            tone: 'active',
            rows: [
                {
                    role: i18n('Graph input'),
                    template: i18n('${extractMode} — sends all visible graph nodes in a single extraction pass.'),
                    tokens: {
                        extractMode: { field: 'extractMode', text: i18n('One-shot'), tone: 'active' },
                    },
                },
            ],
            warnings: [],
            dormantFields: [],
        };
    }

    const maxRounds = safeInt(advanced?.extractCrawlMaxRounds, 3, { min: 1, max: 5 });
    const candidateLimit = safeInt(advanced?.extractCrawlCandidateLimit, 40, { min: 0, max: 100 });
    const maxReads = safeInt(advanced?.extractCrawlMaxReads, 12, { min: 1, max: 30 });

    const commonTokens = {
        extractMode: { field: 'extractMode', text: i18n('Crawl'), tone: 'active' },
        extractCrawlMaxRounds: { field: 'extractCrawlMaxRounds', text: String(maxRounds), tone: 'active' },
        extractCrawlMaxReads: { field: 'extractCrawlMaxReads', text: String(maxReads), tone: 'active' },
    };

    if (candidateLimit <= 0) {
        return {
            tone: 'active',
            rows: [
                {
                    role: i18n('Graph input'),
                    template: i18n('${extractMode} — explores up to ${extractCrawlMaxRounds} read-only rounds over ${extractCrawlCandidateLimit} initial candidates with at most ${extractCrawlMaxReads} read calls (no slice cap).'),
                    tokens: {
                        ...commonTokens,
                        extractCrawlCandidateLimit: { field: 'extractCrawlCandidateLimit', text: i18n('unlimited (0)'), tone: 'active' },
                    },
                },
            ],
            warnings: [],
            dormantFields: [],
        };
    }

    const sliceCap = candidateLimit + 2 * maxReads;
    return {
        tone: 'active',
        rows: [
            {
                role: i18n('Graph input'),
                template: i18n('${extractMode} — explores up to ${extractCrawlMaxRounds} read-only rounds over ${extractCrawlCandidateLimit} initial candidates with at most ${extractCrawlMaxReads} read calls (final slice cap ${sliceCap}).'),
                tokens: {
                    ...commonTokens,
                    extractCrawlCandidateLimit: { field: 'extractCrawlCandidateLimit', text: String(candidateLimit), tone: 'active' },
                    sliceCap: { field: null, text: String(sliceCap), tone: 'active' },
                },
            },
        ],
        warnings: [],
        dormantFields: [],
    };
}

/**
 * Section 3 (1C): Prompt Injection & Recall summary.
 * When !recallEnabled, ONLY on-demand recall method/model/RAG controls become dormant;
 * recallInjectPosition, recallInjectDepth, and recallInjectRole stay active because
 * persistent injection uses the exact same placement controls.
 */
export function buildMgRecallSectionModel({ values = {}, advanced = {}, options = {} } = {}) {
    const horizon = safeInt(advanced?.persistentInjectionMaxSeqDistance, 0, { min: 0 });
    const recallEnabled = values?.recallEnabled !== false;
    const isRag = String(values?.recallMethod || 'llm').trim().toLowerCase() === 'rag';

    const persistentRow = horizon <= 0
        ? {
            role: i18n('Persistent'),
            template: i18n('Always-visible types and events inject on every reply across ${persistentInjectionMaxSeqDistance} without waiting for recall.'),
            tokens: {
                persistentInjectionMaxSeqDistance: {
                    field: 'persistentInjectionMaxSeqDistance',
                    text: i18n('all history (0)'),
                    tone: 'active',
                },
            },
        }
        : {
            role: i18n('Persistent'),
            template: i18n('Always-visible types and events inject within ${persistentInjectionMaxSeqDistance} (older entries fall back to recall candidates).'),
            tokens: {
                persistentInjectionMaxSeqDistance: {
                    field: 'persistentInjectionMaxSeqDistance',
                    text: i18nFormat('${0} assistant turns', horizon),
                    tone: 'active',
                },
            },
        };

    const warnings = [];
    let recallRow;

    if (!recallEnabled) {
        recallRow = {
            role: i18n('On-demand recall'),
            tone: 'off',
            template: i18n('${recallEnabled} — on-demand recall is skipped. Only persistent injection runs.'),
            tokens: {
                recallEnabled: { field: 'recallEnabled', text: i18n('off'), tone: 'off' },
            },
        };
    } else if (!isRag) {
        const includeWi = advanced?.recallIncludeWorldInfo !== false;
        recallRow = {
            role: i18n('On-demand recall'),
            template: i18n('${recallMethod} via ${recallApiPresetName} + ${recallPresetName}, ${recallIncludeWorldInfo}.'),
            tokens: {
                recallMethod: { field: 'recallMethod', text: i18n('LLM Recall'), tone: 'active' },
                recallApiPresetName: presetToken('recallApiPresetName', values?.recallApiPresetName, options?.connections, 'Current API'),
                recallPresetName: presetToken('recallPresetName', values?.recallPresetName, options?.presets, 'Current preset'),
                recallIncludeWorldInfo: {
                    field: 'recallIncludeWorldInfo',
                    text: includeWi ? i18n('with world info') : i18n('without world info'),
                    tone: includeWi ? 'active' : 'off',
                },
            },
        };
    } else {
        const embeddingProfileId = String(values?.embeddingProfileId || '').trim();
        const vectorTopK = safeInt(values?.vectorTopK, 20, { min: 5, max: 100 });
        const hybridMaxResults = safeInt(values?.hybridMaxResults, 15, { min: 3, max: 50 });
        const ragDefaultPerTypeK = safeInt(values?.ragDefaultPerTypeK, 3, { min: 0, max: 50 });
        const useRerank = Boolean(values?.ragUseRerank);
        const rerankProfileId = String(values?.rerankProfileId || '').trim();
        const useRewrite = Boolean(values?.ragUseQueryRewrite);

        const tokens = {
            recallMethod: { field: 'recallMethod', text: i18n('RAG Vector Recall'), tone: 'active' },
            embeddingProfileId: profileToken('embeddingProfileId', embeddingProfileId, options?.embeddingProfiles),
            vectorTopK: { field: 'vectorTopK', text: String(vectorTopK), tone: 'active' },
            hybridMaxResults: { field: 'hybridMaxResults', text: String(hybridMaxResults), tone: 'active' },
            ragDefaultPerTypeK: {
                field: 'ragDefaultPerTypeK',
                text: ragDefaultPerTypeK > 0 ? i18nFormat('${0} per type', ragDefaultPerTypeK) : i18n('shared pool (0 per type)'),
                tone: ragDefaultPerTypeK > 0 ? 'active' : 'off',
            },
            ragUseRerank: {
                field: 'ragUseRerank',
                text: useRerank ? i18n('rerank on') : i18n('rerank off'),
                tone: useRerank ? 'active' : 'off',
            },
            ragUseQueryRewrite: {
                field: 'ragUseQueryRewrite',
                text: useRewrite ? i18n('query rewrite on') : i18n('query rewrite off'),
                tone: useRewrite ? 'active' : 'off',
            },
        };

        if (useRerank) {
            tokens.rerankProfileId = profileToken('rerankProfileId', rerankProfileId, options?.rerankProfiles);
        }
        if (useRewrite) {
            tokens.ragRewriteApiPresetName = presetToken('ragRewriteApiPresetName', values?.ragRewriteApiPresetName, options?.connections, 'Current API');
            tokens.ragRewriteLlmPresetName = presetToken('ragRewriteLlmPresetName', values?.ragRewriteLlmPresetName, options?.presets, 'Current preset');
        }

        let template;
        if (useRerank && useRewrite) {
            template = i18n('${recallMethod} via ${embeddingProfileId} — pre-filters top ${vectorTopK} then picks up to ${hybridMaxResults} (${ragDefaultPerTypeK}), ${ragUseRerank} via ${rerankProfileId}, ${ragUseQueryRewrite} via ${ragRewriteApiPresetName} + ${ragRewriteLlmPresetName}.');
        } else if (useRerank) {
            template = i18n('${recallMethod} via ${embeddingProfileId} — pre-filters top ${vectorTopK} then picks up to ${hybridMaxResults} (${ragDefaultPerTypeK}), ${ragUseRerank} via ${rerankProfileId}, ${ragUseQueryRewrite}.');
        } else if (useRewrite) {
            template = i18n('${recallMethod} via ${embeddingProfileId} — pre-filters top ${vectorTopK} then picks up to ${hybridMaxResults} (${ragDefaultPerTypeK}), ${ragUseRerank}, ${ragUseQueryRewrite} via ${ragRewriteApiPresetName} + ${ragRewriteLlmPresetName}.');
        } else {
            template = i18n('${recallMethod} via ${embeddingProfileId} — pre-filters top ${vectorTopK} then picks up to ${hybridMaxResults} (${ragDefaultPerTypeK}), ${ragUseRerank}, ${ragUseQueryRewrite}.');
        }

        recallRow = {
            role: i18n('On-demand recall'),
            template,
            tokens,
        };

        if (!embeddingProfileId) {
            warnings.push({
                severity: 'danger',
                tone: 'danger',
                template: i18n('RAG recall is active without an ${embeddingProfileId} — retrieval cannot run until an embedding profile is selected.'),
                tokens: {
                    embeddingProfileId: { field: 'embeddingProfileId', text: i18n('embedding profile'), tone: 'danger' },
                },
            });
        }
        if (useRerank && !rerankProfileId) {
            warnings.push({
                severity: 'warn',
                tone: 'warn',
                template: i18n('${ragUseRerank} is enabled without a ${rerankProfileId} — results will stay in vector order until one is selected.'),
                tokens: {
                    ragUseRerank: { field: 'ragUseRerank', text: i18n('Rerank'), tone: 'warn' },
                    rerankProfileId: { field: 'rerankProfileId', text: i18n('rerank profile'), tone: 'warn' },
                },
            });
        }
    }

    const positions = options?.positions || { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 };
    const roles = options?.roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
    const posVal = safeInt(values?.recallInjectPosition, positions.atDepth ?? 6);
    const isAtDepth = Number(posVal) === Number(positions.atDepth ?? 6);
    const depth = safeInt(values?.recallInjectDepth, 9999, { min: 0, max: 10000 });
    const roleVal = safeInt(values?.recallInjectRole, roles.SYSTEM ?? 0);

    const placementRow = isAtDepth
        ? {
            role: i18n('Placement'),
            template: i18n('Positions both persistent injection and on-demand recall at ${recallInjectPosition}, depth ${recallInjectDepth} as ${recallInjectRole}.'),
            tokens: {
                recallInjectPosition: { field: 'recallInjectPosition', text: resolvePositionLabel(posVal, positions), tone: 'active' },
                recallInjectDepth: { field: 'recallInjectDepth', text: String(depth), tone: 'active' },
                recallInjectRole: { field: 'recallInjectRole', text: resolveRoleLabel(roleVal, roles), tone: 'active' },
            },
        }
        : {
            role: i18n('Placement'),
            template: i18n('Positions both persistent injection and on-demand recall at ${recallInjectPosition}.'),
            tokens: {
                recallInjectPosition: { field: 'recallInjectPosition', text: resolvePositionLabel(posVal, positions), tone: 'active' },
            },
        };

    const dormantFields = recallEnabled
        ? []
        : [
            'recallMethod',
            'embeddingProfileId',
            'vectorTopK',
            'hybridMaxResults',
            'ragDefaultPerTypeK',
            'ragUseRerank',
            'rerankProfileId',
            'ragUseQueryRewrite',
            'ragRewriteApiPresetName',
            'ragRewriteLlmPresetName',
            'recallApiPresetName',
            'recallPresetName',
            'recallIncludeWorldInfo',
        ];

    const hasDanger = warnings.some(w => w.severity === 'danger');
    const hasWarn = warnings.some(w => w.severity === 'warn');

    return {
        tone: hasDanger ? 'danger' : (hasWarn ? 'warn' : 'active'),
        rows: [persistentRow, recallRow, placementRow],
        warnings,
        dormantFields,
    };
}

/**
 * Section 5 (1D): Technical Tuning summary inside collapsed <details>.
 */
export function buildMgTechnicalSectionModel({ values = {}, advanced = {} } = {}) {
    const concurrent = Boolean(advanced?.extractConcurrent);
    const retries = safeInt(advanced?.toolCallRetryMax, 2, { min: 0, max: 10 });
    const rpm = safeInt(advanced?.rpmLimit, 0, { min: 0, max: 600 });
    const queryMsgs = safeInt(advanced?.recallQueryMessages, 2, { min: 0, max: 64 });
    const maxIter = safeInt(advanced?.recallMaxIterations, 3, { min: 2, max: 6 });
    const isRag = String(values?.recallMethod || 'llm').trim().toLowerCase() === 'rag';

    const executionRow = {
        role: i18n('Execution'),
        template: i18n('Extraction runs ${extractConcurrent}, retries invalid tool calls up to ${toolCallRetryMax} times, rate limit ${rpmLimit}.'),
        tokens: {
            extractConcurrent: {
                field: 'extractConcurrent',
                text: concurrent ? i18n('concurrently across types') : i18n('sequentially'),
                tone: concurrent ? 'active' : 'off',
            },
            toolCallRetryMax: {
                field: 'toolCallRetryMax',
                text: String(retries),
                tone: retries > 0 ? 'active' : 'off',
            },
            rpmLimit: {
                field: 'rpmLimit',
                text: rpm > 0 ? i18nFormat('${0} RPM', rpm) : i18n('unlimited (0)'),
                tone: rpm > 0 ? 'active' : 'off',
            },
        },
    };

    const queryToken = {
        field: 'recallQueryMessages',
        text: queryMsgs === 0 ? i18n('latest user message only (0)') : String(queryMsgs),
        tone: 'active',
    };

    let recallRow;
    if (isRag) {
        recallRow = {
            role: i18n('Recall tuning'),
            template: queryMsgs === 0
                ? i18n('Recall query uses ${recallQueryMessages} (RAG recall active, max iterations unused).')
                : i18n('Recall query reads the latest ${recallQueryMessages} assistant turns (RAG recall active, max iterations unused).'),
            tokens: { recallQueryMessages: queryToken },
        };
    } else {
        recallRow = {
            role: i18n('Recall tuning'),
            template: queryMsgs === 0
                ? i18n('Recall query uses ${recallQueryMessages}, and LLM recall runs up to ${recallMaxIterations} tool rounds.')
                : i18n('Recall query reads the latest ${recallQueryMessages} assistant turns, and LLM recall runs up to ${recallMaxIterations} tool rounds.'),
            tokens: {
                recallQueryMessages: queryToken,
                recallMaxIterations: { field: 'recallMaxIterations', text: String(maxIter), tone: 'active' },
            },
        };
    }

    return {
        tone: 'active',
        rows: [executionRow, recallRow],
        warnings: [],
        dormantFields: [],
    };
}

/**
 * Schema Type Editor (1E): Per-type live summary reflecting runtime overrides
 * (`event_table` hardcoded always-inject, `event` append-only ignoring `latestOnly`)
 * and read-only global settings (`field: null`).
 */
export function buildMgSchemaTypeModel({ draft = {}, globalSettings = {} } = {}) {
    const raw = draft?.raw && typeof draft.raw === 'object' ? draft.raw : {};
    const typeId = String(draft?.id || '').trim().toLowerCase();
    const rawTableName = String(raw.tableName || '').trim();
    const isEventTable = rawTableName.toLowerCase() === 'event_table';
    const isEventType = typeId === 'event';
    const alwaysInject = Boolean(draft?.alwaysInject);
    const latestOnly = Boolean(draft?.latestOnly);
    const compressionEnabled = Boolean(draft?.compression);
    const forceUpdate = Boolean(raw.forceUpdate);
    const editable = Boolean(raw.editable);
    const extractEveryN = safeInt(raw.extractEveryN, 1, { min: 1 });
    const ragPerTypeK = safeInt(raw.ragPerTypeK, 0, { min: 0 });

    const comp = raw.compression && typeof raw.compression === 'object' ? raw.compression : {};
    const threshold = safeInt(comp.threshold, 6, { min: 2 });
    const fanIn = safeInt(comp.fanIn, 3, { min: 2 });
    const maxDepth = safeInt(comp.maxDepth, 6, { min: 1 });
    const keepRecentLeaves = safeInt(comp.keepRecentLeaves, 0, { min: 0 });

    const globalAutoComp = globalSettings?.autoCompressionEnabled !== false;
    const globalHorizon = safeInt(globalSettings?.persistentInjectionMaxSeqDistance, 0, { min: 0 });
    const globalRagDefaultK = safeInt(globalSettings?.ragDefaultPerTypeK, 0, { min: 0 });

    const horizonToken = globalHorizon <= 0
        ? { field: null, text: i18n('all history (0 global horizon)'), tone: 'active' }
        : { field: null, text: i18nFormat('${0} assistant turns (global horizon)', globalHorizon), tone: 'active' };

    let visibilityRow;
    if (isEventTable) {
        visibilityRow = {
            role: i18n('Visibility'),
            template: globalHorizon <= 0
                ? i18n('Persistently injected on every reply (table ${tableName} always injects regardless of ${alwaysInject}), covering ${globalHorizon}.')
                : i18n('Persistently injected within ${globalHorizon} (table ${tableName} always injects regardless of ${alwaysInject}), older entries fall back to recall.'),
            tokens: {
                tableName: { field: 'tableName', text: rawTableName || 'event_table', tone: 'active' },
                alwaysInject: {
                    field: 'alwaysInject',
                    text: alwaysInject ? i18n('toggle on') : i18n('toggle off'),
                    tone: alwaysInject ? 'active' : 'off',
                },
                globalHorizon: horizonToken,
            },
        };
    } else if (alwaysInject) {
        visibilityRow = {
            role: i18n('Visibility'),
            template: globalHorizon <= 0
                ? i18n('${alwaysInject} — injected on every reply covering ${globalHorizon}, bypassing recall.')
                : i18n('${alwaysInject} — injected on every reply within ${globalHorizon}, older entries fall back to recall.'),
            tokens: {
                alwaysInject: { field: 'alwaysInject', text: i18n('Always visible'), tone: 'active' },
                globalHorizon: horizonToken,
            },
        };
    } else if (ragPerTypeK > 0) {
        visibilityRow = {
            role: i18n('Visibility'),
            template: i18n('${alwaysInject} — retrieved via recall when relevant (RAG per-type quota ${ragPerTypeK}).'),
            tokens: {
                alwaysInject: { field: 'alwaysInject', text: i18n('On-demand recall'), tone: 'off' },
                ragPerTypeK: { field: 'ragPerTypeK', text: String(ragPerTypeK), tone: 'active' },
            },
        };
    } else {
        visibilityRow = {
            role: i18n('Visibility'),
            template: i18n('${alwaysInject} — retrieved via recall when relevant (RAG quota ${ragPerTypeK}, global default ${globalRagDefaultK}).'),
            tokens: {
                alwaysInject: { field: 'alwaysInject', text: i18n('On-demand recall'), tone: 'off' },
                ragPerTypeK: { field: 'ragPerTypeK', text: i18n('follow global (0)'), tone: 'off' },
                globalRagDefaultK: {
                    field: null,
                    text: globalRagDefaultK > 0 ? i18nFormat('${0} per type', globalRagDefaultK) : i18n('shared pool (0)'),
                    tone: globalRagDefaultK > 0 ? 'active' : 'off',
                },
            },
        };
    }

    const commonRecTokens = {
        forceUpdate: {
            field: 'forceUpdate',
            text: forceUpdate ? i18n('forced every batch') : i18n('scheduled'),
            tone: forceUpdate ? 'active' : 'off',
        },
        editable: {
            field: 'editable',
            text: editable ? i18n('create, edit & delete') : i18n('create-only'),
            tone: editable ? 'active' : 'off',
        },
        ...(!forceUpdate ? {
            extractEveryN: { field: 'extractEveryN', text: String(extractEveryN), tone: 'active' },
        } : {}),
    };

    let recordingRow;
    if (isEventType) {
        recordingRow = {
            role: i18n('Recording'),
            template: forceUpdate
                ? i18n('Appends a new node per occurrence (${latestOnly} does not apply to built-in events), ${forceUpdate}, ${editable}.')
                : i18n('Appends a new node per occurrence (${latestOnly} does not apply to built-in events), runs every ${extractEveryN} floors (${forceUpdate}), ${editable}.'),
            tokens: {
                ...commonRecTokens,
                latestOnly: { field: 'latestOnly', text: i18n('latest-only'), tone: 'off' },
            },
        };
    } else if (latestOnly) {
        recordingRow = {
            role: i18n('Recording'),
            template: forceUpdate
                ? i18n('${latestOnly} by ${primaryKeyColumns}, ${forceUpdate}, ${editable}.')
                : i18n('${latestOnly} by ${primaryKeyColumns}, runs every ${extractEveryN} floors (${forceUpdate}), ${editable}.'),
            tokens: {
                ...commonRecTokens,
                latestOnly: { field: 'latestOnly', text: i18n('Keep latest per key'), tone: 'active' },
                primaryKeyColumns: { field: 'primaryKeyColumns', text: resolvePrimaryKeyText(draft), tone: 'active' },
            },
        };
    } else {
        recordingRow = {
            role: i18n('Recording'),
            template: forceUpdate
                ? i18n('${latestOnly} — stores separate entries, ${forceUpdate}, ${editable}.')
                : i18n('${latestOnly} — stores separate entries, runs every ${extractEveryN} floors (${forceUpdate}), ${editable}.'),
            tokens: {
                ...commonRecTokens,
                latestOnly: { field: 'latestOnly', text: i18n('Keep separate entries'), tone: 'off' },
            },
        };
    }

    let compressionRow;
    if (!compressionEnabled) {
        compressionRow = {
            role: i18n('Compression'),
            tone: 'off',
            template: i18n('${compression} — entries stay flat and the compression parameters below are inactive.'),
            tokens: {
                compression: { field: 'compression', text: i18n('off'), tone: 'off' },
            },
        };
    } else if (globalAutoComp) {
        compressionRow = {
            role: i18n('Compression'),
            template: i18n('${compression} (${globalAutoCompression}) — merges oldest ${fanIn} nodes once ${threshold} accumulate, up to ${maxDepth} levels while keeping newest ${keepRecentLeaves} leaves raw.'),
            tokens: {
                compression: { field: 'compression', text: i18n('Hierarchical'), tone: 'active' },
                globalAutoCompression: { field: null, text: i18n('global auto compression on'), tone: 'active' },
                fanIn: { field: 'fanIn', text: String(fanIn), tone: 'active' },
                threshold: { field: 'threshold', text: String(threshold), tone: 'active' },
                maxDepth: { field: 'maxDepth', text: String(maxDepth), tone: 'active' },
                keepRecentLeaves: { field: 'keepRecentLeaves', text: String(keepRecentLeaves), tone: 'active' },
            },
        };
    } else {
        compressionRow = {
            role: i18n('Compression'),
            template: i18n('${compression} — merges oldest ${fanIn} nodes once ${threshold} accumulate (up to ${maxDepth} levels, keeping ${keepRecentLeaves} recent leaves), paused because ${globalAutoCompression} (manual compress still uses these rules).'),
            tokens: {
                compression: { field: 'compression', text: i18n('Hierarchical'), tone: 'active' },
                fanIn: { field: 'fanIn', text: String(fanIn), tone: 'active' },
                threshold: { field: 'threshold', text: String(threshold), tone: 'active' },
                maxDepth: { field: 'maxDepth', text: String(maxDepth), tone: 'active' },
                keepRecentLeaves: { field: 'keepRecentLeaves', text: String(keepRecentLeaves), tone: 'active' },
                globalAutoCompression: { field: null, text: i18n('global auto compression is off'), tone: 'warn' },
            },
        };
    }

    const dormantFields = [];
    if (!compressionEnabled) {
        dormantFields.push('threshold', 'fanIn', 'maxDepth', 'keepRecentLeaves', 'rule', 'summarizeInstruction');
    }
    if (isEventType) {
        dormantFields.push('latestOnly', 'primaryKeyColumns');
    } else if (!latestOnly) {
        dormantFields.push('primaryKeyColumns');
    }

    return {
        tone: compressionEnabled && !globalAutoComp ? 'warn' : 'active',
        rows: [visibilityRow, recordingRow, compressionRow],
        warnings: [],
        dormantFields,
    };
}
