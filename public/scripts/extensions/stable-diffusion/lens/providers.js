// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration } from '../../../lens-shared/util.js';
import { redact } from '../../../workbench/model/requests.js';
import { computeImageCapabilities } from '../capabilities.js';
import { createCharacterProfileStore } from '../character-archive/store.js';
import { formatWorkflowTopology } from '../comfy-workflow-graph.js';
import { getPresetById } from '../illustration/settings.js';
import { inspectReferenceSlots } from '../reference/workflow.js';
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

async function resolveSanitizedCapabilities(ctx, sdSettings) {
    const sanitizedStyleRefs = Array.isArray(sdSettings?.style_references)
        ? sdSettings.style_references
            .filter(entry => String(entry?.imagePath || '').trim())
            .map(entry => ({
                imagePath: redactSdString(entry.imagePath, sdSettings),
                strength: entry.strength,
            }))
        : [];
    // Explicitly pick only non-secret settings so zero auth or private URL fields enter capabilities.
    const sanitizedSettings = {
        source: sdSettings?.source,
        model: sdSettings?.model,
        comfy_type: sdSettings?.comfy_type,
        character_reference_enabled: sdSettings?.character_reference_enabled,
        character_reference_mode: sdSettings?.character_reference_mode,
        style_references_enabled: sdSettings?.style_references_enabled,
        img2img_enabled: sdSettings?.img2img_enabled,
        style_references: sanitizedStyleRefs,
    };

    const runtimeInfo = {
        comfyReferenceSlotCount: 0,
        comfyWorkflowError: '',
        availableLoras: undefined,
    };

    const imgApi = (
        ctx?.imageGeneration
        && (typeof ctx.imageGeneration.isAvailable !== 'function' || ctx.imageGeneration.isAvailable())
    )
        ? ctx.imageGeneration
        : ctx?.getExtensionApi?.('sd');

    if (typeof imgApi?.getCapabilities === 'function') {
        try {
            const liveCaps = await imgApi.getCapabilities();
            if (liveCaps && typeof liveCaps === 'object') {
                runtimeInfo.comfyReferenceSlotCount = Number(liveCaps.protocol?.comfyReferenceSlotCount || 0);
                runtimeInfo.comfyWorkflowError = liveCaps.protocol?.comfyWorkflowError
                    ? redactSdString(liveCaps.protocol.comfyWorkflowError, sdSettings)
                    : '';
                if (liveCaps.availableLoras) {
                    runtimeInfo.availableLoras = liveCaps.availableLoras;
                }
                return computeImageCapabilities(sanitizedSettings, runtimeInfo);
            }
        } catch {
            // Live service unavailable; fall through to direct workflow inspection below if needed.
        }
    }

    const source = String(sdSettings?.source || '').trim();
    const comfyType = String(sdSettings?.comfy_type || 'standard').trim() || 'standard';
    const wfName = String(sdSettings?.comfy_workflow || '').trim();
    if (source === 'comfy' && comfyType === 'standard' && wfName && typeof fetch === 'function') {
        try {
            const wfResp = await fetch('/api/sd/comfy/workflow', {
                method: 'POST',
                headers: ctx?.getRequestHeaders?.() || { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_name: wfName }),
            });
            if (wfResp.ok) {
                const rawWf = await wfResp.json();
                try {
                    runtimeInfo.comfyReferenceSlotCount = inspectReferenceSlots(rawWf).slotCount;
                } catch (wfErr) {
                    runtimeInfo.comfyWorkflowError = redactSdString(String(wfErr?.message || wfErr), sdSettings);
                }
            }
        } catch {
            // Unreachable or unmocked workflow endpoint in lightweight snapshot calls; keep slot count 0.
        }
    }

    return computeImageCapabilities(sanitizedSettings, runtimeInfo);
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
    const caps = await resolveSanitizedCapabilities(ctx, sdSettings);

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
        characterReferenceEnabled: caps.characterReferenceEnabled,
        characterReferenceMode: caps.characterReferenceMode,
        styleReferencesEnabled: caps.supportsStyleReference,
        img2imgEnabled: caps.supportsSourceImage,
        referenceWarnings: Array.isArray(caps.warnings) ? caps.warnings : [],
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
                [i18n('Backend')]: [snap.source, snap.model, snap.comfyWorkflow].filter(Boolean).join(' · ') || '—',
                [i18n('Character Archive')]: snap.characterCount,
                [i18n('AI Illustration')]: snap.illustrationEnabled ? i18n('Enabled') : i18n('Disabled'),
            };
        },
        getSideInfo(pSnap) {
            return {
                label: i18n('Image Generation'),
                countText: pSnap ? i18nFormat('${0} profile(s)', pSnap.characterCount) : '—',
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
                    pSnap.lastRun ? [i18n('Last run'), formatDuration(pSnap.lastRun.durationMs)] : null,
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
                    return await resolveSanitizedCapabilities(c, sdSettings);
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
                        description: redactSdString(ch.description, sdSettings),
                        referenceImageCount: (ch.referenceImages || []).length,
                        referenceImages: (ch.referenceImages || []).map(r => ({
                            path: r.path,
                            label: redactSdString(r.label, sdSettings),
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
                id: 'sd.reference-config-conflict',
                tone: 'sd',
                get name() { return i18n('Reference configuration conflict'); },
                get when() { return i18n('Checks whether active reference or img2img switches conflict with the current image backend or workflow'); },
                defaultOn: true,
                check(snap) {
                    const sd = snap?.sd || snap?.providers?.sd;
                    const warnings = Array.isArray(sd?.referenceWarnings) ? sd.referenceWarnings : [];
                    if (warnings.length === 0) return null;
                    const reasons = warnings
                        .map(w => i18n(String(w?.message || w?.code || '').trim()))
                        .filter(Boolean);
                    const sig = warnings.map(w => String(w?.code || '')).sort().join('|') || String(warnings.length);
                    return {
                        text: i18n('Reference settings conflict with the current image backend or workflow'),
                        why: reasons.join('\n'),
                        source: i18n('Image Generation'),
                        sig: `ref-conflict:${sig}`,
                        actions: [{
                            kind: 'ask',
                            label: i18n('Diagnose with AI'),
                            question: `Active image generation reference settings report configuration conflict(s): ${warnings.map(w => w?.code || '').filter(Boolean).join(', ')}. Inspect wb_read_sd (part: "capabilities" and "workflows") and explain how to resolve them.`,
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
