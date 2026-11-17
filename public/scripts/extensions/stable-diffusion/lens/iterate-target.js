// SPDX-License-Identifier: AGPL-3.0-or-later

import { h } from '../../../lens-shared/util.js';
import {
    LOREBOOK_READ_TOOL_DEFS,
    isLorebookReadTool,
    runLorebookReadTool,
} from '../../../iteration-library/tools/lorebook-reads.js';
import { SourceError } from '../../../workbench/model/errors.js';
import {
    clone,
    commitFields,
    fieldPlan,
    saveSettingsChecked,
} from '../../../workbench/model/patch.js';
import { diffUnits } from '../../../workbench/model/units.js';
import {
    CHARACTER_PROFILES_NAMESPACE,
    createCharacterProfileStore,
    normalizeCharacterProfile,
} from '../character-archive/store.js';
import { makeIllustrationId } from '../illustration/presets.js';
import { getPresetById } from '../illustration/settings.js';
import { i18n } from './i18n.js';

export const DEFAULT_SD_ITERATE_PROMPT = `You are a configuration and visual-archive editor for Luker's Image Generation and AI Illustration system.

Capabilities:
- Inspect and refine AI illustration prompt presets (illustrationPrompt, studioPrompt, explorationPrompt, visualInspection) via sd_list_presets, sd_read_preset, and sd_update_preset.
- Inspect and refine character visual archive entries (canonicalTags, negativeTags, proseDescription, outfits) via sd_list_characters, sd_read_character, sd_upsert_character, and sd_delete_character.
- Read bound lorebooks via world_book_list, lorebook_list, lorebook_query, and lorebook_get when aligning character visual tags with worldbuilding canon.
- Inspect recent image/illustration run traces and errors via sd_read_run when diagnosing failed runs or anchor issues.

All edits update a reviewable draft first; explain your diagnosis and adjustments concisely.`;

const READ_TOOL_NAMES = new Set([
    'sd_list_presets',
    'sd_read_preset',
    'sd_list_characters',
    'sd_read_character',
    'sd_read_run',
]);

const SD_ITERATE_TOOLS = Object.freeze([
    {
        type: 'function',
        function: {
            name: 'sd_list_presets',
            description: 'List all AI illustration prompt presets in the working draft.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_read_preset',
            description: 'Read full prompt text and options of a specific AI illustration preset.',
            parameters: {
                type: 'object',
                properties: {
                    preset_id: { type: 'string', description: 'Preset id from sd_list_presets.' },
                },
                required: ['preset_id'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_list_characters',
            description: 'List compact summaries of all character profiles in the working draft.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_read_character',
            description: 'Read full tags, prose, and outfits of a character profile in the working draft.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Character profile id.' },
                },
                required: ['id'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_read_run',
            description: 'Read a live or historical image generation / illustration run trace for diagnosis.',
            parameters: {
                type: 'object',
                properties: {
                    run_key: { type: 'string', description: 'Optional composite runKey such as sd:1. Omit to read the latest sd run.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_update_preset',
            description: 'Update prompt fields or visualInspection on an existing illustration preset in the draft.',
            parameters: {
                type: 'object',
                properties: {
                    preset_id: { type: 'string' },
                    name: { type: 'string' },
                    illustration_prompt: { type: 'string' },
                    studio_prompt: { type: 'string' },
                    character_design_prompt: { type: 'string' },
                    exploration_prompt: { type: 'string' },
                    visual_inspection: { type: 'boolean' },
                },
                required: ['preset_id'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_upsert_character',
            description: 'Create or update a character visual profile in the draft.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    aliases: { type: 'array', items: { type: 'string' } },
                    source_work: { type: 'string' },
                    canonical_tags: { type: 'array', items: { type: 'string' } },
                    negative_tags: { type: 'array', items: { type: 'string' } },
                    prose_description: { type: 'string' },
                    outfits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                                tags: { type: 'array', items: { type: 'string' } },
                                prose: { type: 'string' },
                                referenceImages: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['name'],
                            additionalProperties: false,
                        },
                    },
                    default_outfit_id: { type: 'string' },
                },
                required: ['name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_delete_character',
            description: 'Remove a character visual profile from the draft.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                },
                required: ['id'],
                additionalProperties: false,
            },
        },
    },
]);

function formatPresetUnitText(fields) {
    const lines = [
        `name: ${fields.name || ''}`,
        `visualInspection: ${Boolean(fields.visualInspection)}`,
        `--- illustrationPrompt ---\n${fields.illustrationPrompt || ''}`,
        `--- studioPrompt ---\n${fields.studioPrompt || ''}`,
    ];
    if (fields.characterDesignPrompt) {
        lines.push(`--- characterDesignPrompt ---\n${fields.characterDesignPrompt}`);
    }
    if (fields.explorationPrompt) {
        lines.push(`--- explorationPrompt ---\n${fields.explorationPrompt}`);
    }
    return lines.join('\n');
}

function formatCharacterUnitText(fields) {
    const outfitLines = (fields.outfits || []).map(o => (
        `  - ${o.id}: ${o.name} | tags=[${(o.tags || []).join(', ')}] | refs=${(o.referenceImages || []).length}`
    ));
    return [
        `name: ${fields.name || ''}`,
        fields.aliases?.length ? `aliases: ${fields.aliases.join(', ')}` : '',
        fields.sourceWork ? `work: ${fields.sourceWork}` : '',
        `canonicalTags: [${(fields.canonicalTags || []).join(', ')}]`,
        fields.negativeTags?.length ? `negativeTags: [${fields.negativeTags.join(', ')}]` : '',
        fields.proseDescription ? `prose: ${fields.proseDescription}` : '',
        `defaultOutfitId: ${fields.defaultOutfitId || ''}`,
        'outfits:',
        ...outfitLines,
    ].filter(Boolean).join('\n');
}

export function buildSdUnits(doc) {
    const map = new Map();
    for (const preset of Array.isArray(doc?.presets) ? doc.presets : []) {
        if (!preset?.id) continue;
        const fields = {
            name: String(preset.name || ''),
            illustrationPrompt: String(preset.illustrationPrompt || ''),
            studioPrompt: String(preset.studioPrompt || ''),
            characterDesignPrompt: String(preset.characterDesignPrompt || ''),
            explorationPrompt: String(preset.explorationPrompt || ''),
            visualInspection: Boolean(preset.visualInspection),
        };
        map.set(`preset:${preset.id}`, {
            key: `preset:${preset.id}`,
            label: fields.name || preset.id,
            group: i18n('Preset'),
            fields,
            text: formatPresetUnitText(fields),
        });
    }
    for (const char of Array.isArray(doc?.characters) ? doc.characters : []) {
        if (!char?.id) continue;
        const fields = {
            name: String(char.name || ''),
            aliases: clone(char.aliases || []),
            sourceWork: String(char.sourceWork || ''),
            sourceCardAvatars: clone(char.sourceCardAvatars || []),
            canonicalTags: clone(char.canonicalTags || []),
            negativeTags: clone(char.negativeTags || []),
            proseDescription: String(char.proseDescription || ''),
            outfits: clone(char.outfits || []),
            defaultOutfitId: String(char.defaultOutfitId || ''),
        };
        map.set(`character:${char.id}`, {
            key: `character:${char.id}`,
            label: fields.name || char.id,
            group: i18n('Character Archive'),
            fields,
            text: formatCharacterUnitText(fields),
        });
    }
    return map;
}

function applyOpsToSdDoc(doc, ops) {
    const next = clone(doc || { presets: [], characters: [] });
    next.presets = Array.isArray(next.presets) ? next.presets : [];
    next.characters = Array.isArray(next.characters) ? next.characters : [];

    for (const op of ops) {
        if (op.key.startsWith('preset:')) {
            const id = op.key.slice('preset:'.length);
            if (op.kind === 'remove') {
                next.presets = next.presets.filter(p => p.id !== id);
                continue;
            }
            let target = next.presets.find(p => p.id === id);
            if (!target) {
                target = {
                    id,
                    name: id,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    illustrationPrompt: '',
                    studioPrompt: '',
                    characterDesignPrompt: '',
                    explorationPrompt: '',
                    llm: { apiPresetName: '', llmPresetName: '' },
                    explorationLlm: { apiPresetName: '', llmPresetName: '' },
                    visualInspection: false,
                };
                next.presets.push(target);
            }
            for (const c of op.changes) {
                target[c.field] = clone(c.after);
            }
            target.updatedAt = Date.now();
            continue;
        }

        if (op.key.startsWith('character:')) {
            const id = op.key.slice('character:'.length);
            if (op.kind === 'remove') {
                next.characters = next.characters.filter(ch => ch.id !== id);
                continue;
            }
            const idx = next.characters.findIndex(ch => ch.id === id);
            const raw = idx >= 0 ? { ...next.characters[idx] } : { id, name: id };
            for (const c of op.changes) {
                raw[c.field] = clone(c.after);
            }
            const normalized = normalizeCharacterProfile(raw);
            if (normalized) {
                if (idx >= 0) next.characters[idx] = normalized;
                else next.characters.push(normalized);
            }
        }
    }
    return next;
}

export function createSdIterateTarget(getContext = () => globalThis.Luker?.getContext?.()) {
    const resolveCtx = (override) => override || getContext();

    async function readDiskDoc(ctx) {
        const c = resolveCtx(ctx);
        const ill = c?.extensionSettings?.sd?.illustration;
        const presets = clone(Array.isArray(ill?.presets) ? ill.presets : []);
        const characters = typeof c?.getGlobalState === 'function'
            ? await createCharacterProfileStore(c).listProfiles()
            : [];
        return {
            presets,
            characters,
        };
    }

    return {
        id: 'sd',
        get label() { return i18n('Image Generation'); },
        tone: 'sd',
        order: 30,
        async scopes() {
            return { global: true };
        },
        getNativeAi() {
            const c = resolveCtx();
            const ill = c?.extensionSettings?.sd?.illustration;
            const preset = getPresetById(ill, ill?.currentPresetId) || ill?.presets?.[0];
            if (!preset) return null;
            return {
                connection: String(preset.llm?.apiPresetName || '').trim(),
                preset: String(preset.llm?.llmPresetName || '').trim(),
            };
        },
        async promptInfo() {
            return {
                from: `Luker · ${i18n('Image generation prompts & character archive')}`,
                custom: false,
                text: DEFAULT_SD_ITERATE_PROMPT,
            };
        },
        renderPreview({ base, ai }) {
            const changes = diffUnits(buildSdUnits(base), buildSdUnits(ai));
            if (!changes.length) return null;
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px' } },
                changes.map(ch => h('div', { class: 'sdlens-round-card' },
                    h('div', { style: { fontWeight: '600', fontSize: '12.5px' }, text: `${ch.group} · ${ch.label} (${ch.kind})` }),
                    h('pre', { class: 'sdlens-pre', text: ch.after || ch.before }))));
        },
        async load(_scope, ctx) {
            const live = await readDiskDoc(ctx);
            return {
                live,
                target: { scope: 'global' },
                title: i18n('Image generation prompts & character archive'),
            };
        },
        async prompt() {
            return DEFAULT_SD_ITERATE_PROMPT;
        },
        async tools() {
            return [
                ...SD_ITERATE_TOOLS.map(t => clone(t)),
                ...LOREBOOK_READ_TOOL_DEFS.map(t => clone(t)),
            ];
        },
        isRead: (name) => READ_TOOL_NAMES.has(name) || isLorebookReadTool(name),
        async runRead(call, live) {
            const c = resolveCtx();
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};

            if (isLorebookReadTool(name)) {
                const avatar = !c?.groupId ? String(c?.characters?.[c?.characterId]?.avatar || '') : '';
                const out = await runLorebookReadTool({ id: call?.id, name, args }, { context: c, avatar });
                if (!out?.ok) {
                    throw new SourceError('read', String(out?.error || 'Lorebook read failed'));
                }
                return out.result;
            }

            if (name === 'sd_list_presets') {
                return (live?.presets || []).map(p => ({
                    id: p.id,
                    name: p.name,
                    visualInspection: Boolean(p.visualInspection),
                }));
            }
            if (name === 'sd_read_preset') {
                const found = (live?.presets || []).find(p => p.id === String(args.preset_id || ''));
                if (!found) throw new SourceError('not_found', `Preset not found: ${args.preset_id}`);
                return clone(found);
            }
            if (name === 'sd_list_characters') {
                return (live?.characters || []).map(ch => ({
                    id: ch.id,
                    name: ch.name,
                    sourceWork: ch.sourceWork,
                    outfits: (ch.outfits || []).map(o => ({ id: o.id, name: o.name, refs: (o.referenceImages || []).length })),
                }));
            }
            if (name === 'sd_read_character') {
                const found = (live?.characters || []).find(ch => ch.id === String(args.id || ''));
                if (!found) throw new SourceError('not_found', `Character profile not found: ${args.id}`);
                return clone(found);
            }
            if (name === 'sd_read_run') {
                const recorder = c?.runPanel?.getRunRecorder?.();
                const all = [
                    ...(recorder?.currents?.() || []),
                    ...(recorder?.history?.() || []),
                ].filter(r => r?.source === 'sd');
                const key = String(args.run_key || '').trim();
                const found = key
                    ? all.find(r => r.runKey === key || `sd:${r.runId}` === key || String(r.runId) === key)
                    : all[0];
                return found ? clone(found) : { message: 'No matching sd run found.' };
            }
            throw new SourceError('unknown_tool', `Unknown read tool: ${name}`);
        },
        async runEdit(call, live) {
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const next = clone(live || { presets: [], characters: [] });

            if (name === 'sd_update_preset') {
                const target = (next.presets || []).find(p => p.id === String(args.preset_id || ''));
                if (!target) {
                    throw new SourceError('not_found', `Preset not found: ${args.preset_id}`);
                }
                if (args.name !== undefined) target.name = String(args.name);
                if (args.illustration_prompt !== undefined) target.illustrationPrompt = String(args.illustration_prompt);
                if (args.studio_prompt !== undefined) target.studioPrompt = String(args.studio_prompt);
                if (args.character_design_prompt !== undefined) target.characterDesignPrompt = String(args.character_design_prompt);
                if (args.exploration_prompt !== undefined) target.explorationPrompt = String(args.exploration_prompt);
                if (args.visual_inspection !== undefined) target.visualInspection = Boolean(args.visual_inspection);
                return next;
            }

            if (name === 'sd_upsert_character') {
                const id = String(args.id || '').trim() || makeIllustrationId('char');
                const existingIdx = (next.characters || []).findIndex(ch => ch.id === id);
                const prev = existingIdx >= 0 ? next.characters[existingIdx] : {};
                const merged = normalizeCharacterProfile({
                    ...prev,
                    id,
                    name: args.name ?? prev.name,
                    aliases: args.aliases ?? prev.aliases,
                    sourceWork: args.source_work ?? prev.sourceWork,
                    canonicalTags: args.canonical_tags ?? prev.canonicalTags,
                    negativeTags: args.negative_tags ?? prev.negativeTags,
                    proseDescription: args.prose_description ?? prev.proseDescription,
                    outfits: args.outfits ?? prev.outfits,
                    defaultOutfitId: args.default_outfit_id ?? prev.defaultOutfitId,
                });
                if (!merged) {
                    throw new SourceError('invalid_args', 'Character profile requires a non-empty name.');
                }
                if (existingIdx >= 0) next.characters[existingIdx] = merged;
                else next.characters.push(merged);
                return next;
            }

            if (name === 'sd_delete_character') {
                const id = String(args.id || '').trim();
                const beforeLen = next.characters.length;
                next.characters = next.characters.filter(ch => ch.id !== id);
                if (next.characters.length === beforeLen) {
                    throw new SourceError('not_found', `Character profile not found: ${id}`);
                }
                return next;
            }

            throw new SourceError('unknown_tool', `Unknown edit tool: ${name}`);
        },
        units: (live) => buildSdUnits(live),
        rebuild(base, ai, keys) {
            const ops = fieldPlan(buildSdUnits(base), buildSdUnits(ai), keys);
            return applyOpsToSdDoc(base, ops);
        },
        async commit(_targetRef, base, next, keys) {
            const c = resolveCtx();
            const ops = fieldPlan(buildSdUnits(base), buildSdUnits(next), keys);
            const touchesPresets = ops.some(op => op.key.startsWith('preset:'));
            const touchesCharacters = ops.some(op => op.key.startsWith('character:'));

            return await commitFields({
                read: () => readDiskDoc(c),
                units: buildSdUnits,
                apply: applyOpsToSdDoc,
                write: async (nextDoc) => {
                    if (touchesPresets) {
                        const ill = c?.extensionSettings?.sd?.illustration;
                        if (!ill) {
                            throw new SourceError('write-failed', 'Image Generation illustration settings are unavailable.');
                        }
                        ill.presets = clone(nextDoc.presets);
                        if (!ill.presets.some(p => p.id === ill.currentPresetId)) {
                            ill.currentPresetId = ill.presets[0]?.id || '';
                        }
                        await saveSettingsChecked(c);
                    }
                    if (touchesCharacters && typeof c?.updateGlobalState === 'function') {
                        const profilesObj = {};
                        for (const ch of nextDoc.characters || []) {
                            const clean = normalizeCharacterProfile(ch);
                            if (clean) profilesObj[clean.id] = clean;
                        }
                        const res = await c.updateGlobalState(CHARACTER_PROFILES_NAMESPACE, (cur) => ({
                            ...cur,
                            version: 1,
                            profiles: profilesObj,
                        }), { asyncDiff: false });
                        if (!res?.ok) {
                            throw new SourceError('write-failed', `Failed to write character archive: ${res?.hint || res?.reason || 'unknown'}`);
                        }
                    }
                },
            }, ops);
        },
    };
}
