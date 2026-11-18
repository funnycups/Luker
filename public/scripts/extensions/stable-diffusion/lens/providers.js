// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration } from '../../../lens-shared/util.js';
import { redact } from '../../../workbench/model/requests.js';
import { computeImageCapabilities } from '../capabilities.js';
import { createCharacterProfileStore } from '../character-archive/store.js';
import { formatWorkflowTopology } from '../comfy-workflow-graph.js';
import { getPresetById } from '../illustration/settings.js';
import { i18n, i18nFormat } from './i18n.js';
import { fetchDiskWorkflows } from './iterate-target.js';

const PRIVATE_SD_URL_KEYS = [
    'auto_url',
    'vlad_url',
    'sdcpp_url',
    'drawthings_url',
    'comfy_url',
    'comfy_runpod_url',
    'novel_url',
    'chat_image_url',
];

const PRIVATE_SD_SECRET_KEYS = [
    'auto_auth',
    'vlad_auth',
    'drawthings_auth',
    'comfy_auth',
    'api_key',
];

function redactSdString(raw, sdSettings) {
    let text = String(raw ?? '');
    if (sdSettings && typeof sdSettings === 'object') {
        for (const k of PRIVATE_SD_SECRET_KEYS) {
            const secretVal = String(sdSettings[k] || '').trim();
            if (secretVal && text.includes(secretVal)) {
                text = text.split(secretVal).join('***');
            }
        }
        for (const k of PRIVATE_SD_URL_KEYS) {
            const rawUrl = String(sdSettings[k] || '').trim();
            if (!rawUrl) continue;
            const candidates = new Set([rawUrl, rawUrl.replace(/\/+$/, '')]);
            try {
                const parsed = new URL(rawUrl);
                if (parsed.origin && parsed.origin !== 'null') candidates.add(parsed.origin);
                if (parsed.host) candidates.add(parsed.host);
                if (parsed.hostname) candidates.add(parsed.hostname);
            } catch {
                // Non-URL literal is still stripped via exact rawUrl match above.
            }
            for (const cand of [...candidates].sort((a, b) => b.length - a.length)) {
                if (cand && text.includes(cand)) {
                    text = text.split(cand).join('***');
                }
            }
        }
    }
    return redact(text);
}

function resolveLatestSdRun(ctx) {
    const rec = ctx?.runPanel?.getRunRecorder?.();
    if (!rec) return null;
    const live = (rec.currents?.() || []).filter(r => r?.source === 'sd');
    const past = (rec.history?.() || []).filter(r => r?.source === 'sd');
    return live[0] || past[0] || null;
}

function detectBrokenConnectionProfile(ctx, sdSettings) {
    if (!sdSettings || typeof sdSettings !== 'object') return '';
    const activeGenPresetId = String(sdSettings.generationPresets?.currentId || '');
    const activeGenPreset = (sdSettings.generationPresets?.presets || []).find(p => p.id === activeGenPresetId);
    const boundName = String(
        activeGenPreset?.config?.connection_profile
        ?? sdSettings.connection_profile
        ?? '',
    ).trim();
    if (!boundName) return '';
    const list = ctx?.connectionProfiles?.list?.();
    if (!Array.isArray(list)) return '';
    const exists = list.some(p => String(p?.name || '').trim() === boundName);
    return exists ? '' : boundName;
}

function sanitizeRunForAsk(run) {
    if (!run) return null;
    const duration = Number.isFinite(run.endedAt) && Number.isFinite(run.startedAt)
        ? Math.max(0, run.endedAt - run.startedAt)
        : 0;
    return {
        runKey: run.runKey || `sd:${run.runId}`,
        runId: run.runId,
        status: run.status,
        durationMs: Math.round(duration),
        error: String(run.error || ''),
        rounds: (run.rounds || []).map(rd => ({
            id: rd.id,
            label: rd.label,
            status: rd.status,
            sections: (rd.sections || []).map(sec => ({
                kind: sec.kind,
                title: sec.title,
                status: sec.status,
                body: String(sec.body || ''),
            })),
        })),
    };
}

export async function buildSdSnapshot(ctx) {
    const sdSettings = ctx?.extensionSettings?.sd;
    if (!sdSettings || typeof sdSettings !== 'object') return null;

    const ill = sdSettings.illustration || {};
    const activeIllPreset = getPresetById(ill, ill.currentPresetId) || ill.presets?.[0] || null;
    let characterCount = 0;
    if (typeof ctx?.getGlobalState === 'function') {
        try {
            const profiles = await createCharacterProfileStore(ctx).listProfiles();
            characterCount = profiles.length;
        } catch {
            characterCount = 0;
        }
    }

    const latestRun = resolveLatestSdRun(ctx);
    const sanitizedRun = sanitizeRunForAsk(latestRun);
    const brokenConnectionProfile = detectBrokenConnectionProfile(ctx, sdSettings);

    return {
        installed: true,
        source: String(sdSettings.source || ''),
        model: String(sdSettings.model || ''),
        comfyWorkflow: sdSettings.source === 'comfy' ? String(sdSettings.comfy_workflow || '') : '',
        illustrationEnabled: Boolean(ill.enabled),
        autoGenerate: Boolean(ill.autoGenerate),
        activePresetName: String(activeIllPreset?.name || ''),
        characterCount,
        brokenConnectionProfile,
        lastRun: sanitizedRun,
    };
}

export function createSdAskProvider(getContext = () => globalThis.Luker?.getContext?.()) {
    return {
        id: 'sd',
        get label() { return i18n('Image Generation'); },
        tone: 'sd',
        icon: 'image',
        get overviewKey() { return i18n('Image Generation'); },
        order: 30,
        getSnapshot: (ctx) => buildSdSnapshot(ctx || getContext()),
        async getOverview(ctx) {
            const snap = await buildSdSnapshot(ctx || getContext());
            if (!snap) return i18n('Not present');
            return {
                Backend: [snap.source, snap.model, snap.comfyWorkflow].filter(Boolean).join(' · ') || '—',
                [i18n('Character Archive')]: snap.characterCount,
                Illustration: snap.illustrationEnabled ? 'on' : 'off',
            };
        },
        getSideInfo(pSnap) {
            return {
                label: i18n('Image Generation'),
                countText: pSnap ? `${pSnap.characterCount} chars` : '—',
                status: !pSnap ? 'warn' : (pSnap.brokenConnectionProfile ? 'bad' : 'ok'),
            };
        },
        renderHomeCard(pSnap, { status, askBtn, wsBtn, workspace }) {
            return {
                tone: 'sd',
                iconName: 'image',
                name: i18n('Image Generation'),
                by: pSnap
                    ? ([pSnap.source, pSnap.activePresetName].filter(Boolean).join(' · ') || i18n('Image Generation'))
                    : i18n('Image Generation'),
                pill: status('sd', Boolean(pSnap?.illustrationEnabled)),
                stats: pSnap ? [
                    [i18n('Character Archive'), String(pSnap.characterCount)],
                    pSnap.lastRun ? ['Last run', formatDuration(pSnap.lastRun.durationMs)] : null,
                ].filter(Boolean) : [],
                acts: [
                    pSnap ? askBtn('sd') : null,
                    workspace ? wsBtn(workspace) : null,
                ],
            };
        },
        tools: [{
            type: 'function',
            function: {
                name: 'wb_read_sd',
                description: 'Read redacted Image Generation & AI Illustration state (backend capabilities, prompt presets, archived character summaries, ComfyUI workflows, or latest run trace). Credentials and private endpoint URLs are never exposed.',
                parameters: {
                    type: 'object',
                    properties: {
                        part: {
                            type: 'string',
                            enum: ['summary', 'capabilities', 'presets', 'characters', 'workflows', 'last_run'],
                            description: 'Section to inspect. Defaults to summary.',
                        },
                    },
                    additionalProperties: false,
                },
            },
        }],
        readers: {
            wb_read_sd: async ({ part = 'summary' } = {}, ctx) => {
                const c = ctx || getContext();
                const sdSettings = c?.extensionSettings?.sd;
                if (!sdSettings || typeof sdSettings !== 'object') {
                    return { error: 'Image Generation settings are unavailable.' };
                }

                if (part === 'capabilities') {
                    // Explicitly pick only source/model/comfy_type so zero auth or private URL fields enter capabilities.
                    return computeImageCapabilities({
                        source: sdSettings.source,
                        model: sdSettings.model,
                        comfy_type: sdSettings.comfy_type,
                    });
                }

                if (part === 'presets') {
                    const presets = Array.isArray(sdSettings.illustration?.presets)
                        ? sdSettings.illustration.presets
                        : [];
                    return presets.map(p => ({
                        id: String(p.id || ''),
                        name: String(p.name || ''),
                        visualInspection: Boolean(p.visualInspection),
                        illustrationPrompt: redactSdString(p.illustrationPrompt, sdSettings),
                        studioPrompt: redactSdString(p.studioPrompt, sdSettings),
                        explorationPrompt: redactSdString(p.explorationPrompt, sdSettings),
                    }));
                }

                if (part === 'characters') {
                    if (typeof c?.getGlobalState !== 'function') return [];
                    const list = await createCharacterProfileStore(c).listProfiles();
                    return list.map(ch => ({
                        id: ch.id,
                        name: ch.name,
                        aliases: ch.aliases,
                        sourceWork: ch.sourceWork,
                        canonicalTags: ch.canonicalTags,
                        negativeTags: ch.negativeTags,
                        proseDescription: ch.proseDescription,
                        defaultOutfitId: ch.defaultOutfitId,
                        outfits: (ch.outfits || []).map(o => ({
                            id: o.id,
                            name: o.name,
                            tags: o.tags,
                            referenceCount: (o.referenceImages || []).length,
                        })),
                    }));
                }

                if (part === 'workflows') {
                    const workflows = await fetchDiskWorkflows(c);
                    const activeWorkflow = String(sdSettings.comfy_workflow || '');
                    return {
                        activeWorkflow,
                        placeholders: Array.isArray(sdSettings.comfy_placeholders)
                            ? sdSettings.comfy_placeholders.map(p => ({
                                find: redactSdString(p?.find, sdSettings),
                                replace: redactSdString(p?.replace, sdSettings),
                            }))
                            : [],
                        workflows: workflows.map(wf => ({
                            fileName: wf.fileName,
                            isActive: wf.fileName === activeWorkflow,
                            topology: redactSdString(
                                formatWorkflowTopology(wf.fileName, wf.graph, {
                                    isActive: wf.fileName === activeWorkflow,
                                    rawError: wf.rawError,
                                }),
                                sdSettings,
                            ),
                        })),
                    };
                }

                if (part === 'last_run') {
                    return sanitizeRunForAsk(resolveLatestSdRun(c)) || { message: 'No sd runs recorded yet.' };
                }

                return await buildSdSnapshot(c);
            },
        },
    };
}

export function createSdSuggestRuleProvider(getContext = () => globalThis.Luker?.getContext?.()) {
    return {
        id: 'sd',
        tone: 'sd',
        rules: [
            {
                id: 'sd.missing-connection-profile',
                tone: 'sd',
                get name() { return i18n('Image Generation'); },
                get when() { return i18n('When the connection profile selected in Image Generation is deleted, requests fail until rebound'); },
                defaultOn: true,
                check(snap) {
                    const sd = snap?.sd || snap?.providers?.sd;
                    if (!sd?.brokenConnectionProfile) return null;
                    return {
                        text: i18nFormat('Bound connection profile "${0}" on image generation no longer exists', sd.brokenConnectionProfile),
                        why: i18n('When the connection profile selected in Image Generation is deleted, requests fail until rebound'),
                        source: i18n('Image Generation'),
                        sig: `missing:${sd.brokenConnectionProfile}`,
                        actions: [{
                            kind: 'ask',
                            label: i18n('Diagnose with AI'),
                            question: `Image generation is bound to deleted connection profile "${sd.brokenConnectionProfile}". Check wb_read_sd and explain which connection profile to select.`,
                        }],
                    };
                },
            },
            {
                id: 'sd.last-run-failed',
                tone: 'sd',
                get name() { return i18n('Latest image generation run failed'); },
                get when() { return i18n('Checks whether the most recent sd run ended in error'); },
                defaultOn: true,
                check(snap) {
                    const sd = snap?.sd || snap?.providers?.sd;
                    const run = sd?.lastRun;
                    if (!run || (run.status !== 'error' && run.status !== 'failed')) return null;
                    return {
                        text: i18n('Latest image generation run failed'),
                        why: run.error || run.status,
                        source: i18n('Image Generation'),
                        sig: `failed:${run.runKey}`,
                        actions: [
                            {
                                label: i18n('Run Traces'),
                                run: () => void getContext()?.workbench?.open?.({ ws: 'sd', subview: 'run', runKey: run.runKey }),
                            },
                            {
                                kind: 'ai',
                                ws: 'sd',
                                label: i18n('Diagnose with AI'),
                                prompt: `Diagnose failed image generation run ${run.runKey} (${run.error || run.status}) via sd_read_run and suggest fixes.`,
                            },
                        ],
                    };
                },
            },
        ],
    };
}
