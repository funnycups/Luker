// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendShared, jsonOrText } from './shared.js';

const DATA_IMAGE_RE = /^data:image\/[^;,]+;base64,/i;

function sanitizeForTextChain(value) {
    if (typeof value === 'string') {
        if (DATA_IMAGE_RE.test(value)) {
            return '[image preview omitted from text chain]';
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeForTextChain);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = sanitizeForTextChain(v);
        }
        return out;
    }
    return value;
}

function appendVisualImages(parent, items) {
    const valid = (Array.isArray(items) ? items : []).filter(item => item && item.dataUrl);
    if (valid.length === 0) return;
    const grid = document.createElement('div');
    grid.className = 'luker-sim-image-grid';
    grid.setAttribute('data-sim-ignore', 'true');
    for (const item of valid) {
        const card = document.createElement('div');
        card.className = 'luker-sim-image-card';
        card.setAttribute('data-sim-ignore', 'true');
        const img = document.createElement('img');
        img.className = 'luker-sim-image';
        img.src = item.dataUrl;
        img.alt = String(item.alt || 'Simulated image preview');
        img.setAttribute('data-sim-ignore', 'true');
        card.appendChild(img);
        grid.appendChild(card);
    }
    parent.appendChild(grid);
}

function formatProfileSummaryText(profile) {
    const lines = [
        `id: ${profile?.id || ''}`,
        `name: ${profile?.name || ''}`,
    ];
    if (profile?.aliases?.length) lines.push(`aliases: ${profile.aliases.join(', ')}`);
    if (profile?.sourceWork) lines.push(`sourceWork: ${profile.sourceWork}`);
    if (profile?.description) lines.push(`description: ${profile.description}`);
    if (Array.isArray(profile?.referenceImages) && profile.referenceImages.length > 0) {
        lines.push('referenceImages:');
        for (const entry of profile.referenceImages) {
            const imagePath = typeof entry === 'string' ? entry.trim() : String(entry?.path || '').trim();
            const label = typeof entry === 'string' ? '' : String(entry?.label || '').trim();
            if (!imagePath) continue;
            lines.push(label ? `  - ${imagePath} (${label})` : `  - ${imagePath}`);
        }
    }
    return lines.join('\n');
}

function collectProfilePreviewImages(profile, imagePreviews = {}) {
    const out = [];
    for (const entry of Array.isArray(profile?.referenceImages) ? profile.referenceImages : []) {
        const imagePath = typeof entry === 'string' ? entry.trim() : String(entry?.path || '').trim();
        const label = typeof entry === 'string' ? '' : String(entry?.label || '').trim();
        if (!imagePath) continue;
        const dataUrl = imagePreviews[imagePath];
        if (dataUrl) {
            const baseAlt = profile?.name || profile?.id || 'Reference';
            out.push({ dataUrl, alt: label ? `${baseAlt} — ${label}` : baseAlt });
        }
    }
    return out;
}

function appendPreparedMessages(parent, preparedRequests, basePath, i18n) {
    const list = Array.isArray(preparedRequests) ? preparedRequests : [];
    list.forEach((entry, reqIdx) => {
        const record = entry?.record || entry;
        const body = record?.payload && typeof record.payload === 'object' ? record.payload : record;
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const rawPrompt = typeof body?.prompt === 'string' ? body.prompt : '';
        if (messages.length === 0 && !rawPrompt) return;
        const reqLabel = list.length > 1
            ? `${i18n('sim.section.assembled_prompt', 'Assembled Prompt')} #${reqIdx + 1}`
            : i18n('sim.section.assembled_prompt', 'Assembled Prompt');
        const reqPath = `${basePath} → ${reqLabel}`;
        const reqSec = appendShared.subsection(parent, reqLabel, reqPath, { collapsedByDefault: true });
        if (messages.length === 0 && rawPrompt) {
            appendShared.pre(reqSec, jsonOrText(sanitizeForTextChain(rawPrompt)));
            return;
        }
        messages.forEach((msg, msgIdx) => {
            const role = String(msg?.role || 'unknown');
            const msgPath = `${reqPath} → ${role} #${msgIdx + 1}`;
            const msgSec = appendShared.subsubsection(reqSec, `${role} #${msgIdx + 1}`, msgPath, { collapsedByDefault: true });
            if (Array.isArray(msg?.content)) {
                const visualParts = [];
                const textParts = [];
                for (const part of msg.content) {
                    if (part?.type === 'image_url' && part.image_url?.url) {
                        if (DATA_IMAGE_RE.test(part.image_url.url)) {
                            visualParts.push({ dataUrl: part.image_url.url, alt: `${role} #${msgIdx + 1} multimodal image` });
                            textParts.push('[image_url rendered visually]');
                        } else {
                            textParts.push(`[image_url: ${part.image_url.url}]`);
                        }
                    } else if (part?.type === 'text') {
                        textParts.push(String(part.text ?? ''));
                    } else {
                        textParts.push(jsonOrText(sanitizeForTextChain(part)));
                    }
                }
                appendVisualImages(msgSec, visualParts);
                appendShared.pre(msgSec, textParts.join('\n'));
            } else {
                appendShared.pre(msgSec, jsonOrText(sanitizeForTextChain(msg?.content ?? '')));
            }
        });
    });
}

function appendToolCallBlock(parent, tc, index, roundPath, i18n) {
    const tcPath = `${roundPath} → Tool #${index + 1} (${tc.name || 'tool'})`;
    const tcSec = appendShared.subsection(parent, `Tool #${index + 1}: ${tc.name || 'tool'}`, null, { collapsedByDefault: true });
    const argsSec = appendShared.subsubsection(tcSec, i18n('sim.label.args', 'args'), `${tcPath} → args`, { collapsedByDefault: true });
    appendShared.pre(argsSec, jsonOrText(sanitizeForTextChain(tc.args ?? {})));
    const resSec = appendShared.subsubsection(tcSec, i18n('sim.label.result', 'result'), `${tcPath} → result`, { collapsedByDefault: true });
    appendShared.pre(resSec, jsonOrText(sanitizeForTextChain(tc.result ?? '')));
    if (Array.isArray(tc.subTrace) && tc.subTrace.length > 0) {
        const subSec = appendShared.subsubsection(tcSec, 'Exploration Sub-trace', `${tcPath} → subTrace`, { collapsedByDefault: true });
        for (const event of tc.subTrace) {
            if (event?.type === 'visual_preview' && event.dataUrl) {
                appendVisualImages(subSec, [{ dataUrl: event.dataUrl, alt: event.imagePath || 'Visual preview' }]);
            }
        }
        appendShared.pre(subSec, jsonOrText(sanitizeForTextChain(tc.subTrace)));
    }
}

export function renderSdIllustration(payload, i18n = (_k, fb) => fb || _k) {
    const root = document.createElement('div');
    root.className = 'luker-sim-review luker-sim-review--sd-illustration';

    const outSec = appendShared.section(
        root,
        i18n('sim.section.final_output', 'Final Output'),
        'Final Output',
        { isFinalOutput: true },
    );
    const presetMeta = payload?.preset
        ? `Preset: ${payload.preset.name || payload.preset.id} (${payload.preset.id || ''})`
        : 'Preset: (unspecified)';
    const scopeMeta = `Scope: ${payload?.inputSnapshot?.scope || 'unknown'}`;
    appendShared.note(outSec, `${presetMeta} | ${scopeMeta}`);

    if (payload?.error) {
        appendShared.pre(outSec, `Simulation error: ${payload.error}`);
    }

    const illustrations = Array.isArray(payload?.illustrations) ? payload.illustrations : [];
    if (illustrations.length === 0) {
        if (payload?.failure) {
            const failLines = [];
            if (payload.failure.finishReason) failLines.push(`Finish reason: ${payload.failure.finishReason}`);
            if (payload.failure.assistantText) failLines.push(`Assistant output:\n${payload.failure.assistantText}`);
            if (Array.isArray(payload.failure.rejected) && payload.failure.rejected.length > 0) {
                failLines.push(`Rejected calls:\n${jsonOrText(sanitizeForTextChain(payload.failure.rejected))}`);
            }
            appendShared.pre(outSec, failLines.join('\n\n') || 'No image prompts were accepted.');
        } else if (!payload?.error) {
            appendShared.note(outSec, 'No illustrations were produced.');
        }
    } else {
        illustrations.forEach((item, idx) => {
            const label = `Illustration #${idx + 1}`;
            const path = `Final Output → ${label}`;
            const sec = appendShared.subsection(outSec, label, path);
            if (item.dataUrl) {
                appendVisualImages(sec, [{ dataUrl: item.dataUrl, alt: item.prompt || label }]);
            }
            const lines = [
                `Status: ${item.status || 'ready'}`,
                `Anchor: …${item.insertAfter || ''} ➔ [${label}] ➔ ${item.insertBefore || ''}…`,
                `Prompt: ${item.prompt || ''}`,
            ];
            if (item.negativePrompt) lines.push(`Negative prompt: ${item.negativePrompt}`);
            if (item.aspectRatio) lines.push(`Aspect ratio: ${item.aspectRatio}`);
            if (Array.isArray(item.loras) && item.loras.length > 0) {
                lines.push(`LoRAs: ${item.loras.map(l => (l.weight !== undefined ? `${l.name}:${l.weight}` : l.name)).join(', ')}`);
            }
            if (Array.isArray(item.characterRefs) && item.characterRefs.length > 0) {
                lines.push(`Referenced profiles: ${item.characterRefs.map(r => {
                    const id = r.profileId || r.profile_id || '';
                    const paths = Array.isArray(r.imagePaths ?? r.image_paths) ? (r.imagePaths ?? r.image_paths) : [];
                    return paths.length > 0 ? `${id} (${paths.join(', ')})` : id;
                }).join(', ')}`);
            }
            if (Array.isArray(item.references) && item.references.length > 0) {
                lines.push(`Reference assets: ${item.references.map(r => `${r.role || 'character'}:${r.imagePath || ''}`).join(', ')}`);
            }
            if (item.previewError) lines.push(`Preview error: ${item.previewError}`);
            if (item.error) lines.push(`Error: ${item.error}`);
            appendShared.pre(sec, lines.join('\n'));
        });
    }

    const previewErrors = payload?.previewErrors && typeof payload.previewErrors === 'object'
        ? Object.entries(payload.previewErrors).filter(([, msg]) => Boolean(msg))
        : [];
    if (previewErrors.length > 0) {
        appendShared.pre(
            outSec,
            `Preview read errors:\n${previewErrors.map(([imgPath, msg]) => `${imgPath}: ${msg}`).join('\n')}`,
        );
    }

    const savedProfiles = Array.isArray(payload?.savedProfiles) ? payload.savedProfiles : [];
    if (savedProfiles.length > 0) {
        const profSec = appendShared.subsection(
            outSec,
            i18n('sim.section.sd_saved_profiles', 'Sandbox Character Profiles'),
            'Final Output → Sandbox Character Profiles',
        );
        for (const profile of savedProfiles) {
            appendVisualImages(profSec, collectProfilePreviewImages(profile, payload?.imagePreviews));
            appendShared.pre(profSec, formatProfileSummaryText(profile));
        }
    }

    if (payload?.inputSnapshot) {
        const snapSec = appendShared.section(
            root,
            i18n('sim.section.sd_input_snapshot', 'Input Snapshot'),
            'Input Snapshot',
            { collapsedByDefault: true },
        );
        appendShared.pre(snapSec, jsonOrText(sanitizeForTextChain(payload.inputSnapshot)));
    }

    const rounds = Array.isArray(payload?.trace?.rounds) ? payload.trace.rounds : [];
    if (rounds.length > 0) {
        const traceSec = appendShared.section(
            root,
            i18n('sim.section.sd_rounds', 'Agent Rounds & Tool Trace'),
            null,
            { collapsedByDefault: true },
        );
        rounds.forEach((round, idx) => {
            const roundLabel = `Round ${round.roundIndex ?? idx + 1}`;
            const rSec = appendShared.subsection(traceSec, roundLabel, null, { collapsedByDefault: true });
            if (round.reasoning) {
                const reasSec = appendShared.subsubsection(rSec, i18n('sim.label.reasoning', 'Reasoning'), `${roundLabel} → Reasoning`, { collapsedByDefault: true });
                appendShared.pre(reasSec, round.reasoning);
            }
            if (round.assistantText) {
                const asstSec = appendShared.subsubsection(rSec, i18n('sim.label.assistant', 'Assistant'), `${roundLabel} → Assistant`, { collapsedByDefault: true });
                appendShared.pre(asstSec, round.assistantText);
            }
            (Array.isArray(round.toolCalls) ? round.toolCalls : []).forEach((tc, tcIdx) => {
                appendToolCallBlock(rSec, tc, tcIdx, roundLabel, i18n);
            });
            appendPreparedMessages(rSec, round.preparedRequests, roundLabel, i18n);
        });
    }

    return root;
}

export function renderSdExploration(payload, i18n = (_k, fb) => fb || _k) {
    const root = document.createElement('div');
    root.className = 'luker-sim-review luker-sim-review--sd-exploration';

    const mode = String(payload?.mode || 'background');
    const imagePreviews = payload?.imagePreviews || {};

    const outSec = appendShared.section(
        root,
        i18n('sim.section.final_output', 'Final Output'),
        'Final Output',
        { isFinalOutput: true },
    );
    const presetMeta = payload?.preset
        ? `Preset: ${payload.preset.name || payload.preset.id} (${payload.preset.id || ''})`
        : 'Preset: (unspecified)';
    const sourceMeta = payload?.inputSnapshot?.source
        ? `Source: ${payload.inputSnapshot.source.kind || 'none'}${payload.inputSnapshot.source.card_avatar ? ` (${payload.inputSnapshot.source.card_avatar})` : ''}`
        : 'Source: none';
    appendShared.note(outSec, `Mode: ${mode} | ${presetMeta} | ${sourceMeta}`);

    if (payload?.error) {
        appendShared.pre(outSec, `Simulation error: ${payload.error}`);
    }

    const expPreviewErrors = payload?.previewErrors && typeof payload.previewErrors === 'object'
        ? Object.entries(payload.previewErrors).filter(([, msg]) => Boolean(msg))
        : [];
    if (expPreviewErrors.length > 0) {
        appendShared.pre(
            outSec,
            `Preview read errors:\n${expPreviewErrors.map(([imgPath, msg]) => `${imgPath}: ${msg}`).join('\n')}`,
        );
    }

    if (mode === 'dialog') {
        if (payload?.finalDraft) {
            const draftSec = appendShared.subsection(
                outSec,
                i18n('sim.section.sd_draft_profile', 'Sandbox Profile Draft'),
                'Final Output → Sandbox Profile Draft',
            );
            appendVisualImages(draftSec, collectProfilePreviewImages(payload.finalDraft, imagePreviews));
            appendShared.pre(draftSec, formatProfileSummaryText(payload.finalDraft));
            if (Array.isArray(payload.conflicts) && payload.conflicts.length > 0) {
                appendShared.pre(draftSec, `Unresolved conflicts:\n${jsonOrText(sanitizeForTextChain(payload.conflicts))}`);
            }
        }
        const turns = Array.isArray(payload?.turns) ? payload.turns : [];
        if (turns.length > 0) {
            const convSec = appendShared.subsection(
                outSec,
                i18n('sim.section.sd_conversation', 'Simulated Conversation'),
                'Final Output → Simulated Conversation',
            );
            turns.forEach((turn, idx) => {
                const turnLabel = `Turn ${turn.turnIndex ?? idx + 1}`;
                const tSec = appendShared.subsubsection(convSec, turnLabel, `Final Output → ${turnLabel}`);
                const turnImages = [];
                for (const gen of turn.trace?.generatedImages || []) {
                    if (gen?.imagePath && imagePreviews[gen.imagePath]) {
                        turnImages.push({ dataUrl: imagePreviews[gen.imagePath], alt: gen.prompt || gen.imagePath });
                    }
                }
                for (const fetched of turn.trace?.fetchedImages || []) {
                    if (fetched?.imagePath && imagePreviews[fetched.imagePath]) {
                        turnImages.push({ dataUrl: imagePreviews[fetched.imagePath], alt: fetched.imagePath });
                    }
                }
                appendVisualImages(tSec, turnImages);
                appendShared.pre(tSec, [
                    `User: ${turn.userText || ''}`,
                    `Assistant: ${turn.assistantText || ''}`,
                ].join('\n\n'));
            });
        }
    } else {
        const savedProfiles = Array.isArray(payload?.savedProfiles) ? payload.savedProfiles : [];
        if (savedProfiles.length > 0) {
            const profSec = appendShared.subsection(
                outSec,
                i18n('sim.section.sd_saved_profiles', 'Sandbox Character Profiles'),
                'Final Output → Sandbox Character Profiles',
            );
            for (const profile of savedProfiles) {
                appendVisualImages(profSec, collectProfilePreviewImages(profile, imagePreviews));
                appendShared.pre(profSec, formatProfileSummaryText(profile));
            }
        }
        if (payload?.finalText) {
            appendShared.pre(outSec, payload.finalText);
        } else if (savedProfiles.length === 0 && !payload?.error) {
            appendShared.note(outSec, 'No character profiles were saved in sandbox.');
        }
    }

    if (payload?.inputSnapshot) {
        const snapSec = appendShared.section(
            root,
            i18n('sim.section.sd_input_snapshot', 'Input Snapshot'),
            'Input Snapshot',
            { collapsedByDefault: true },
        );
        appendShared.pre(snapSec, jsonOrText(sanitizeForTextChain(payload.inputSnapshot)));
    }

    const traceSec = appendShared.section(
        root,
        i18n('sim.section.sd_rounds', 'Agent Rounds & Tool Trace'),
        null,
        { collapsedByDefault: true },
    );

    if (mode === 'dialog') {
        const turns = Array.isArray(payload?.turns) ? payload.turns : [];
        turns.forEach((turn, tIdx) => {
            const turnLabel = `Turn ${turn.turnIndex ?? tIdx + 1}`;
            const rounds = Array.isArray(turn?.trace?.rounds) ? turn.trace.rounds : [];
            rounds.forEach((round, rIdx) => {
                const roundLabel = `${turnLabel} · Round ${round.roundIndex ?? rIdx + 1}`;
                const rSec = appendShared.subsection(traceSec, roundLabel, null, { collapsedByDefault: true });
                if (round.reasoning) {
                    const reasSec = appendShared.subsubsection(rSec, i18n('sim.label.reasoning', 'Reasoning'), `${roundLabel} → Reasoning`, { collapsedByDefault: true });
                    appendShared.pre(reasSec, round.reasoning);
                }
                if (round.assistantText) {
                    const asstSec = appendShared.subsubsection(rSec, i18n('sim.label.assistant', 'Assistant'), `${roundLabel} → Assistant`, { collapsedByDefault: true });
                    appendShared.pre(asstSec, round.assistantText);
                }
                (Array.isArray(round.toolResults) ? round.toolResults : []).forEach((tc, tcIdx) => {
                    appendToolCallBlock(rSec, tc, tcIdx, roundLabel, i18n);
                });
                const previews = Array.isArray(round.visualPreviews) ? round.visualPreviews : [];
                if (previews.length > 0) {
                    const visSec = appendShared.subsubsection(rSec, i18n('sim.section.sd_visual_previews', 'Visual Inspection Previews'), `${roundLabel} → Visual Previews`, { collapsedByDefault: true });
                    appendVisualImages(visSec, previews.filter(p => p.dataUrl).map(p => ({ dataUrl: p.dataUrl, alt: p.imagePath })));
                    appendShared.pre(visSec, jsonOrText(sanitizeForTextChain(previews)));
                }
            });
            appendPreparedMessages(traceSec, turn?.trace?.preparedRequests, turnLabel, i18n);
        });
    } else {
        const rounds = Array.isArray(payload?.trace?.rounds) ? payload.trace.rounds : [];
        rounds.forEach((round, rIdx) => {
            const roundLabel = `Round ${round.roundIndex ?? rIdx + 1}`;
            const rSec = appendShared.subsection(traceSec, roundLabel, null, { collapsedByDefault: true });
            if (round.reasoning) {
                const reasSec = appendShared.subsubsection(rSec, i18n('sim.label.reasoning', 'Reasoning'), `${roundLabel} → Reasoning`, { collapsedByDefault: true });
                appendShared.pre(reasSec, round.reasoning);
            }
            if (round.assistantText) {
                const asstSec = appendShared.subsubsection(rSec, i18n('sim.label.assistant', 'Assistant'), `${roundLabel} → Assistant`, { collapsedByDefault: true });
                appendShared.pre(asstSec, round.assistantText);
            }
            (Array.isArray(round.toolCalls) ? round.toolCalls : []).forEach((tc, tcIdx) => {
                appendToolCallBlock(rSec, tc, tcIdx, roundLabel, i18n);
            });
            const previews = Array.isArray(round.visualPreviews) ? round.visualPreviews : [];
            if (previews.length > 0) {
                const visSec = appendShared.subsubsection(rSec, i18n('sim.section.sd_visual_previews', 'Visual Inspection Previews'), `${roundLabel} → Visual Previews`, { collapsedByDefault: true });
                appendVisualImages(visSec, previews.filter(p => p.dataUrl).map(p => ({ dataUrl: p.dataUrl, alt: p.imagePath })));
                appendShared.pre(visSec, jsonOrText(sanitizeForTextChain(previews)));
            }
            appendPreparedMessages(rSec, round.preparedRequests, roundLabel, i18n);
        });
    }

    return root;
}
