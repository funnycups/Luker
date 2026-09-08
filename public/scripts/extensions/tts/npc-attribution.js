/**
 * TTS NPC dialogue attribution core module.
 *
 * Parses each message's quoted dialogue lines into speaker-attributed
 * segments via a single forced tool-call LLM round-trip, caches the
 * result in the floor-state store keyed by message id, and keeps the
 * provider voiceMap topped up with any discovered NPC names so the
 * settings panel (and the playback queue) can resolve their voices.
 */

import { extension_settings, getContext } from '../../extensions.js';
import { saveSettingsDebounced } from '../../../script.js';
import { getStringHash } from '../../utils.js';
import { requestToolCallWithRetry } from '../../lib/iter-tool-calling.js';
import { extractQuoteSegments } from './quote-segments.js';
import { enqueueSegmentPlayback, initVoiceMap } from './index.js';
import { translate } from '../../i18n.js';
import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';

const MODULE_NAME = 'tts-npc-attribution';
const STATE_NAMESPACE = 'tts';
const DEFAULT_VOICE_MARKER = '[Default Voice]';
const DISABLED_VOICE_MARKER = 'disabled';
const ATTRIBUTION_TOOL_NAME = 'report_dialogue_attribution';

export const ATTRIBUTION_TOOL_PARAMETERS = {
    type: 'object',
    required: ['segments'],
    properties: {
        segments: {
            type: 'array',
            items: {
                type: 'object',
                required: ['quote_text', 'speaker'],
                properties: {
                    quote_text: { type: 'string' },
                    speaker: { type: ['string', 'null'] },
                },
            },
        },
    },
    additionalProperties: false,
};

const ATTRIBUTION_SYSTEM_PROMPT = [
    'Attribute each quoted line of dialogue in the message to its speaker.',
    'Work only from textual evidence: surrounding narration, action text, and speaker tags.',
    'The message author is a valid speaker. Characters from the roster are valid speakers.',
    'If a name is not on the roster but the text clearly shows who spoke, return that name as written.',
    'When you cannot decide, set speaker to null. Do not guess.',
    'Return one segment per quoted line, in message order, with quote_text matching the quoted text.',
].join('\n');

function buildUserPrompt(context, attributionMap, message) {
    const roster = buildRoster(context, attributionMap);
    const recent = [];
    for (let i = context.chat.length - 3; i < context.chat.length - 1; i++) {
        if (i >= 0 && context.chat[i] && typeof context.chat[i].mes === 'string') {
            recent.push(`${context.chat[i].name ?? 'Unknown'}: ${context.chat[i].mes}`);
        }
    }
    return [
        `Author: ${message.name ?? 'Unknown'}`,
        `Roster: ${roster.join(', ')}`,
        recent.length ? `Recent:\n${recent.join('\n---\n')}` : 'Recent: (none)',
        `Message:\n${message.mes}`,
    ].join('\n\n');
}

let floorStatePromise = null;
const inFlightParses = new Set();
const warnedMessages = new Set();

export async function getFloorStateInstance(context) {
    if (!floorStatePromise) {
        if (typeof context?.createFloorState !== 'function') {
            throw new Error('[tts] createFloorState API is unavailable in extension context.');
        }
        floorStatePromise = context.createFloorState({ namespace: STATE_NAMESPACE })
            .catch((err) => {
                floorStatePromise = null;
                throw err;
            });
    }
    return floorStatePromise;
}

export function resetFloorStateInstanceForTesting() {
    floorStatePromise = null;
}

export async function loadAttributionMap(context) {
    try {
        const fs = await getFloorStateInstance(context);
        const readyResult = await fs.ready();
        if (readyResult && readyResult.ok === false) {
            console.warn(`[${MODULE_NAME}] floor-state ready failed (${readyResult.reason}): ${readyResult.hint}`);
            return {};
        }
        const getResult = await fs.get();
        if (!getResult.ok) {
            console.warn(`[${MODULE_NAME}] floor-state get failed (${getResult.reason}): ${getResult.hint}`);
            return {};
        }
        const data = getResult.state;
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
        console.warn(`[${MODULE_NAME}] floor-state unavailable, degrading to no cache`, error);
        return {};
    }
}

export function readAttributionFor(context, attributionMap, messageId) {
    const entry = attributionMap?.[String(messageId)];
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.segments)) {
        return null;
    }
    const message = Array.isArray(context?.chat) ? context.chat[messageId] : null;
    if (!message || typeof message.mes !== 'string') {
        return null;
    }
    if (getStringHash(message.mes) !== entry.mesHash) {
        return null;
    }
    return entry;
}

export async function commitAttribution(context, messageId, mesHash, segments) {
    const message = Array.isArray(context?.chat) ? context.chat[messageId] : null;
    if (!message) {
        return { ok: false, reason: 'message_missing' };
    }
    const swipeIdRaw = message.swipe_id;
    const swipeId = Number.isInteger(swipeIdRaw) && swipeIdRaw >= 0 ? swipeIdRaw : 0;
    const fs = await getFloorStateInstance(context);
    return fs.patch(
        [{ op: 'add', path: `/${messageId}`, value: { mesHash, segments } }],
        { floor: messageId, swipeId },
    );
}

export function alignAttribution(toolSegments, quoteWindow) {
    const tools = Array.isArray(toolSegments) ? toolSegments : [];
    return (Array.isArray(quoteWindow) ? quoteWindow : []).map((quote) => {
        let speaker = null;
        let matched = false;
        for (const tool of tools) {
            const quoteText = String(tool?.quote_text ?? '');
            if (quoteText.length === 0) continue;
            if (quoteText === quote.content) {
                speaker = tool.speaker ?? null;
                matched = true;
                break;
            }
        }
        if (!matched) {
            for (const tool of tools) {
                const quoteText = String(tool?.quote_text ?? '');
                if (quoteText.length === 0) continue;
                if (quoteText.includes(quote.content) || quote.content.includes(quoteText)) {
                    speaker = tool.speaker ?? null;
                    matched = true;
                    break;
                }
            }
        }
        return { qIndex: quote.qIndex, speaker: typeof speaker === 'string' && speaker.length > 0 ? speaker : null };
    });
}

export function buildRoster(context, attributionMap) {
    const names = [];
    if (context) {
        names.push(String(context.name1 ?? ''));
        if (context.groupId === null) {
            names.push(String(context.name2 ?? ''));
        } else {
            const group = context.groups?.find(group => context.groupId == group.id);
            for (const member of group?.members ?? []) {
                const character = (context.characters ?? []).find(char => char.avatar == member);
                if (character) {
                    names.push(character.name);
                }
            }
        }
    }
    // Names already managed in the voice map (manually pre-configured NPCs
    // and speakers the attribution pass discovered before) are legitimate
    // speaker candidates — hand them to the model so it can attribute
    // known NPCs instead of inventing fresh spellings.
    const providerName = extension_settings.tts.currentProvider;
    const providerVoiceMap = extension_settings.tts?.[providerName]?.voiceMap;
    if (providerVoiceMap && typeof providerVoiceMap === 'object' && !Array.isArray(providerVoiceMap)) {
        for (const key of Object.keys(providerVoiceMap)) {
            const bareName = key.includes(' (') ? key.slice(0, key.lastIndexOf(' (')) : key;
            names.push(bareName);
        }
    }
    for (const entry of Object.values(attributionMap ?? {})) {
        for (const segment of entry?.segments ?? []) {
            if (typeof segment?.speaker === 'string' && segment.speaker.length > 0) {
                names.push(segment.speaker);
            }
        }
    }
    return [...new Set(names.map(n => n.trim()).filter(n => n.length > 0 && n !== DEFAULT_VOICE_MARKER && n !== DISABLED_VOICE_MARKER))];
}

export async function ensureNpcVoiceMapEntries(providerName, names) {
    const providerSettings = extension_settings.tts?.[providerName];
    if (!providerSettings || typeof providerName !== 'string' || providerName.length === 0) {
        return [];
    }
    if (!providerSettings.voiceMap || typeof providerSettings.voiceMap !== 'object') {
        providerSettings.voiceMap = {};
    }
    const multiVoice = extension_settings.tts.multi_voice_enabled === true;
    const added = [];
    for (const rawName of Array.isArray(names) ? names : []) {
        const name = String(rawName ?? '').trim();
        if (!name || name === DEFAULT_VOICE_MARKER || name === DISABLED_VOICE_MARKER) continue;
        const keys = multiVoice ? [name, `${name} ("Quotes")`, `${name} (*Text inside asterisks*)`, `${name} (Other text)`] : [name];
        let fresh = false;
        for (const key of keys) {
            if (!(key in providerSettings.voiceMap)) {
                providerSettings.voiceMap[key] = DEFAULT_VOICE_MARKER;
                fresh = true;
            }
        }
        if (fresh) {
            added.push(name);
        }
    }
    if (added.length > 0) {
        saveSettingsDebounced();
        // Rebuild the panel + runtime voiceMap so the new keys are live for
        // the queue's segment path and visible as select rows. initVoiceMap
        // reads the provider voiceMap we just wrote (see panel-merge step in
        // Task 4 for why NPC rows survive the getCharacters rebuild).
        await initVoiceMap().catch((error) => {
            console.warn(`[${MODULE_NAME}] voiceMap panel refresh failed`, error);
        });
    }
    return added;
}

export async function parseAndCacheAttribution(context, messageId, { force = false } = {}) {
    const settings = extension_settings.tts;
    if (!settings.npcAttributionEnabled) return null;
    const message = Array.isArray(context?.chat) ? context.chat[messageId] : null;
    if (!message || typeof message.mes !== 'string') return null;

    const quoteWindow = extractQuoteSegments(message.mes);
    if (quoteWindow.length === 0) return null;

    const attributionMap = await loadAttributionMap(context);
    const cached = readAttributionFor(context, attributionMap, messageId);
    if (cached && !force) {
        return { segments: cached.segments, addedVoices: [] };
    }
    if (inFlightParses.has(messageId)) return null;
    inFlightParses.add(messageId);
    try {
        const mesHash = getStringHash(message.mes);
        const taskMessages = [
            { role: 'system', content: ATTRIBUTION_SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(context, attributionMap, message) },
        ];
        const args = await requestToolCallWithRetry(context, {
            toolCallRetryMax: settings.npcAttributionRetryMax,
            rpmLimit: 0,
        }, {
            taskMessages,
            apiPresetName: settings.npcAttributionApiPresetName || '',
            llmPresetName: settings.npcAttributionPresetName || '',
            functionName: ATTRIBUTION_TOOL_NAME,
            functionDescription: 'Report the speaker for each quoted line of dialogue in the message.',
            parameters: ATTRIBUTION_TOOL_PARAMETERS,
        });
        const segments = alignAttribution(Array.isArray(args?.segments) ? args.segments : [], quoteWindow);
        const commit = await commitAttribution(context, messageId, mesHash, segments);
        if (commit && commit.ok === false && !warnedMessages.has(messageId)) {
            warnedMessages.add(messageId);
            console.warn(`[${MODULE_NAME}] floor-state commit rejected for message ${messageId} (${commit.reason}): ${commit.hint}`);
        }
        const providerName = extension_settings.tts.currentProvider;
        const addedVoices = await ensureNpcVoiceMapEntries(providerName,
            segments.map(s => s.speaker).filter(s => typeof s === 'string' && s.length > 0));
        return { segments, addedVoices };
    } catch (error) {
        if (!warnedMessages.has(messageId)) {
            warnedMessages.add(messageId);
            console.warn(`[${MODULE_NAME}] parse failed for message ${messageId}`, error);
        }
        throw error;
    } finally {
        inFlightParses.delete(messageId);
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function getOpenAIPresetNames(context) {
    const manager = context.getPresetManager?.('openai');
    if (!manager || typeof manager.getAllPresets !== 'function') return [];
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) return [];
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

export function getTtsPresetOptions(context, selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getOpenAIPresetNames(context);
    const options = [`<option value="">${escapeHtml(translate('(Current preset)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(translate('(missing)'))}</option>`);
    }
    return options.join('');
}

export function getTtsConnectionOptions(selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getChatCompletionConnectionProfiles().map(profile => profile.name);
    const options = [`<option value="">${escapeHtml(translate('(Current API config)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(translate('(missing)'))}</option>`);
    }
    return options.join('');
}

export function renderTtsAttributionSelectors(context) {
    const apiSelect = $('#tts_npc_attribution_api_preset');
    const presetSelect = $('#tts_npc_attribution_preset');
    if (apiSelect.length) {
        apiSelect.html(getTtsConnectionOptions(extension_settings.tts.npcAttributionApiPresetName));
        apiSelect.val(String(extension_settings.tts.npcAttributionApiPresetName || '').trim());
    }
    if (presetSelect.length) {
        presetSelect.html(getTtsPresetOptions(context, extension_settings.tts.npcAttributionPresetName));
        presetSelect.val(String(extension_settings.tts.npcAttributionPresetName || '').trim());
    }
}

/**
 * Decorate every <q> in the message body with a small play button.
 * Idempotent — messages already decorated are left as-is.
 * @param {number} messageId chat array index
 */
export function decorateMessageWithPlayButtons(messageId) {
    const context = getContext();
    const message = Array.isArray(context?.chat) ? context.chat[messageId] : null;
    if (!message || typeof message.mes !== 'string') return;
    const mesBlock = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!mesBlock) return;
    const quoteNodes = mesBlock.querySelectorAll('q');
    if (quoteNodes.length === 0) return;
    const alreadyDecorated = mesBlock.querySelector('q .tts_q_play');
    if (alreadyDecorated) return;
    // Align DOM <q> nodes with the raw-text quote window by content, not
    // ordinal: messageFormatting masks quotes inside <...> tag attributes
    // (e.g. <font color="red">) before the <q> pass, so raw ordinal counts
    // can exceed the DOM count and shift every index after the gap. A
    // forward-only cursor keeps each button's data-qindex pointing at the
    // same window entry the click handler will re-extract from raw mes.
    const quoteWindow = extractQuoteSegments(message.mes);
    let cursor = 0;
    quoteNodes.forEach((quoteNode) => {
        const text = quoteNode.textContent;
        let matchedIndex = -1;
        for (let i = cursor; i < quoteWindow.length; i++) {
            if (quoteWindow[i].full === text) {
                matchedIndex = quoteWindow[i].qIndex;
                cursor = i + 1;
                break;
            }
        }
        if (matchedIndex === -1) return;
        const playButton = document.createElement('span');
        playButton.className = 'tts_q_play fa-solid fa-volume-high';
        playButton.dataset.qindex = String(matchedIndex);
        playButton.setAttribute('data-i18n', '[title]Play this line');
        playButton.setAttribute('title', translate('Play this line'));
        playButton.addEventListener('click', onInlinePlayButtonClick);
        quoteNode.appendChild(playButton);
    });
}

async function onInlinePlayButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    const mesBlock = button.closest('.mes');
    const messageId = Number(mesBlock?.getAttribute('mesid'));
    const qIndex = Number(button.dataset.qindex);
    const context = getContext();
    const message = Array.isArray(context?.chat) ? context.chat[messageId] : null;
    if (!message || !Number.isInteger(messageId) || !Number.isInteger(qIndex)) return;

    const quoteWindow = extractQuoteSegments(message.mes);
    const segment = quoteWindow.find(s => s.qIndex === qIndex);
    if (!segment) return;

    let speaker = null;
    if (extension_settings.tts.npcAttributionEnabled && extension_settings.tts.enabled) {
        const attributionMap = await loadAttributionMap(context);
        const entry = readAttributionFor(context, attributionMap, messageId);
        let matched = entry?.segments?.find(s => s.qIndex === qIndex)?.speaker;
        if (typeof matched === 'string' && matched.length > 0) {
            speaker = matched;
        } else if (entry === null) {
            // No valid cache for this message yet — wait for the lazy parse,
            // then retry the lookup once.
            const icon = button.className;
            button.className = 'tts_q_play fa-solid fa-spinner fa-spin';
            try {
                const parsed = await parseAndCacheAttribution(context, messageId);
                if (parsed) {
                    matched = parsed.segments.find(s => s.qIndex === qIndex)?.speaker;
                    if (typeof matched === 'string' && matched.length > 0) {
                        speaker = matched;
                    }
                }
            } catch (error) {
                if (!warnedMessages.has(messageId)) {
                    warnedMessages.add(messageId);
                    console.warn(`[tts] NPC attribution parse failed for message ${messageId}`, error);
                }
            } finally {
                button.className = icon;
            }
        }
    }

    enqueueSegmentPlayback(speaker ?? message.name, segment.content, message, messageId);
}
