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
 * Make sure the right-nav drawer is open and the group edit panel
 * (`#rm_group_chats_block`) is the visible right_menu. After
 * `openGroupForChat` has run, `select_group_chats` has already shown the
 * panel, but the drawer wrapper might still be in `closedDrawer`. This
 * mirrors a real user clicking the address-card chevron to reveal the
 * group editor on the side panel.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function openGroupEditPanel(page) {
    // Open the right-nav drawer if it's closed.
    const drawerClosed = await page.evaluate(() => {
        const i = document.querySelector('#rightNavDrawerIcon');
        return i && i.classList.contains('closedIcon');
    });
    if (drawerClosed) {
        await page.evaluate(() => {
            const i = document.querySelector('#rightNavDrawerIcon');
            const toggle = i?.closest('.drawer-toggle') || i;
            toggle?.click();
        });
        await page.waitForFunction(() => {
            const i = document.querySelector('#rightNavDrawerIcon');
            return i && i.classList.contains('openIcon');
        }, { timeout: 5000 }).catch(() => {});
    }
    // The group edit panel becomes display:flex when select_group_chats
    // runs. Wait for it (it should already be visible if openGroupForChat
    // was called before this helper).
    await page.locator('#rm_group_chats_block').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#rm_group_members .group_member').first().waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Click the disable toggle on a group member row inside the right-nav
 * group edit panel. Resolves once the underlying group state reflects
 * the change (member's avatar appears in `group.disabled_members`).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} groupId
 * @param {string} memberName  display name of the character
 */
export async function clickDisableMemberInUI(page, groupId, memberName) {
    await openGroupEditPanel(page);
    // Members render with `.ch_name` showing the display name; the
    // disable button only renders visibly while the row is NOT disabled.
    const row = page.locator(`#rm_group_members .group_member:not(.disabled)`, {
        has: page.locator(`.ch_name`, { hasText: memberName }),
    }).first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    const disableBtn = row.locator('[data-action="disable"]').first();
    // Even though the button has opacity:0.4 by default the click target
    // is real and clickable; we just need to bypass any pointer-events
    // gating from sibling hover styles, so dispatch through JS.
    await disableBtn.evaluate(el => el.click());
    // editGroup is async; wait for the disabled_members list to reflect
    // the click (the in-memory groups[] is the source the activation
    // strategy reads).
    await page.waitForFunction(({ gid, avatarHint }) => {
        const ctx = window.Luker.getContext();
        const groups = ctx.groups || [];
        const g = groups.find(x => x.id === gid);
        if (!g) return false;
        const disabled = Array.isArray(g.disabled_members) ? g.disabled_members : [];
        // We don't know the avatar from the test side; the row also got
        // the `.disabled` class via the click handler. The row's
        // `disabled` class is the most reliable visible flag.
        return disabled.some(a => typeof a === 'string' && a.includes(avatarHint));
    }, { gid: groupId, avatarHint: '' }, { timeout: 5000 }).catch(() => {});
    // Final wait: confirm the row picked up `.disabled` class (CSS toggle).
    await page.locator(`#rm_group_members .group_member.disabled`, {
        has: page.locator(`.ch_name`, { hasText: memberName }),
    }).first().waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Click the enable toggle on a previously-disabled group member row.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} groupId
 * @param {string} memberName
 */
export async function clickEnableMemberInUI(page, groupId, memberName) {
    await openGroupEditPanel(page);
    const row = page.locator(`#rm_group_members .group_member.disabled`, {
        has: page.locator(`.ch_name`, { hasText: memberName }),
    }).first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    const enableBtn = row.locator('[data-action="enable"]').first();
    await enableBtn.evaluate(el => el.click());
    await page.locator(`#rm_group_members .group_member:not(.disabled)`, {
        has: page.locator(`.ch_name`, { hasText: memberName }),
    }).first().waitFor({ state: 'visible', timeout: 5000 });
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
 * Ensure the `.mes[mesid="<n>"]` bubble is loaded into the DOM. The
 * chat lazily renders only the most recent N messages and surfaces a
 * `#show_more_messages` button when older messages exist on disk.
 * This helper clicks that button until the target mesid is in DOM,
 * then scrolls it into view so subsequent gestures (.mes_edit /
 * .mes_create_branch) can find it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} mesid
 */
export async function ensureMessageInView(page, mesid) {
    for (let i = 0; i < 30; i++) {
        const present = await page.locator(`.mes[mesid="${mesid}"]`).count();
        if (present > 0) break;
        const more = page.locator('#show_more_messages');
        const moreExists = await more.count();
        if (!moreExists) break;
        await more.click({ force: true }).catch(() => {});
        // displayChat is async; let the next frame settle before polling.
        await page.waitForTimeout(150);
    }
    await page.locator(`.mes[mesid="${mesid}"]`).waitFor({ state: 'attached', timeout: 10_000 });
    await page.evaluate((id) => {
        const el = document.querySelector(`.mes[mesid="${id}"]`);
        if (el) el.scrollIntoView({ block: 'center' });
    }, mesid);
}

/**
 * Open the past-chats popup (option_select_chat) for the currently
 * selected group. The popup lists every chat under the group with
 * inline export / delete buttons; clicking a row switches to that chat.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function openPastChatsPopupForGroup(page) {
    // Make sure no top-settings drawer covers the composer / options area.
    await page.locator('#options_button').waitFor({ state: 'visible', timeout: 10_000 });
    // The options dropdown is hover-revealed; click the button to open it
    // and then click the "Manage chat files" entry.
    await page.locator('#options_button').click();
    const item = page.locator('#option_select_chat');
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.click();
    await page.locator('#select_chat_popup').waitFor({ state: 'visible', timeout: 10_000 });
    // Wait for at least one chat block to render (displayPastChats is async).
    await page.locator('#select_chat_div .select_chat_block').first()
        .waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Close the past-chats popup.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function closePastChatsPopup(page) {
    const popup = page.locator('#shadow_select_chat_popup');
    const visible = await popup.evaluate(el => el && getComputedStyle(el).display !== 'none').catch(() => false);
    if (!visible) return;
    await page.locator('#select_chat_cross').click();
    await page.waitForFunction(() => {
        const el = document.querySelector('#shadow_select_chat_popup');
        return !el || getComputedStyle(el).display === 'none';
    }, null, { timeout: 5000 }).catch(() => {});
}

/**
 * Switch to a specific group chat from the past-chats popup by clicking
 * the .select_chat_block row whose file_name matches `chatId`. Returns
 * once ctx.getCurrentChatId() reflects the switch.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} chatId
 */
export async function switchGroupChatViaUI(page, chatId) {
    await openPastChatsPopupForGroup(page);
    const row = page.locator(`#select_chat_div .select_chat_block[file_name="${chatId}"]`).first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    await page.waitForFunction((want) => {
        const ctx = window.Luker.getContext();
        return ctx.getCurrentChatId?.() === want;
    }, chatId, { timeout: 15_000 });
}

/**
 * Click the JSONL export button on a specific chat row in the past-chats
 * popup and capture the downloaded payload as a string. Mirrors the real
 * .exportRawChatButton[data-format="jsonl"] click in the past-chats UI.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} chatId  the chat whose row's export button to click
 * @returns {Promise<string>} the downloaded JSONL contents
 */
export async function exportGroupChatViaUI(page, chatId) {
    await openPastChatsPopupForGroup(page);
    const row = page.locator(`#select_chat_div .select_chat_block[file_name="${chatId}"]`).first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    const button = row.locator('.exportRawChatButton[data-format="jsonl"]').first();
    await button.waitFor({ state: 'attached', timeout: 5000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    // The button has opacity:0.5 and may be partially hidden under hover
    // gating; dispatch via JS click so the jQuery delegated handler fires
    // identically to a real click without actionability heuristics.
    await button.evaluate(el => el.click());
    const download = await downloadPromise;
    // Pull the file off disk and return the contents.
    const path = await download.path();
    if (!path) throw new Error('download path unavailable');
    const { readFileSync } = await import('node:fs');
    return readFileSync(path, 'utf8');
}

/**
 * Import a group chat by clicking #chat_import_button (which triggers
 * the hidden file input click) and providing the JSONL payload via the
 * filechooser event. Returns once the new chat appears in the past-chats
 * popup (which displayPastChats re-renders after import).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} jsonl       JSONL contents to import as a fresh chat
 * @param {string} fileName    filename to present to the chooser
 * @returns {Promise<string>}  imported chat id (filename sans extension)
 */
export async function importGroupChatViaUI(page, jsonl, fileName = 'group-roundtrip.jsonl') {
    // Past chats popup must be visible (the import button lives in its header).
    await page.locator('#select_chat_popup').waitFor({ state: 'visible', timeout: 5000 });
    // Snapshot the chat list before so we can detect the new entry.
    const beforeFiles = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('#select_chat_div .select_chat_block'))
            .map(el => el.getAttribute('file_name'))
            .filter(Boolean);
    });
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 });
    await page.locator('#chat_import_button').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
        name: fileName,
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(jsonl, 'utf8'),
    });
    // Wait for displayPastChats to re-render with the new file.
    await page.waitForFunction((before) => {
        const after = Array.from(document.querySelectorAll('#select_chat_div .select_chat_block'))
            .map(el => el.getAttribute('file_name'))
            .filter(Boolean);
        return after.length > before.length;
    }, beforeFiles, { timeout: 30_000 });
    const newFiles = await page.evaluate((before) => {
        const after = Array.from(document.querySelectorAll('#select_chat_div .select_chat_block'))
            .map(el => el.getAttribute('file_name'))
            .filter(Boolean);
        const beforeSet = new Set(before);
        return after.filter(f => !beforeSet.has(f));
    }, beforeFiles);
    if (newFiles.length === 0) throw new Error('imported chat row did not appear in past-chats popup');
    return newFiles[0];
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
