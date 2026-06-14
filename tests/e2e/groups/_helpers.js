// Batch-10-local helpers for groups e2e suite.
//
// The shared writeCharacter() fixture ships a sidecar .json next to the
// PNG but the server reads character data exclusively from the PNG
// `chara`/`ccv3` chunks, so override.name / override.description never
// reach the running app — every fixture character ends up as the seed
// "Seraphina". For group rotation tests we need three distinct
// characters with stable, recognizable names, so we re-encode the PNG
// here via the same character-card-parser the server uses.
//
// We also wrap group-creation: the REST endpoint /api/groups/create
// accepts JSON directly, so we POST through the running server (after
// the UI has loaded) rather than driving the rather complex
// drag-and-drop UI in the "New Group" panel.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { write as writeCardToPng } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SEED_PNG = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');

/**
 * Write a real V2 character card embedded in a PNG (chara chunk).
 * The shared `writeCharacter()` only drops a sidecar JSON which the
 * server ignores; this helper re-encodes the PNG so the override name
 * actually shows up in `getContext().characters`.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} [opts.handle]
 * @param {string} opts.avatarFile  Target filename (.png)
 * @param {object} opts.card  Card fields (name, description, first_mes, ...)
 * @returns {string} avatarFile (== character avatar id in Luker)
 */
export function writeCharacterPng({ dataRoot, handle = 'default-user', avatarFile, card }) {
    const charsDir = resolve(dataRoot, handle, 'characters');
    mkdirSync(charsDir, { recursive: true });

    const seedBuf = readFileSync(SEED_PNG);
    // Build a v2-shaped card (both flat + nested data so any consumer path works).
    const flat = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: card.name,
        description: card.description ?? '',
        personality: card.personality ?? '',
        scenario: card.scenario ?? '',
        first_mes: card.first_mes ?? '',
        mes_example: card.mes_example ?? '',
        creator_notes: card.creator_notes ?? 'luker-e2e groups fixture',
        system_prompt: card.system_prompt ?? '',
        post_history_instructions: '',
        alternate_greetings: card.alternate_greetings ?? [],
        tags: card.tags ?? ['rp', 'fixture', 'groups'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: card.extensions ?? {},
        data: {
            name: card.name,
            description: card.description ?? '',
            personality: card.personality ?? '',
            scenario: card.scenario ?? '',
            first_mes: card.first_mes ?? '',
            mes_example: card.mes_example ?? '',
            creator_notes: card.creator_notes ?? 'luker-e2e groups fixture',
            system_prompt: card.system_prompt ?? '',
            post_history_instructions: '',
            alternate_greetings: card.alternate_greetings ?? [],
            tags: card.tags ?? ['rp', 'fixture', 'groups'],
            creator: 'luker-e2e',
            character_version: '1.0',
            extensions: card.extensions ?? {},
        },
    };

    const buf = writeCardToPng(seedBuf, JSON.stringify(flat));
    writeFileSync(resolve(charsDir, avatarFile), buf);
    return avatarFile;
}

/**
 * Trio of distinct RP characters for group-rotation tests. Each has a
 * different name + first_mes + system_prompt so the prompt going out
 * to the mock LLM identifies the speaker unambiguously.
 *
 * @param {string} dataRoot
 * @returns {{avatar: string, name: string}[]}
 */
export function seedThreeCartographers(dataRoot) {
    const trio = [
        {
            avatar: 'ash-cart.png',
            name: 'Ash Cartographer',
            description: 'Wind-bitten cartographer who has spent twelve seasons mapping the Bryn reefs. Speaks in clipped, careful sentences.',
            personality: 'Observant, dry-witted, slow to anger. Trusts the chart over the rumor.',
            scenario: 'Three watchers share the Bryn headland lantern through the long autumn nights.',
            first_mes: '*Ash unrolls the chart with a knuckle and weighs the corner with a brass spyglass.* "The reef is still settling. Sit, both of you — there will be plenty to read before dawn."',
            system_prompt: 'You are Ash Cartographer. Stay in scene. One to three paragraphs. Sign nothing.',
        },
        {
            avatar: 'rhonin-ward.png',
            name: 'Rhonin Warden',
            description: 'Coastal warden of the inner cove. Late forties, greying beard, generous with rules and stingy with praise.',
            personality: 'Quiet, exacting. Never raises his voice.',
            scenario: 'Three watchers share the Bryn headland lantern through the long autumn nights.',
            first_mes: '*Rhonin stamps the salt from his boots at the threshold and nods without breaking stride.* "Inner cove was unsettled at the third bell. I would value the chart\'s opinion before I write the night log."',
            system_prompt: 'You are Rhonin Warden. Stay in scene. One to three paragraphs. Sign nothing.',
        },
        {
            avatar: 'kestrel-naut.png',
            name: 'Kestrel Pilot',
            description: 'Younger river-pilot, two seasons into the Bryn watch rotation. Restless hands, careful voice. Carries a stub of charcoal for sketching shore-lights.',
            personality: 'Curious, deferential to elders, quick to volunteer.',
            scenario: 'Three watchers share the Bryn headland lantern through the long autumn nights.',
            first_mes: '*Kestrel ducks under the lintel, charcoal already smudged on her thumb.* "I can mark the south flares if either of you reads them off."',
            system_prompt: 'You are Kestrel Pilot. Stay in scene. One to three paragraphs. Sign nothing.',
        },
    ];
    for (const c of trio) {
        writeCharacterPng({
            dataRoot,
            avatarFile: c.avatar,
            card: {
                name: c.name,
                description: c.description,
                personality: c.personality,
                scenario: c.scenario,
                first_mes: c.first_mes,
                system_prompt: c.system_prompt,
            },
        });
    }
    return trio;
}

/**
 * Create a group with the given members via the running server's REST API.
 * activation_strategy=LIST(1) gives deterministic rotation in member order.
 * Caller is responsible for awaiting main UI before calling.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} opts
 * @param {string} opts.name
 * @param {string[]} opts.members   array of avatar filenames in rotation order
 * @param {number} [opts.activation_strategy] 0 NATURAL, 1 LIST, 2 MANUAL, 3 POOLED
 * @param {number} [opts.generation_mode]     0 SWAP, 1 APPEND, 2 APPEND_DISABLED
 * @param {boolean} [opts.allow_self_responses]
 * @returns {Promise<{id: string, name: string, members: string[], chat_id: string}>}
 */
export async function createGroupViaApi(page, opts) {
    return page.evaluate(async (o) => {
        const ctx = window.Luker.getContext();
        const headers = ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
        const chatName = `groups-e2e-${Date.now()}`;
        const body = {
            name: o.name,
            members: o.members,
            avatar_url: '',
            allow_self_responses: !!o.allow_self_responses,
            activation_strategy: o.activation_strategy ?? 1, // LIST → deterministic rotation
            generation_mode: o.generation_mode ?? 0,         // SWAP per-member
            disabled_members: o.disabled_members ?? [],
            fav: false,
            chat_id: chatName,
            chats: [chatName],
            auto_mode_delay: 5,
        };
        const res = await fetch('/api/groups/create', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`/api/groups/create failed: ${res.status}`);
        const created = await res.json();
        // Force ST to reload its groups+characters cache.
        await ctx.reloadCurrentChat?.();
        return created;
    }, opts);
}

/**
 * Open a freshly created group for chatting (selects it as the active
 * chat target). Mirrors what the UI's "select group" click would do.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} groupId
 */
export async function openGroupForChat(page, groupId) {
    await page.evaluate(async (id) => {
        const ctx = window.Luker.getContext();
        // Try the exposed openGroupChat first (jumps straight to chat).
        // If unavailable (older context), fall back to clicking the group card.
        if (typeof ctx.openGroupChat === 'function') {
            // We need to first force getCharacters() so groups[] is fresh.
            if (typeof ctx.getCharacters === 'function') {
                await ctx.getCharacters();
            }
        }
        // The most reliable entry-point: directly call openGroupById through
        // the dynamic import of group-chats.js.
        const mod = await import('/scripts/group-chats.js');
        if (typeof mod.openGroupById === 'function') {
            const opened = await mod.openGroupById(id);
            if (!opened) {
                console.warn('[groups-e2e] openGroupById returned false for', id);
            }
        } else {
            throw new Error('openGroupById not exposed from group-chats.js');
        }
    }, groupId);

    // Wait for selected_group to flip and the chat to be loaded.
    await page.waitForFunction((wantId) => {
        return new Promise(resolve => {
            const check = () => {
                // selected_group is module-private; the chat array name + chat_id are observable through context.
                const ctx = window.Luker.getContext();
                const chatId = ctx.getCurrentChatId?.();
                if (chatId) resolve(true);
                else setTimeout(check, 50);
            };
            check();
            setTimeout(() => resolve(false), 8000);
        });
    }, groupId, { timeout: 10_000 }).catch(() => {});
}

/**
 * Send a user message in a group and wait for the WHOLE rotation to
 * finish — listens for GROUP_WRAPPER_FINISHED (which only fires after
 * every activated member has spoken). Returns the assistant message
 * snapshot (slice from the moment the call started).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{messages: object[], chatLengthBefore: number}>}
 */
export async function sendUserAndAwaitGroupTurn(page, text, { timeoutMs = 120_000 } = {}) {
    const lengthBefore = await page.evaluate(() => window.Luker.getContext().chat?.length || 0);
    const wrapperDonePromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('group wrapper timeout')), to);
        const handler = (payload) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.GROUP_WRAPPER_FINISHED, handler); } catch {}
            resolve(payload);
        };
        ctx.eventSource.on(ctx.eventTypes.GROUP_WRAPPER_FINISHED, handler);
    }), timeoutMs);

    await page.evaluate(async (msg) => {
        const ctx = window.Luker.getContext();
        await ctx.executeSlashCommandsWithOptions(`/send ${msg.replace(/\n/g, ' ')} | /trigger`);
    }, text);

    await wrapperDonePromise;

    const messages = await page.evaluate((startAt) => {
        const ctx = window.Luker.getContext();
        const all = ctx.chat || [];
        return all.slice(startAt).map(m => ({
            name: m.name,
            is_user: !!m.is_user,
            is_system: !!m.is_system,
            mes: m.mes,
            original_avatar: m.original_avatar,
        }));
    }, lengthBefore);

    return { messages, chatLengthBefore: lengthBefore };
}

/**
 * Return mock LLM requests since `from`, narrowed to chat-completion calls.
 *
 * @param {Array} requests  mock.requests array
 * @param {number} from
 */
export function chatCompletionRequestsSince(requests, from = 0) {
    return requests.slice(from).filter(r => r.url.includes('chat/completions'));
}

/**
 * On-disk file listing for the user's groups directory. The directory
 * persists across server restarts, so this is the source-of-truth
 * assertion target.
 */
export function listGroupsOnDisk(dataRoot, handle = 'default-user') {
    const dir = resolve(dataRoot, handle, 'groups');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.json'));
}

/**
 * Read group metadata directly from disk (post-restart assertion).
 */
export function readGroupOnDisk(dataRoot, groupId, handle = 'default-user') {
    const file = resolve(dataRoot, handle, 'groups', `${groupId}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Read a group chat jsonl from disk and return the parsed message objects.
 * The first line is the header (chat_metadata); subsequent lines are messages.
 */
export function readGroupChatOnDisk(dataRoot, chatId, handle = 'default-user') {
    const file = resolve(dataRoot, handle, 'group chats', `${chatId}.jsonl`);
    if (!existsSync(file)) return { header: null, messages: [] };
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const [header, ...rest] = parsed;
    return { header, messages: rest };
}
