/**
 * CardApp Studio AI Chat - Function-calling based AI assistant for CardApp development.
 *
 * Routes requests through Luker.context.generateTask with tool definitions to let AI
 * read/write CardApp files. Studio is a dev/authoring tool — it never injects character
 * card or world info into the prompt; the system prompt and conversation messages flow
 * through verbatim.
 */

import { DEFAULT_CARDAPP_STUDIO_SYSTEM_PROMPT as DEFAULT_SYSTEM_PROMPT } from '../defaults.js';
import {
    TOOL_PROTOCOL_STYLE,
} from '../../function-call-runtime.js';
import { fetchFileList, fetchFileContent, saveFileContent, deleteFile, renameFile } from './file-api.js';
import { i18n } from '../i18n.js';
import { applyEdits } from '../../../lib/edits/index.js';
import { requireStoredPrompt } from '../../../lib/prompt-values.js';
import { showConflictResolution } from '../../../lib/edits/conflict-ui.js';
import {
    listCtxKeys,
    describeCtxPath,
    listLukerDocs,
    readLukerDoc,
} from '../../../iteration-library/tools/ctx-and-docs-discovery.js';

const __ctx = Luker.getContext();
const characters = __ctx.characters;
const loadWorldInfo = __ctx.loadWorldInfo;
const createWorldInfoEntry = __ctx.worldInfoEntry.create;
const deleteWorldInfoEntry = __ctx.worldInfoEntry.delete;
const saveWorldInfo = __ctx.saveWorldInfo;
const createNewWorldInfo = __ctx.createWorldBook;
const charUpdatePrimaryWorld = __ctx.charUpdatePrimaryWorld;
const getChatWorldInfoNames = __ctx.chatWorldInfo.getNames;
const getCharaAuxWorlds = __ctx.getCharaAuxWorlds;
const importEmbeddedWorldInfo = __ctx.importEmbeddedWorldInfo;
const getCharacterEmbeddedWorld = __ctx.getCharacterEmbeddedWorld;
const getCharaFilename = __ctx.getCharaFilename;
const SlashCommandParser = __ctx.SlashCommandParser;
const getContext = Luker.getContext;
const extension_settings = __ctx.extensionSettings;
const writeExtensionField = __ctx.writeExtensionField;
const uuidv4 = __ctx.uuidv4;

// ==================== Tool Definitions ====================

const TOOL_NAMES = Object.freeze({
    LIST_FILES: 'cardapp_list_files',
    READ_FILE: 'cardapp_read_file',
    WRITE_FILE: 'cardapp_write_file',
    PATCH_FILE: 'cardapp_patch_file',
    DELETE_FILE: 'cardapp_delete_file',
    RENAME_FILE: 'cardapp_rename_file',
    CHARACTER_GET_FIELDS: 'character_get_fields',
    CHARACTER_UPDATE_FIELDS: 'character_update_fields',
    WORLDINFO_LIST_BOOKS: 'worldinfo_list_books',
    WORLDINFO_GET_ENTRIES: 'worldinfo_get_entries',
    WORLDINFO_SEARCH_ENTRIES: 'worldinfo_search_entries',
    WORLDINFO_CREATE_ENTRY: 'worldinfo_create_entry',
    WORLDINFO_UPDATE_ENTRY: 'worldinfo_update_entry',
    WORLDINFO_DELETE_ENTRY: 'worldinfo_delete_entry',
    WORLDINFO_CREATE_BOOK: 'worldinfo_create_book',
    WORLDINFO_REPLACE_ENTRIES: 'worldinfo_replace_entries',
    CHARACTER_IMPORT_EMBEDDED_WORLD: 'character_import_embedded_world',
    REGEX_LIST_SCRIPTS: 'regex_list_scripts',
    REGEX_CREATE_SCRIPT: 'regex_create_script',
    REGEX_UPDATE_SCRIPT: 'regex_update_script',
    REGEX_DELETE_SCRIPT: 'regex_delete_script',
    ORCHESTRATOR_GET_OVERRIDE: 'character_get_orchestrator',
    ORCHESTRATOR_SET_OVERRIDE: 'character_update_orchestrator',
    ORCHESTRATOR_CLEAR_OVERRIDE: 'character_clear_orchestrator',
    MEMORY_GRAPH_GET: 'character_get_memory_graph',
    MEMORY_GRAPH_SET_SCHEMA: 'character_update_memory_graph_schema',
    MEMORY_GRAPH_SET_ADVANCED: 'character_update_memory_graph_advanced',
    SLASHCMD_LIST: 'slashcmd_list',
    SLASHCMD_HELP: 'slashcmd_help',
    LUKER_CTX_LIST_KEYS: 'luker_context_list_keys',
    LUKER_CTX_DESCRIBE: 'luker_context_describe',
    DOCS_LIST: 'list_luker_docs',
    DOCS_READ: 'read_luker_doc',
    CARDAPP_SET_ENABLED: 'cardapp_set_enabled',
});

function getRegexApi() {
    const api = (getContext?.() || __ctx)?.regex;
    if (!api) {
        throw new Error('[CEA Studio] Luker.getContext().regex is unavailable');
    }
    return api;
}

function normalizeRegexScriptForTool(script) {
    if (!script || typeof script !== 'object') {
        return script;
    }
    return getRegexApi().normalizePluginScriptRecord(script);
}

function normalizeRegexScriptsForTool(scripts) {
    return Array.isArray(scripts) ? scripts.map(normalizeRegexScriptForTool) : scripts;
}

function buildTools() {
    return [
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.LIST_FILES,
                description: 'List all files in the current CardApp.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.READ_FILE,
                description: 'Read the full content of a file.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path, e.g. index.js' },
                    },
                    required: ['path'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.WRITE_FILE,
                description: 'Create or overwrite a file with complete content.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        content: { type: 'string', description: 'Complete file content' },
                    },
                    required: ['path', 'content'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.PATCH_FILE,
                description: 'Patch a file by replacing old_text with new_text. old_text must exactly match a contiguous block in the file. Minor trailing whitespace differences are tolerated.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        old_text: { type: 'string', description: 'Exact text to find' },
                        new_text: { type: 'string', description: 'Replacement text' },
                    },
                    required: ['path', 'old_text', 'new_text'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.DELETE_FILE,
                description: 'Delete a file.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                    },
                    required: ['path'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.RENAME_FILE,
                description: 'Rename or move a file.',
                parameters: {
                    type: 'object',
                    properties: {
                        from_path: { type: 'string', description: 'Current file path' },
                        to_path: { type: 'string', description: 'New file path' },
                    },
                    required: ['from_path', 'to_path'],
                    additionalProperties: false,
                },
            },
        },
        // ==================== Character Fields ====================
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.CHARACTER_GET_FIELDS,
                description: 'Get all editable fields of the current character card (name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags, talkativeness, world (bound world book name), depth_prompt settings, embedded_world). The embedded_world field reports the V2/V3 character_book carried inside the card PNG: { present, name, entryCount, bound }. When present=true && bound=false, the card was imported with an embedded book that has not yet been turned into a real world book file — call character_import_embedded_world to import it. When present=true && bound=true, the embedded book is just a stale mirror of the bound world (post-export artifact) and can be ignored.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.CHARACTER_UPDATE_FIELDS,
                description: 'Update one or more character card fields. Supported keys: name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags (comma-separated string), talkativeness (number 0-1), world (bound world book name, "" to unbind), depth_prompt_prompt, depth_prompt_depth, depth_prompt_role.',
                parameters: {
                    type: 'object',
                    properties: {
                        fields: {
                            type: 'object',
                            description: 'Key-value pairs of fields to update',
                            additionalProperties: true,
                        },
                    },
                    required: ['fields'],
                    additionalProperties: false,
                },
            },
        },
        // ==================== World Info ====================
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.WORLDINFO_LIST_BOOKS,
                description: 'List world book names visible to the current character: character primary (from character.data.extensions.world — the card\'s primary book), character auxiliary (from world_info.charLore[].extraBooks — extra books bound via Luker\'s lorebook editor), chat-bound (from chat metadata — per-save state, resets on new chat), and globally activated (every chat). Returns { books: string[], sources: { [name]: \'character\'|\'character_aux\'|\'chat\'|\'global\' } } so you can tell which book lives at which scope. Chat-bound mutation is a CardApp runtime concern (use ctx.setChatWorldBooks in card code) — Studio reads via this tool but never mutates chat-bound bindings.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.WORLDINFO_GET_ENTRIES,
                description: 'Get all entries from a world book. Returns entries as uid-keyed object. Heavy — for large books prefer worldinfo_search_entries to narrow first.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string', description: 'World book name' },
                    },
                    required: ['book_name'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.WORLDINFO_SEARCH_ENTRIES,
                description: 'Search entries inside one world book by keyword (case-insensitive substring match against comment, key, keysecondary, and content). Lightweight: returns uid, comment, keys, flags, and a content_preview (first 200 chars). Call worldinfo_get_entries afterwards only if you need full bodies. Optional constant/enabled filters narrow without text. Use worldinfo_list_books first to discover book names.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string', description: 'World book name to search inside.' },
                        text: { type: 'string', description: 'Case-insensitive substring to search for.' },
                        constant: { type: 'boolean', description: 'Filter to entries with constant=true/false.' },
                        enabled: { type: 'boolean', description: 'Filter to enabled (or disabled) entries.' },
                        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max hits returned. Default 20.' },
                    },
                    required: ['book_name'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.WORLDINFO_CREATE_ENTRY,
                description: 'Create a new entry in a world book. Returns the new entry with its assigned uid.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string', description: 'World book name' },
                        comment: { type: 'string', description: 'Entry title/comment' },
                        content: { type: 'string', description: 'Entry content text' },
                        key: { type: 'array', items: { type: 'string' }, description: 'Trigger keywords' },
                        keysecondary: { type: 'array', items: { type: 'string' }, description: 'Secondary keywords (optional)' },
                        constant: { type: 'boolean', description: 'Always active (default false)' },
                        selective: { type: 'boolean', description: 'Selective triggering (default true)' },
                        disable: { type: 'boolean', description: 'Disabled (default false)' },
                        position: { type: 'number', description: 'Injection position: 0=before char desc (↑Char), 1=after char desc (↓Char), 2=above author note (↑AT), 3=below author note (↓AT), 4=at chat depth (uses depth+role), 5=top of example messages (↑EM), 6=bottom of example messages (↓EM), 7=outlet (post-prompt-assembly hook)' },
                        order: { type: 'number', description: 'Sort order within position bucket. Default 100. Lower=earlier in bucket.' },
                        depth: { type: 'number', description: 'Chat depth (only used when position=4). 0=right at conversation tail, higher=further back.' },
                        role: { type: 'number', description: 'Role for atDepth injection (only used when position=4): 0=system, 1=user, 2=assistant. Default 0.' },
                        excludeRecursion: { type: 'boolean', description: 'Non-recursable: do NOT let this entry be triggered by other entries\' content during recursive scans (default false).' },
                        preventRecursion: { type: 'boolean', description: 'Prevent further recursion: once this entry fires, do NOT recurse into other entries from its content (default false).' },
                        delayUntilRecursion: { type: 'number', description: 'Delay-until-recursion level: 0=fire on the first scan as normal; 1=skip first scan, only fire from recursion level 1 onward; 2+ = wait until that level. Default 0.' },
                    },
                    required: ['book_name'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.WORLDINFO_UPDATE_ENTRY,
                description: 'Update fields of an existing world book entry. Patch accepts any entry field; common: comment, content, key, keysecondary, constant, selective, disable, position, order, depth, role, excludeRecursion, preventRecursion, delayUntilRecursion.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string', description: 'World book name' },
                        uid: { type: 'number', description: 'Entry UID' },
                        patch: { type: 'object', description: 'Fields to update (shallow merge)', additionalProperties: true },
                    },
                    required: ['book_name', 'uid', 'patch'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.WORLDINFO_DELETE_ENTRY,
                description: 'Delete a world book entry.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string', description: 'World book name' },
                        uid: { type: 'number', description: 'Entry UID' },
                    },
                    required: ['book_name', 'uid'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.WORLDINFO_CREATE_BOOK,
                description: 'Create a new empty world book file (no side effects — does NOT bind to character or chat). Use this when you need a book to exist before binding it as the character primary world (via character_update_fields({fields:{world: name}})) or before populating entries. Idempotent on existing names: if a book with that name already exists, returns success without modifying it. The created book has zero entries — populate via worldinfo_create_entry / worldinfo_replace_entries afterwards.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string', description: 'World book name to create.' },
                    },
                    required: ['book_name'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.CHARACTER_IMPORT_EMBEDDED_WORLD,
                description: 'Import the V2/V3 embedded world book (data.character_book) carried by a third-party PNG card and bind it as the character primary world. Use when character_get_fields returns embedded_world.present === true && embedded_world.bound === false — i.e. the card was imported with an embedded book that has not yet been turned into a real world book file. After import, the embedded book becomes a standalone world book file (named after the embedded book) and character.data.extensions.world is set to point at it. Idempotent on already-imported state: when bound is already true this call is a no-op.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.WORLDINFO_REPLACE_ENTRIES,
                description: 'DESTRUCTIVE: replace ALL entries in a world book with a fresh set in one call. Existing entries are wiped; uids are reassigned by the system, so any uid you held from a prior call becomes invalid. Top-level book metadata (display_index, etc.) is preserved. Use for "regenerate dynamic entries from a variable object" patterns where you want the whole entry set to mirror caller state each turn. For incremental edits prefer worldinfo_update_entry. Caller-supplied uid fields in entries are ignored.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string', description: 'World book name (must exist — use worldinfo_create_book first if creating from scratch)' },
                        entries: {
                            type: 'array',
                            description: 'Full replacement entry set. Each item is a partial entry; missing fields fall back to template defaults.',
                            items: {
                                type: 'object',
                                properties: {
                                    comment: { type: 'string', description: 'Entry title/comment' },
                                    content: { type: 'string', description: 'Entry content text' },
                                    key: { type: 'array', items: { type: 'string' }, description: 'Trigger keywords' },
                                    keysecondary: { type: 'array', items: { type: 'string' }, description: 'Secondary keywords (optional)' },
                                    constant: { type: 'boolean', description: 'Always active (default false)' },
                                    selective: { type: 'boolean', description: 'Selective triggering (default true)' },
                                    disable: { type: 'boolean', description: 'Disabled (default false)' },
                                    position: { type: 'number', description: 'Injection position: 0=before char desc, 1=after char desc, 2=ANTop, 3=ANBottom, 4=atDepth (uses depth+role), 5=EMTop, 6=EMBottom, 7=outlet (post-prompt-assembly hook)' },
                                    order: { type: 'number', description: 'Sort order within position bucket. Default 100. Lower=earlier.' },
                                    depth: { type: 'number', description: 'Chat depth (only when position=4). 0=tail.' },
                                    role: { type: 'number', description: 'Role for atDepth (only when position=4): 0=system, 1=user, 2=assistant.' },
                                    excludeRecursion: { type: 'boolean', description: 'Non-recursable: do NOT let this entry be triggered by other entries\' content (default false).' },
                                    preventRecursion: { type: 'boolean', description: 'Prevent further recursion from this entry (default false).' },
                                    delayUntilRecursion: { type: 'number', description: 'Delay-until-recursion level (0=normal, 1+=skip until that recursion level). Default 0.' },
                                },
                                additionalProperties: true,
                            },
                        },
                    },
                    required: ['book_name', 'entries'],
                    additionalProperties: false,
                },
            },
        },
        // ==================== Regex Scripts ====================
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.REGEX_LIST_SCRIPTS,
                description: 'List regex scripts at the requested scope. scope=\'character\' reads character.data.extensions.regex_scripts (card-level — travels with the character file). scope=\'global\' reads extension_settings.regex (user-level — active for every chat). scope=\'all\' (default) returns both as { character: [...], global: [...] }. Each script has id, scriptName, findRegex, replaceString, placement (number[]), trimStrings, plus boolean gates disabled/markdownOnly/promptOnly/runOnEdit, pluginLanes (array of "request" and/or "reply"), and substituteRegex/minDepth/maxDepth.',
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', enum: ['character', 'global', 'all'], description: 'Which storage to read. Defaults to \'all\'.' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.REGEX_CREATE_SCRIPT,
                description: 'Create a new regex script. scope=\'character\' writes to character.data.extensions.regex_scripts (card-level, travels with the card); scope=\'global\' writes to extension_settings.regex (user-level, every chat). The id is auto-generated; any caller-supplied id is ignored. placement controls where the regex fires — a script without placement is inactive unless it has a reply plugin lane.',
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', enum: ['character', 'global'], description: 'Storage target. \'character\'=card-level (extensions.regex_scripts), \'global\'=user-level (extension_settings.regex).' },
                        scriptName: { type: 'string', description: 'Display name shown in the regex editor.' },
                        findRegex: { type: 'string', description: 'JavaScript regex literal as a string, with delimiters and flags. Example: "/<thinking>[\\\\s\\\\S]*?<\\\\/thinking>/gi". Use the g flag to replace all matches.' },
                        replaceString: { type: 'string', description: 'Replacement template. Supports $0 (whole match), $1/$2 (numbered groups), $<name> (named groups), and {{match}} (alias for $0). Macros like {{user}}, {{char}}, {{getvar::x}} are evaluated on the result.' },
                        trimStrings: { type: 'array', items: { type: 'string' }, description: 'Strings to remove from each captured group before substitution. Useful for stripping markers like "Thought: " from the kept text.' },
                        placement: { type: 'array', items: { type: 'number' }, description: 'Where this script applies (multi-select). 1=USER_INPUT (the user message after they hit send), 2=AI_OUTPUT (every assistant message), 3=SLASH_COMMAND (text returned by /commands), 5=WORLD_INFO (entry content right before injection), 6=REASONING (reasoning blocks). Empty array = no placement targets; the script runs only when it has a reply plugin lane.' },
                        disabled: { type: 'boolean', description: 'Disabled scripts are skipped. Default false.' },
                        markdownOnly: { type: 'boolean', description: 'Apply only when rendering text to the chat UI (display-time). Use this to hide/clean things visually WITHOUT changing the stored message or what the AI sees on next prompt assembly. Default false.' },
                        promptOnly: { type: 'boolean', description: 'Apply only when assembling the prompt sent to the AI. Use this to clean up or strip noise BEFORE the AI sees previous messages, without altering the stored chat or what the user sees in the UI. Default false.' },
                        pluginLanes: {
                            type: 'array',
                            items: { type: 'string', enum: ['request', 'reply'] },
                            description: 'Plugin application points. request covers text going into a plugin request and requires at least one placement; reply covers the assistant text a plugin request returns and does not use placement. Most authoring cases leave this empty.',
                        },
                        runOnEdit: { type: 'boolean', description: 'Re-apply when the user edits a stored message. Off (default) means manual edits keep the original text. Turn on for cleanup-style scripts that should normalize edits too.' },
                        substituteRegex: { type: 'number', description: 'Macro substitution mode for findRegex itself. 0=NONE (regex used as-is), 1=RAW (substitute {{user}} etc. into the regex text raw), 2=ESCAPED (substitute then regex-escape special chars so the result is literal). Default 0.' },
                        minDepth: { type: 'number', description: 'Minimum chat depth for the script to fire (0=most recent message). Null/omit = no lower bound. Use to e.g. only run on older messages.' },
                        maxDepth: { type: 'number', description: 'Maximum chat depth. Null/omit = no upper bound. Use to e.g. only run on the latest few messages.' },
                    },
                    required: ['scope'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.REGEX_UPDATE_SCRIPT,
                description: 'Patch fields of an existing regex script (shallow merge). Pass only the fields you want to change. See regex_create_script for the full field list and semantics. The id field in the patch is ignored — id is preserved.',
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', enum: ['character', 'global'], description: 'Scope of the script being patched.' },
                        id: { type: 'string', description: 'UUID of the script to update.' },
                        patch: { type: 'object', description: 'Fields to merge onto the existing record. Same keys as regex_create_script.', additionalProperties: true },
                    },
                    required: ['scope', 'id', 'patch'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.REGEX_DELETE_SCRIPT,
                description: 'Delete a regex script by id from the requested scope. Errors if no script with that id exists at that scope (so typos do not silently no-op).',
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', enum: ['character', 'global'], description: 'Where the script is stored.' },
                        id: { type: 'string', description: 'UUID of the script to remove.' },
                    },
                    required: ['scope', 'id'],
                    additionalProperties: false,
                },
            },
        },
        // ==================== Orchestrator (per-character override) ====================
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.ORCHESTRATOR_GET_OVERRIDE,
                description: 'Read the orchestrator preset state for the active character card. Always character-scoped — never reads global orchestrator settings. Returns `{ mode, enabled, activePresetId }` for the saved execution mode (or null when the card has no per-character preset library for that mode). `enabled` is true when the card\'s active slot points at a real preset (the card library runs); false means the global active preset runs. The full per-mode preset payload is stored in `presetLibraries.<mode>` on the card and is managed through the orchestrator iteration studio rather than this tool.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.ORCHESTRATOR_SET_OVERRIDE,
                description: 'Switch which preset the active character card runs for its saved execution mode. Always character-scoped — global orchestrator settings are never touched. The card must already have a preset library for the saved mode (otherwise there is nothing to switch); populate it through the orchestrator iteration studio first.',
                parameters: {
                    type: 'object',
                    properties: {
                        presetId: { type: 'string', description: 'The card preset id to activate, or an empty string to fall back to the global active preset (the card library is preserved either way).' },
                    },
                    required: ['presetId'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.ORCHESTRATOR_CLEAR_OVERRIDE,
                description: 'Remove every orchestrator override from the active character card. Wipes the per-mode preset libraries, the active-preset ids, the enabled flags, and the saved-mode pin so the card falls back to global orchestrator settings. Always character-scoped.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
        },
        // ==================== Memory Graph (per-character override) ====================
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.MEMORY_GRAPH_GET,
                description: 'Get the memory-graph configuration that will be in effect for the active character. Returns { schema: { scope, hasOverride, schema }, advanced: { scope, hasOverride, settings } } where scope is \'character\' if a card-level override is set, else \'global\' (falling back to the global memory-graph config). Use this to design a memory schema tailored to the card\'s domain (e.g. NPC relationships, quest state, location facts) before writing.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.MEMORY_GRAPH_SET_SCHEMA,
                description: 'Set or clear the memory-graph node-type schema override on the active character card. Pass schema=null to clear and fall back to global schema. The schema is sanitized through normalizeNodeTypeSchema before write. Always character-scoped — never touches the global schema.',
                parameters: {
                    type: 'object',
                    properties: {
                        schema: {
                            description: 'Array of node-type descriptors, or null to clear the override.',
                            oneOf: [
                                { type: 'array', items: { type: 'object', additionalProperties: true } },
                                { type: 'null' },
                            ],
                        },
                    },
                    required: ['schema'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.MEMORY_GRAPH_SET_ADVANCED,
                description: 'Set or clear the memory-graph advanced-settings override on the active character card. Pass advanced=null to clear and fall back to global advanced settings. The patch is normalized through normalizeAdvancedSettings before write. Always character-scoped — never touches the global advanced settings.',
                parameters: {
                    type: 'object',
                    properties: {
                        advanced: {
                            description: 'Advanced settings patch object (recall layout, compression knobs, vector index params), or null to clear the override.',
                            oneOf: [
                                { type: 'object', additionalProperties: true },
                                { type: 'null' },
                            ],
                        },
                    },
                    required: ['advanced'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.SLASHCMD_LIST,
                description: 'List available slash commands. Returns each command with its name, brief help (first line), and aliases. Use slashcmd_help for full details on a specific command. Slash commands cover image generation (/sd, /imagine), TTS, raw LLM calls (/genraw), variable management, Quick Replies, and many more.',
                parameters: {
                    type: 'object',
                    properties: {
                        filter: { type: 'string', description: 'Optional substring to match command names (case-insensitive)' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.SLASHCMD_HELP,
                description: 'Get full details on a specific slash command, including named arguments, unnamed arguments, accepted types, enum values, default values, and help text. Aliases also resolve.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Slash command name (with or without leading /)' },
                    },
                    required: ['name'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.LUKER_CTX_LIST_KEYS,
                description: 'List top-level properties of ctx.lukerContext (the full Luker extension API, ~200+ keys). Each entry is {key, type}. Use luker_context_describe for details on a specific key. Useful when you need a Luker capability not exposed on ctx directly.',
                parameters: {
                    type: 'object',
                    properties: {
                        filter: { type: 'string', description: 'Optional substring to match keys (case-insensitive)' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.LUKER_CTX_DESCRIBE,
                description: 'Describe a property or nested path of ctx.lukerContext. Returns its type, function arity (parameter count hint), short source preview for functions, or sub-keys for objects. Supports dot paths like "presets.state.patch" or "swipe.right".',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Dot path, e.g. "generate" or "presets.state.patch"' },
                    },
                    required: ['path'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.DOCS_LIST,
                description: 'List Luker documentation files (markdown) available locally. By default returns only English docs (zh-CN/zh-TW translations are hidden because their content matches English). Returns each file as {path, size}. Useful starting points: development/card-developers.md (CardApp creator guide), features/cardapp.md (CardApp concepts), features/state-system.md (state overview), development/extension-api/chat-and-state.md (Floor State, chat state, character state), development/extension-api/generation.md, development/extension-api/presets-and-prompts.md.',
                parameters: {
                    type: 'object',
                    properties: {
                        filter: { type: 'string', description: 'Optional substring to match file paths (case-insensitive)' },
                        includeTranslations: { type: 'boolean', description: 'Include zh-CN and zh-TW translation files in results. Default false; translations duplicate English content.' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.DOCS_READ,
                description: 'Read a Luker documentation markdown file. Use this to look up authoritative guidance on Floor State, state-system, CardApp lifecycle, extension API conventions, etc., before generating code that touches those areas.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Doc path relative to docs/, e.g. "development/extension-api/chat-and-state.md"' },
                    },
                    required: ['path'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.CARDAPP_SET_ENABLED,
                description: 'Turn CardApp on or off for this character (writes data.extensions.card_app.enabled). Only call this AFTER the user has explicitly confirmed they want CardApp enabled (or disabled). Do NOT call this unprompted just because you see CardApp-style code. If you need to know the current toggle state, ask the user — Studio has no read-only inspector for it. The response returns was_enabled so you know what the previous value was. The character is persisted automatically.',
                parameters: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean', description: 'true to enable CardApp, false to disable' },
                    },
                    required: ['enabled'],
                    additionalProperties: false,
                },
            },
        },
    ];
}

// ==================== Patch Implementation ====================

/**
 * Apply a search/replace patch to file content.
 * Tolerates minor trailing whitespace differences.
 * @param {string} content - Current file content
 * @param {string} oldText - Text to find
 * @param {string} newText - Replacement text
 * @returns {string|null} Patched content, or null if old_text not found
 */
export function applyPatch(content, oldText, newText) {
    // 1. Exact match
    if (content.includes(oldText)) {
        return content.replace(oldText, newText);
    }

    // 2. Normalize trailing whitespace per line
    const normalizeTrailing = (s) => s.replace(/[ \t]+$/gm, '');
    const normalizedContent = normalizeTrailing(content);
    const normalizedOld = normalizeTrailing(oldText);

    if (normalizedContent.includes(normalizedOld)) {
        // Find the position in normalized content, then map back to original
        const idx = normalizedContent.indexOf(normalizedOld);
        // Count how many characters in original content correspond to idx in normalized
        const contentLines = content.split('\n');
        const normLines = normalizedContent.split('\n');
        let origStart = -1;
        let origEnd = -1;
        let charCount = 0;
        let normCharCount = 0;

        for (let i = 0; i < contentLines.length; i++) {
            const origLine = contentLines[i];
            const normLine = normLines[i];

            if (origStart === -1 && normCharCount + normLine.length >= idx) {
                // Start is in this line
                const lineOffset = idx - normCharCount;
                origStart = charCount + lineOffset;
            }

            const endIdx = idx + normalizedOld.length;
            if (origEnd === -1 && normCharCount + normLine.length >= endIdx) {
                const lineOffset = endIdx - normCharCount;
                origEnd = charCount + lineOffset;
            }

            charCount += origLine.length + 1; // +1 for \n
            normCharCount += normLine.length + 1;

            if (origStart !== -1 && origEnd !== -1) break;
        }

        if (origStart !== -1 && origEnd !== -1) {
            return content.substring(0, origStart) + newText + content.substring(origEnd);
        }
    }

    // 3. Normalize all whitespace (tabs vs spaces)
    const normalizeIndent = (s) => s.replace(/^[ \t]+/gm, (m) => m.replace(/\t/g, ' '));
    const indentContent = normalizeIndent(normalizeTrailing(content));
    const indentOld = normalizeIndent(normalizeTrailing(oldText));

    if (indentContent.includes(indentOld)) {
        // Fallback: just do the replacement on normalized and return
        // This loses original indentation style but at least works
        const result = indentContent.replace(indentOld, newText);
        return result;
    }

    return null;
}

// ==================== edits-lib helpers ====================

/**
 * Parse a CardApp file-op path like `files["index.js"]` back into the bare
 * filename `index.js`. Used to translate edits-lib `set` / `unset` op paths
 * into arguments the file REST helpers expect.
 */
import { cardAppFileEditPath, parseCardAppFilePath } from './file-path.js';

/**
 * Extract the file paths an Edit touches (for modifiedFiles tracking and
 * UI refresh). cardapp_rename_file emits both from and to.
 */
function extractPathsFromEdit(edit) {
    if (edit.op === 'set' || edit.op === 'unset') {
        return [parseCardAppFilePath(edit.path)];
    }
    if (edit.op === 'cardapp_patch_file') {
        return [edit.path];
    }
    if (edit.op === 'cardapp_rename_file') {
        return [edit.from, edit.to];
    }
    return [];
}

/**
 * Build the live snapshot for a round's file-op edit batch by fetching
 * the current server-side content of every touched path. Absent files are
 * simply omitted from `live.files` (creating ops will fill them in).
 */
async function loadCardAppFilesLive(charId, edits) {
    const live = { files: {} };
    const paths = new Set();
    for (const e of edits) {
        for (const p of extractPathsFromEdit(e)) {
            if (p) paths.add(p);
        }
    }
    for (const p of paths) {
        try { live.files[p] = await fetchFileContent(charId, p); } catch { /* file absent — OK for create ops */ }
    }
    return live;
}

/**
 * Commit a clean batch of file-op edits to the server. The edits are the
 * output of applyEdits() (already drift-checked and ordered); each op
 * maps back to its corresponding REST call. Rename uses the atomic
 * server endpoint, not delete-then-create.
 */
async function commitFileOpEdits(charId, cleanEdits, newLive) {
    for (const e of cleanEdits) {
        if (e.op === 'set') {
            await saveFileContent(charId, parseCardAppFilePath(e.path), e.newValue);
        } else if (e.op === 'unset') {
            await deleteFile(charId, parseCardAppFilePath(e.path));
        } else if (e.op === 'cardapp_patch_file') {
            await saveFileContent(charId, e.path, newLive?.files?.[e.path] ?? '');
        } else if (e.op === 'cardapp_rename_file') {
            await renameFile(charId, e.from, e.to);
        }
    }
}

// ==================== Tool Execution ====================

/**
 * Execute a single tool call.
 * @param {string} charId - Character ID
 * @param {string} toolName - Tool name
 * @param {object} args - Tool arguments
 * @param {object} options
 * @param {boolean} [options.deferWriteOps=false] - If true, file-op tools return a pending_edit envelope (Edit + display metadata) for round-end batch processing instead of executing immediately.
 * @param {object} [options.character] - Original character captured before model work
 * @returns {Promise<object>} Tool result
 */
function getMissingTargetError(charId, explicitCharacter = null) {
    const normalizedCharId = String(charId || '').trim();
    if (!explicitCharacter && normalizedCharId) {
        return `Target character "${normalizedCharId}" not found`;
    }
    return 'No active character';
}

function resolveStudioTargetCharacter(charId, explicitCharacter = null) {
    const ctx = getContext() || __ctx;
    const list = Array.isArray(ctx?.characters) ? ctx.characters : (Array.isArray(characters) ? characters : null);
    if (explicitCharacter) {
        if (!list) return null;
        const idx = list.indexOf(explicitCharacter);
        if (idx < 0) return null;
        return {
            ctx,
            character: explicitCharacter,
            characterId: idx,
            avatar: String(explicitCharacter.avatar || '').trim(),
        };
    }
    const normalizedCharId = String(charId || '').trim();
    if (normalizedCharId && list) {
        const idx = list.findIndex(card => card?.avatar && getCharaFilename(null, { manualAvatarKey: card.avatar }) === normalizedCharId);
        if (idx >= 0) {
            const card = list[idx];
            return {
                ctx,
                character: card,
                characterId: idx,
                avatar: String(card.avatar || '').trim(),
            };
        }
        return null;
    }
    const activeId = ctx?.characterId;
    if (activeId !== undefined && activeId !== null) {
        const card = (ctx?.characters || characters)?.[activeId] || null;
        if (card) {
            return {
                ctx,
                character: card,
                characterId: activeId,
                avatar: String(card.avatar || '').trim(),
            };
        }
    }
    return null;
}

export async function executeTool(charId, toolName, args, options = {}) {
    const { deferWriteOps = false, character } = options;
    const resolvedTarget = resolveStudioTargetCharacter(charId, character);
    const liveCtxSnapshot = getContext() || __ctx;
    const hasCharacterList = Array.isArray(liveCtxSnapshot?.characters) || Array.isArray(characters);
    const hasExplicitTarget = Boolean(character || (String(charId || '').trim() && hasCharacterList));
    const missingTargetError = getMissingTargetError(charId, character);
    try {
        switch (toolName) {
            case TOOL_NAMES.LIST_FILES: {
                const files = await fetchFileList(charId);
                return { ok: true, files };
            }
            case TOOL_NAMES.READ_FILE: {
                const content = await fetchFileContent(charId, args.path);
                return { ok: true, content };
            }
            case TOOL_NAMES.WRITE_FILE: {
                if (deferWriteOps) {
                    let oldContent;
                    try { oldContent = await fetchFileContent(charId, args.path); } catch { /* file doesn't exist yet — set will create it */ }
                    return {
                        ok: true,
                        pending_edit: true,
                        edit: {
                            op: 'set',
                            path: cardAppFileEditPath(args.path),
                            oldValue: oldContent,
                            newValue: args.content,
                        },
                        displayPath: args.path,
                        tool: TOOL_NAMES.WRITE_FILE,
                    };
                }
                await saveFileContent(charId, args.path, args.content);
                return { ok: true, message: `File ${args.path} written successfully.` };
            }
            case TOOL_NAMES.PATCH_FILE: {
                if (deferWriteOps) {
                    return {
                        ok: true,
                        pending_edit: true,
                        edit: {
                            op: 'cardapp_patch_file',
                            path: args.path,
                            old_text: args.old_text,
                            new_text: args.new_text,
                        },
                        displayPath: args.path,
                        tool: TOOL_NAMES.PATCH_FILE,
                    };
                }
                const current = await fetchFileContent(charId, args.path);
                const patched = applyPatch(current, args.old_text, args.new_text);
                if (patched === null) {
                    return { ok: false, error: `old_text not found in ${args.path}. Use read_file to check current content.` };
                }
                await saveFileContent(charId, args.path, patched);
                return { ok: true, message: `File ${args.path} patched successfully.` };
            }
            case TOOL_NAMES.DELETE_FILE: {
                if (deferWriteOps) {
                    return {
                        ok: true,
                        pending_edit: true,
                        edit: { op: 'unset', path: cardAppFileEditPath(args.path) },
                        displayPath: args.path,
                        tool: TOOL_NAMES.DELETE_FILE,
                    };
                }
                await deleteFile(charId, args.path);
                return { ok: true, message: `File ${args.path} deleted.` };
            }
            case TOOL_NAMES.RENAME_FILE: {
                if (deferWriteOps) {
                    return {
                        ok: true,
                        pending_edit: true,
                        edit: {
                            op: 'cardapp_rename_file',
                            from: args.from_path,
                            to: args.to_path,
                        },
                        displayPath: `${args.from_path} → ${args.to_path}`,
                        tool: TOOL_NAMES.RENAME_FILE,
                    };
                }
                await renameFile(charId, args.from_path, args.to_path);
                return { ok: true, message: `File renamed from ${args.from_path} to ${args.to_path}.` };
            }
            // ==================== Character Fields ====================
            case TOOL_NAMES.CHARACTER_GET_FIELDS: {
                if (!resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                const char = resolvedTarget.character;
                const d = char?.data || {};
                return {
                    ok: true,
                    fields: {
                        name: char?.name || '',
                        description: d.description || '',
                        personality: d.personality || '',
                        scenario: d.scenario || '',
                        first_mes: d.first_mes || '',
                        mes_example: d.mes_example || '',
                        system_prompt: d.system_prompt || '',
                        post_history_instructions: d.post_history_instructions || '',
                        creator_notes: d.creator_notes || '',
                        creator: d.creator || '',
                        character_version: d.character_version || '',
                        world: String(d.extensions?.world || ''),
                        tags: Array.isArray(d.tags) ? d.tags.join(', ') : '',
                        talkativeness: d.extensions?.talkativeness ?? 0.5,
                        depth_prompt_prompt: d.depth_prompt?.prompt || '',
                        depth_prompt_depth: d.depth_prompt?.depth ?? 4,
                        depth_prompt_role: d.depth_prompt?.role || 'system',
                        embedded_world: getCharacterEmbeddedWorld(resolvedTarget.characterId),
                    },
                };
            }
            case TOOL_NAMES.CHARACTER_UPDATE_FIELDS: {
                if (!resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                // Form-level fields go through updateCharacterData (which feeds
                // /api/characters/edit and respects the form's deep-merge). Extension
                // fields are grouped by their top-level extension key, overlaid onto
                // the previous blob (so unspecified subkeys survive), and written via
                // writeExtensionField for the replace-semantics contract. `world` and
                // `tags` get special handling (world goes through charUpdatePrimaryWorld
                // for the embedded-book mirror cleanup; tags are exposed as a
                // comma-string but stored as an array).
                const FORM_FIELD_TO_PATH = {
                    name: 'name',
                    description: 'description',
                    personality: 'personality',
                    scenario: 'scenario',
                    first_mes: 'first_mes',
                    mes_example: 'mes_example',
                    system_prompt: 'system_prompt',
                    post_history_instructions: 'post_history_instructions',
                    creator_notes: 'creator_notes',
                    creator: 'creator',
                    character_version: 'character_version',
                };
                const EXT_FIELD_TO_PATH = {
                    talkativeness: ['talkativeness'],
                    depth_prompt_prompt: ['depth_prompt', 'prompt'],
                    depth_prompt_depth: ['depth_prompt', 'depth'],
                    depth_prompt_role: ['depth_prompt', 'role'],
                };
                const updated = [];
                const formPatch = {};
                /** @type {Record<string, any>} */
                const extPatchesByTopKey = {};
                const char = resolvedTarget.character;
                const prevExt = (char?.data?.extensions && typeof char.data.extensions === 'object')
                    ? char.data.extensions
                    : {};
                for (const [key, value] of Object.entries(args.fields || {})) {
                    if (key === 'world') {
                        if (!await charUpdatePrimaryWorld(String(value || ''), char)) {
                            return { ok: false, error: 'The character world book binding could not be confirmed.' };
                        }
                        updated.push(key);
                        continue;
                    }
                    if (key === 'tags') {
                        formPatch.tags = typeof value === 'string'
                            ? value.split(',').map(x => x.trim()).filter(Boolean)
                            : (Array.isArray(value) ? value : []);
                        updated.push(key);
                        continue;
                    }
                    if (FORM_FIELD_TO_PATH[key]) {
                        formPatch[FORM_FIELD_TO_PATH[key]] = value;
                        updated.push(key);
                        continue;
                    }
                    const extPath = EXT_FIELD_TO_PATH[key];
                    if (extPath) {
                        const [topKey, ...rest] = extPath;
                        if (!Object.prototype.hasOwnProperty.call(extPatchesByTopKey, topKey)) {
                            const prev = prevExt[topKey];
                            if (rest.length === 0) {
                                extPatchesByTopKey[topKey] = prev;
                            } else {
                                extPatchesByTopKey[topKey] = (prev && typeof prev === 'object' && !Array.isArray(prev))
                                    ? { ...prev }
                                    : {};
                            }
                        }
                        if (rest.length === 0) {
                            extPatchesByTopKey[topKey] = value;
                        } else {
                            let cursor = extPatchesByTopKey[topKey];
                            for (let i = 0; i < rest.length - 1; i++) {
                                const seg = rest[i];
                                if (!cursor[seg] || typeof cursor[seg] !== 'object' || Array.isArray(cursor[seg])) {
                                    cursor[seg] = {};
                                }
                                cursor = cursor[seg];
                            }
                            cursor[rest[rest.length - 1]] = value;
                        }
                        updated.push(key);
                    }
                }
                if (Object.keys(formPatch).length > 0) {
                    const characterId = getContext().characters.indexOf(char);
                    if (characterId < 0) return { ok: false, error: 'The character changed before its fields could be saved.' };
                    await getContext().updateCharacterData(characterId, formPatch, { immediate: true });
                }
                for (const [topKey, value] of Object.entries(extPatchesByTopKey)) {
                    const characterId = getContext().characters.indexOf(char);
                    if (characterId < 0) return { ok: false, error: 'The character changed before its fields could be saved.' };
                    if (await writeExtensionField(characterId, topKey, value) === false) {
                        return { ok: false, error: `Failed to save character extension: ${topKey}` };
                    }
                }
                return { ok: true, message: `Updated fields: ${updated.join(', ')}` };
            }
            // ==================== World Info ====================
            case TOOL_NAMES.WORLDINFO_LIST_BOOKS: {
                const charData = resolvedTarget?.character || null;
                const boundBook = String(charData?.data?.extensions?.world || '').trim();
                const auxBooks = (() => {
                    const fileName = charData?.avatar ? getCharaFilename(null, { manualAvatarKey: charData.avatar }) : '';
                    return getCharaAuxWorlds(fileName);
                })();
                const chatBooks = (() => {
                    try { return getChatWorldInfoNames(__ctx.chatMetadata); } catch { return []; }
                })();
                const globalBooks = Array.isArray(__ctx.chatWorldInfo.globalSelection) ? __ctx.chatWorldInfo.globalSelection : [];
                const books = [];
                const sources = {};
                const push = (name, source) => {
                    const trimmed = String(name || '').trim();
                    if (!trimmed || sources[trimmed]) return;
                    sources[trimmed] = source;
                    books.push(trimmed);
                };
                push(boundBook, 'character');
                for (const n of auxBooks) push(n, 'character_aux');
                for (const n of chatBooks) push(n, 'chat');
                for (const n of globalBooks) push(n, 'global');
                return { ok: true, books, sources };
            }
            case TOOL_NAMES.WORLDINFO_GET_ENTRIES: {
                const data = await loadWorldInfo(args.book_name);
                if (!data) return { ok: false, error: `World book "${args.book_name}" not found` };
                return { ok: true, entries: data.entries || {} };
            }
            case TOOL_NAMES.WORLDINFO_SEARCH_ENTRIES: {
                const bookName = String(args.book_name || '').trim();
                if (!bookName) return { ok: false, error: 'book_name is required' };
                const data = await loadWorldInfo(bookName);
                if (!data) return { ok: false, error: `World book "${bookName}" not found` };
                const text = String(args.text || '').trim().toLowerCase();
                const hasConstant = typeof args.constant === 'boolean';
                const hasEnabled = typeof args.enabled === 'boolean';
                if (!text && !hasConstant && !hasEnabled) {
                    return { ok: false, error: 'Provide at least one of: text, constant, enabled.' };
                }
                const limit = Math.max(1, Math.min(50, Number(args.limit) || 20)); // cap-ok: bounds the rows returned to the model so one tool result stays inside tool-output context limits
                const entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
                const hits = [];
                for (const [uidStr, entry] of Object.entries(entries)) {
                    if (!entry || typeof entry !== 'object') continue;
                    if (hasConstant && Boolean(entry.constant) !== Boolean(args.constant)) continue;
                    const isEnabled = !entry.disable;
                    if (hasEnabled && isEnabled !== Boolean(args.enabled)) continue;
                    if (text) {
                        const haystack = [
                            String(entry.comment || ''),
                            ...(Array.isArray(entry.key) ? entry.key : []).map(String),
                            ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []).map(String),
                            String(entry.content || ''),
                        ].join('\n').toLowerCase();
                        if (!haystack.includes(text)) continue;
                    }
                    const content = String(entry.content || '');
                    hits.push({
                        uid: Number(uidStr),
                        comment: String(entry.comment || ''),
                        key: Array.isArray(entry.key) ? entry.key.slice() : [],
                        keysecondary: Array.isArray(entry.keysecondary) ? entry.keysecondary.slice() : [],
                        constant: Boolean(entry.constant),
                        enabled: isEnabled,
                        content_preview: content.length > 200 ? content.slice(0, 200) + '…' : content,
                    });
                }
                return { ok: true, book_name: bookName, total_hits: hits.length, returned_hits: Math.min(hits.length, limit), entries: hits.slice(0, limit) };
            }
            case TOOL_NAMES.WORLDINFO_CREATE_ENTRY: {
                const data = await loadWorldInfo(args.book_name);
                if (!data) return { ok: false, error: `World book "${args.book_name}" not found` };
                const newEntry = createWorldInfoEntry(args.book_name, data);
                if (!newEntry) return { ok: false, error: 'Failed to create entry' };
                const { book_name: _bn, ...entryFields } = args;
                if (Object.keys(entryFields).length > 0) {
                    Object.assign(newEntry, entryFields);
                }
                await saveWorldInfo(args.book_name, data, true, { refreshEditor: true });
                return { ok: true, entry: newEntry };
            }
            case TOOL_NAMES.WORLDINFO_UPDATE_ENTRY: {
                const data = await loadWorldInfo(args.book_name);
                if (!data) return { ok: false, error: `World book "${args.book_name}" not found` };
                const entry = data.entries?.[args.uid];
                if (!entry) return { ok: false, error: `Entry UID ${args.uid} not found` };
                Object.assign(entry, args.patch);
                entry.uid = args.uid;
                await saveWorldInfo(args.book_name, data, true, { refreshEditor: true });
                return { ok: true, message: `Entry ${args.uid} updated` };
            }
            case TOOL_NAMES.WORLDINFO_DELETE_ENTRY: {
                const data = await loadWorldInfo(args.book_name);
                if (!data) return { ok: false, error: `World book "${args.book_name}" not found` };
                await deleteWorldInfoEntry(data, args.uid, { silent: true });
                await saveWorldInfo(args.book_name, data, true, { refreshEditor: true });
                return { ok: true, message: `Entry ${args.uid} deleted` };
            }
            case TOOL_NAMES.WORLDINFO_CREATE_BOOK: {
                const name = String(args?.book_name || '').trim();
                if (!name) return { ok: false, error: 'book_name required' };
                if (__ctx.getWorldInfoNames().includes(name)) {
                    return { ok: true, book_name: name, message: `World book "${name}" already exists.`, created: false };
                }
                const created = await createNewWorldInfo(name, { interactive: false });
                if (!created) return { ok: false, error: `Failed to create world book "${name}"` };
                return { ok: true, book_name: name, message: `World book "${name}" created.`, created: true };
            }
            case TOOL_NAMES.CHARACTER_IMPORT_EMBEDDED_WORLD: {
                if (!resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                const charData = resolvedTarget.character;
                const book = charData?.data?.character_book;
                if (!book) {
                    return { ok: false, error: 'No embedded world book on this character (data.character_book is empty).' };
                }
                const boundName = String(charData?.data?.extensions?.world || '').trim();
                if (boundName && __ctx.getWorldInfoNames().includes(boundName)) {
                    return { ok: true, message: `Character is already bound to world "${boundName}"; embedded book skipped.`, imported: false, bound: true, world: boundName };
                }
                const outcome = await importEmbeddedWorldInfo(true, charData);
                if (!outcome.bound) {
                    return { ok: false, imported: outcome.imported, bound: false, world: outcome.bookName, error: outcome.imported
                        ? 'The world book was imported, but its character binding could not be confirmed.'
                        : 'The embedded world book could not be imported.' };
                }
                return { ok: true, message: `Embedded world imported and bound as "${outcome.bookName}".`, imported: true, bound: true, world: outcome.bookName };
            }
            case TOOL_NAMES.WORLDINFO_REPLACE_ENTRIES: {
                const data = await loadWorldInfo(args?.book_name);
                if (!data) return { ok: false, error: `World book "${args?.book_name}" not found` };
                const list = Array.isArray(args?.entries) ? args.entries : [];
                data.entries = {};
                const created = [];
                for (const partial of list) {
                    const newEntry = createWorldInfoEntry(args.book_name, data);
                    if (!newEntry) continue;
                    if (partial && typeof partial === 'object') {
                        const { uid: _ignoredUid, ...fields } = partial;
                        Object.assign(newEntry, fields);
                    }
                    created.push(newEntry);
                }
                await saveWorldInfo(args.book_name, data, true, { refreshEditor: true });
                return { ok: true, entries: created, message: `Replaced entries in "${args.book_name}" (${created.length} written).` };
            }
            // ==================== Regex Scripts ====================
            case TOOL_NAMES.REGEX_LIST_SCRIPTS: {
                const { SCRIPT_TYPES, getScriptsByType } = getRegexApi();
                const scope = String(args?.scope || 'all').toLowerCase();
                const scopedOpts = resolvedTarget
                    ? { target: { scriptType: SCRIPT_TYPES.SCOPED, characterId: resolvedTarget.characterId, character: resolvedTarget.character, avatar: resolvedTarget.avatar } }
                    : undefined;
                const readScoped = () => (hasExplicitTarget && !resolvedTarget
                    ? []
                    : normalizeRegexScriptsForTool(scopedOpts ? getScriptsByType(SCRIPT_TYPES.SCOPED, scopedOpts) : getScriptsByType(SCRIPT_TYPES.SCOPED)));
                if (scope === 'all') {
                    return {
                        ok: true,
                        character: readScoped(),
                        global: normalizeRegexScriptsForTool(getScriptsByType(SCRIPT_TYPES.GLOBAL)),
                    };
                }
                if (scope === 'character') {
                    if (hasExplicitTarget && !resolvedTarget) {
                        return { ok: false, error: missingTargetError };
                    }
                    return { ok: true, scope, scripts: readScoped() };
                }
                if (scope === 'global') {
                    return { ok: true, scope, scripts: normalizeRegexScriptsForTool(getScriptsByType(SCRIPT_TYPES.GLOBAL)) };
                }
                return { ok: false, error: `Unknown scope "${scope}" — use 'character', 'global', or 'all'` };
            }
            case TOOL_NAMES.REGEX_CREATE_SCRIPT: {
                const { SCRIPT_TYPES, getScriptsByType, omitLegacyPluginScope, saveScriptsByType } = getRegexApi();
                const scope = String(args?.scope || '').toLowerCase();
                if (scope !== 'character' && scope !== 'global') {
                    return { ok: false, error: 'scope must be \'character\' or \'global\'' };
                }
                const liveCtx = getContext() || __ctx;
                const hasScopedCharacter = Boolean(resolvedTarget) || (!hasExplicitTarget && liveCtx.characterId !== undefined && liveCtx.characterId !== null);
                if (scope === 'character' && !hasScopedCharacter) {
                    return { ok: false, error: hasExplicitTarget ? missingTargetError : 'No active character — cannot write card-level regex' };
                }
                const scriptType = scope === 'character' ? SCRIPT_TYPES.SCOPED : SCRIPT_TYPES.GLOBAL;
                const scopedOpts = scope === 'character' && resolvedTarget
                    ? { target: { scriptType: SCRIPT_TYPES.SCOPED, characterId: resolvedTarget.characterId, character: resolvedTarget.character, avatar: resolvedTarget.avatar } }
                    : undefined;
                const { scope: _scopeArg, id: _ignoredId, ...userFields } = omitLegacyPluginScope(args || {});
                const newScript = {
                    scriptName: '',
                    findRegex: '',
                    replaceString: '',
                    trimStrings: [],
                    placement: [],
                    disabled: false,
                    markdownOnly: false,
                    promptOnly: false,
                    pluginLanes: [],
                    runOnEdit: false,
                    substituteRegex: 0,
                    minDepth: null,
                    maxDepth: null,
                    ...userFields,
                    id: uuidv4(),
                };
                const current = scopedOpts ? getScriptsByType(scriptType, scopedOpts) : getScriptsByType(scriptType);
                const next = [...current, newScript];
                if (scopedOpts) {
                    await saveScriptsByType(next, scriptType, scopedOpts);
                } else {
                    await saveScriptsByType(next, scriptType);
                }
                return { ok: true, script: normalizeRegexScriptForTool(newScript) };
            }
            case TOOL_NAMES.REGEX_UPDATE_SCRIPT: {
                const { SCRIPT_TYPES, getScriptsByType, omitLegacyPluginScope, normalizePluginScriptRecord, saveScriptsByType } = getRegexApi();
                const scope = String(args?.scope || '').toLowerCase();
                if (scope !== 'character' && scope !== 'global') {
                    return { ok: false, error: 'scope must be \'character\' or \'global\'' };
                }
                const liveCtx = getContext() || __ctx;
                const hasScopedCharacter = Boolean(resolvedTarget) || (!hasExplicitTarget && liveCtx.characterId !== undefined && liveCtx.characterId !== null);
                if (scope === 'character' && !hasScopedCharacter) {
                    return { ok: false, error: hasExplicitTarget ? missingTargetError : 'No active character — cannot write card-level regex' };
                }
                const scriptType = scope === 'character' ? SCRIPT_TYPES.SCOPED : SCRIPT_TYPES.GLOBAL;
                const scopedOpts = scope === 'character' && resolvedTarget
                    ? { target: { scriptType: SCRIPT_TYPES.SCOPED, characterId: resolvedTarget.characterId, character: resolvedTarget.character, avatar: resolvedTarget.avatar } }
                    : undefined;
                const idStr = String(args?.id || '').trim();
                if (!idStr) return { ok: false, error: 'id is required' };
                const current = scopedOpts ? getScriptsByType(scriptType, scopedOpts) : getScriptsByType(scriptType);
                const idx = current.findIndex((s) => String(s?.id || '') === idStr);
                if (idx < 0) return { ok: false, error: `Regex script "${idStr}" not found in ${scope} scope` };
                const rawPatch = (args?.patch && typeof args.patch === 'object') ? args.patch : {};
                const patch = omitLegacyPluginScope(rawPatch);
                const updated = { ...normalizePluginScriptRecord(current[idx]), ...patch, id: idStr };
                const next = current.slice();
                next[idx] = updated;
                if (scopedOpts) {
                    await saveScriptsByType(next, scriptType, scopedOpts);
                } else {
                    await saveScriptsByType(next, scriptType);
                }
                return { ok: true, script: normalizeRegexScriptForTool(updated) };
            }
            case TOOL_NAMES.REGEX_DELETE_SCRIPT: {
                const { SCRIPT_TYPES, getScriptsByType, saveScriptsByType } = getRegexApi();
                const scope = String(args?.scope || '').toLowerCase();
                if (scope !== 'character' && scope !== 'global') {
                    return { ok: false, error: 'scope must be \'character\' or \'global\'' };
                }
                const liveCtx = getContext() || __ctx;
                const hasScopedCharacter = Boolean(resolvedTarget) || (!hasExplicitTarget && liveCtx.characterId !== undefined && liveCtx.characterId !== null);
                if (scope === 'character' && !hasScopedCharacter) {
                    return { ok: false, error: hasExplicitTarget ? missingTargetError : 'No active character — cannot write card-level regex' };
                }
                const scriptType = scope === 'character' ? SCRIPT_TYPES.SCOPED : SCRIPT_TYPES.GLOBAL;
                const scopedOpts = scope === 'character' && resolvedTarget
                    ? { target: { scriptType: SCRIPT_TYPES.SCOPED, characterId: resolvedTarget.characterId, character: resolvedTarget.character, avatar: resolvedTarget.avatar } }
                    : undefined;
                const idStr = String(args?.id || '').trim();
                if (!idStr) return { ok: false, error: 'id is required' };
                const current = scopedOpts ? getScriptsByType(scriptType, scopedOpts) : getScriptsByType(scriptType);
                const next = current.filter((s) => String(s?.id || '') !== idStr);
                if (next.length === current.length) {
                    return { ok: false, error: `Regex script "${idStr}" not found in ${scope} scope` };
                }
                if (scopedOpts) {
                    await saveScriptsByType(next, scriptType, scopedOpts);
                } else {
                    await saveScriptsByType(next, scriptType);
                }
                return { ok: true, message: `Regex script "${idStr}" deleted from ${scope} scope.` };
            }
            // ==================== Orchestrator (per-character preset) ====================
            case TOOL_NAMES.ORCHESTRATOR_GET_OVERRIDE: {
                if (!resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                const orch = __ctx.getExtensionApi('orchestrator');
                if (!orch) return { ok: false, error: 'orchestrator extension is not loaded' };
                const lukerCtx = resolvedTarget.ctx;
                const avatar = resolvedTarget.avatar;
                if (!avatar) return { ok: false, error: 'Character has no avatar' };
                const savedMode = orch.getCharacterSavedExecutionModeByAvatar(lukerCtx, avatar);
                if (!savedMode) return { ok: true, override: null };
                return {
                    ok: true,
                    override: {
                        mode: savedMode,
                        enabled: orch.getRuntimePresetScope(lukerCtx, avatar, savedMode) === 'character',
                        activePresetId: orch.getCharacterActivePresetId(lukerCtx, avatar, savedMode),
                    },
                };
            }
            case TOOL_NAMES.ORCHESTRATOR_SET_OVERRIDE: {
                if (!resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                if (typeof args?.presetId !== 'string') {
                    return { ok: false, error: 'presetId must be a string — the card preset id to activate, or an empty string to fall back to the global active preset' };
                }
                const orch = __ctx.getExtensionApi('orchestrator');
                if (!orch) return { ok: false, error: 'orchestrator extension is not loaded' };
                const lukerCtx = resolvedTarget.ctx;
                const avatar = resolvedTarget.avatar;
                if (!avatar) return { ok: false, error: 'Character has no avatar' };
                const result = await orch.setCharacterActivePresetForSavedMode(
                    lukerCtx,
                    extension_settings?.orchestrator,
                    avatar,
                    args.presetId,
                );
                if (result.ok) {
                    return {
                        ok: true,
                        message: args.presetId === ''
                            ? `Card now runs the global active preset for mode "${result.mode}".`
                            : `Card preset "${args.presetId}" activated for mode "${result.mode}".`,
                        mode: result.mode,
                        presetId: args.presetId,
                    };
                }
                switch (result.reason) {
                    case 'no_saved_mode':
                        return { ok: false, error: 'Character has no orchestrator preset library to switch. Populate one through the orchestrator iteration studio first.' };
                    case 'preset_not_found':
                        return { ok: false, error: `Preset id "${args.presetId}" not found in the card's ${result.mode} library` };
                    case 'character_not_found':
                        return { ok: false, error: 'Character not found in context' };
                    case 'persist_failed':
                        return { ok: false, error: 'Failed to save the card after switching the active preset' };
                    default:
                        return { ok: false, error: 'Failed to switch the card active preset' };
                }
            }
            case TOOL_NAMES.ORCHESTRATOR_CLEAR_OVERRIDE: {
                if (!resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                const orch = __ctx.getExtensionApi('orchestrator');
                if (!orch) return { ok: false, error: 'orchestrator extension is not loaded' };
                const lukerCtx = resolvedTarget.ctx;
                const avatar = resolvedTarget.avatar;
                if (!avatar) return { ok: false, error: 'Character has no avatar' };
                const characterIndex = orch.getCharacterIndexByAvatar(lukerCtx, avatar);
                if (characterIndex < 0) return { ok: false, error: 'Character not found in context' };
                const ok = await orch.persistOrchestratorCharacterExtension(lukerCtx, characterIndex, (current) => {
                    const nextPayload = (current && typeof current === 'object') ? { ...current } : {};
                    delete nextPayload.override;
                    delete nextPayload.presetLibraries;
                    delete nextPayload.activePresetIds;
                    delete nextPayload.overrideEnabled;
                    return Object.keys(nextPayload).length === 0 ? null : nextPayload;
                });
                if (ok) {
                    // Realign mode flag — the runtime would otherwise keep the prior
                    // override's pinned mode active even though the override is gone.
                    orch.applyCharacterExecutionModeForAvatar(lukerCtx, extension_settings?.orchestrator, avatar);
                }
                return ok ? { ok: true, message: 'Orchestrator override cleared (falling back to global).' } : { ok: false, error: 'Failed to clear orchestrator override' };
            }
            // ==================== Memory Graph (per-character override) ====================
            case TOOL_NAMES.MEMORY_GRAPH_GET: {
                const mg = __ctx.getExtensionApi('memory-graph');
                if (!mg) return { ok: false, error: 'memory-graph extension is not loaded' };
                if (hasExplicitTarget && !resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                const lukerCtx = resolvedTarget
                    ? { ...resolvedTarget.ctx, characterId: resolvedTarget.characterId }
                    : getContext();
                const schemaInfo = mg.getSchemaScopeInfo(lukerCtx);
                const advancedInfo = mg.getAdvancedScopeInfo(lukerCtx);
                return {
                    ok: true,
                    schema: { scope: schemaInfo.scope, hasOverride: !!schemaInfo.hasOverride, schema: schemaInfo.schema },
                    advanced: { scope: advancedInfo.scope, hasOverride: !!advancedInfo.hasOverride, settings: advancedInfo.settings },
                };
            }
            case TOOL_NAMES.MEMORY_GRAPH_SET_SCHEMA: {
                if (!resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                const mg = __ctx.getExtensionApi('memory-graph');
                if (!mg) return { ok: false, error: 'memory-graph extension is not loaded' };
                const lukerCtx = resolvedTarget.ctx;
                const avatar = resolvedTarget.avatar;
                if (!avatar) return { ok: false, error: 'Character has no avatar' };
                const schema = args?.schema;
                const isClear = schema === null || schema === undefined;
                const ok = isClear
                    ? await mg.removeCharacterSchemaOverride(lukerCtx, avatar)
                    : await mg.persistCharacterSchemaOverride(lukerCtx, avatar, schema);
                return ok
                    ? { ok: true, message: isClear ? 'Memory-graph schema override cleared (falling back to global).' : 'Memory-graph schema override updated.' }
                    : { ok: false, error: 'Failed to update memory-graph schema override' };
            }
            case TOOL_NAMES.MEMORY_GRAPH_SET_ADVANCED: {
                if (!resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                const mg = __ctx.getExtensionApi('memory-graph');
                if (!mg) return { ok: false, error: 'memory-graph extension is not loaded' };
                const lukerCtx = resolvedTarget.ctx;
                const avatar = resolvedTarget.avatar;
                if (!avatar) return { ok: false, error: 'Character has no avatar' };
                const advanced = args?.advanced;
                const isClear = advanced === null || advanced === undefined;
                const ok = isClear
                    ? await mg.removeCharacterAdvancedOverride(lukerCtx, avatar)
                    : await mg.persistCharacterAdvancedOverride(lukerCtx, avatar, advanced);
                return ok
                    ? { ok: true, message: isClear ? 'Memory-graph advanced override cleared (falling back to global).' : 'Memory-graph advanced override updated.' }
                    : { ok: false, error: 'Failed to update memory-graph advanced override' };
            }
            case TOOL_NAMES.SLASHCMD_LIST: {
                const filter = String(args?.filter || '').toLowerCase();
                const seen = new Set();
                const list = [];
                const allCommands = SlashCommandParser.commands || {};
                for (const [registeredName, cmd] of Object.entries(allCommands)) {
                    if (!cmd || seen.has(cmd)) continue;
                    seen.add(cmd);
                    const primary = cmd.name || registeredName;
                    if (filter && !primary.toLowerCase().includes(filter)) continue;
                    const helpRaw = String(cmd.helpString || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    list.push({
                        name: primary,
                        help: helpRaw.length > 160 ? helpRaw.slice(0, 157) + '...' : helpRaw,
                        aliases: Array.isArray(cmd.aliases) ? cmd.aliases : [],
                    });
                }
                list.sort((a, b) => a.name.localeCompare(b.name));
                return { ok: true, count: list.length, commands: list };
            }
            case TOOL_NAMES.SLASHCMD_HELP: {
                const name = String(args?.name || '').replace(/^\//, '').trim();
                if (!name) return { ok: false, error: 'name is required' };
                const cmd = SlashCommandParser.commands?.[name];
                if (!cmd) return { ok: false, error: `Slash command "${name}" not found (try slashcmd_list to see all available commands)` };
                const summarizeArg = (arg, includeName) => {
                    const enumVals = Array.isArray(arg.enumList) ? arg.enumList.map(e => ({
                        value: e?.value ?? String(e ?? ''),
                        description: String(e?.description || ''),
                    })) : [];
                    const out = {
                        description: String(arg.description || ''),
                        types: Array.isArray(arg.typeList) ? arg.typeList : [],
                        isRequired: !!arg.isRequired,
                        acceptsMultiple: !!arg.acceptsMultiple,
                        defaultValue: typeof arg.defaultValue === 'string' ? arg.defaultValue : null,
                        enumValues: enumVals,
                        forceEnum: !!arg.forceEnum,
                    };
                    if (includeName) {
                        out.name = arg.name || '';
                        out.aliases = Array.isArray(arg.aliasList) ? arg.aliasList : [];
                    }
                    return out;
                };
                return {
                    ok: true,
                    name: cmd.name || name,
                    aliases: Array.isArray(cmd.aliases) ? cmd.aliases : [],
                    helpString: String(cmd.helpString || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
                    returns: String(cmd.returns || ''),
                    source: String(cmd.source || ''),
                    isExtension: !!cmd.isExtension,
                    namedArguments: Array.isArray(cmd.namedArgumentList) ? cmd.namedArgumentList.map(a => summarizeArg(a, true)) : [],
                    unnamedArguments: Array.isArray(cmd.unnamedArgumentList) ? cmd.unnamedArgumentList.map(a => summarizeArg(a, false)) : [],
                };
            }
            case TOOL_NAMES.LUKER_CTX_LIST_KEYS: {
                return await listCtxKeys({ filter: String(args?.filter || '') });
            }
            case TOOL_NAMES.LUKER_CTX_DESCRIBE: {
                return await describeCtxPath({ path: String(args?.path || '') });
            }
            case TOOL_NAMES.DOCS_LIST: {
                return await listLukerDocs({
                    filter: String(args?.filter || ''),
                    includeTranslations: !!args?.includeTranslations,
                });
            }
            case TOOL_NAMES.DOCS_READ: {
                return await readLukerDoc({ path: String(args?.path || '') });
            }
            case TOOL_NAMES.CARDAPP_SET_ENABLED: {
                if (!resolvedTarget) {
                    return { ok: false, error: missingTargetError };
                }
                const next = !!args?.enabled;
                const char = resolvedTarget.character;
                const previous = !!char?.data?.extensions?.card_app?.enabled;
                if (await writeExtensionField(resolvedTarget.characterId, 'card_app', (current) => ({
                    ...(current && typeof current === 'object' ? current : {}),
                    enabled: next,
                })) === false) {
                    return { ok: false, error: 'Failed to save CardApp activation' };
                }
                // Keep the editor checkbox in sync only if the same character is currently open in the editor.
                if (resolvedTarget.ctx?.characterId === resolvedTarget.characterId) {
                    const $checkbox = $('#card_app_enabled');
                    if ($checkbox.length > 0 && $checkbox.prop('checked') !== next) {
                        $checkbox.prop('checked', next);
                    }
                }
                return {
                    ok: true,
                    was_enabled: previous,
                    is_enabled: next,
                    changed: previous !== next,
                    message: previous === next
                        ? `CardApp was already ${next ? 'enabled' : 'disabled'}.`
                        : `CardApp ${next ? 'enabled' : 'disabled'}.`,
                };
            }
            default:
                return { ok: false, error: `Unknown tool: ${toolName}` };
        }
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
}

// ==================== System Prompt ====================

// Canonical default prompt lives in ../defaults.js (re-exported below).
// ==================== AI Chat Loop ====================

let makeCallId = (() => {
    let counter = 0;
    return () => `call_${Date.now()}_${counter++}`;
})();

/**
 * Send a user message and get AI response with tool execution.
 * @param {string} charId - Character ID
 * @param {Array} conversationMessages - Message history [{role, content, tool_calls?, tool_call_id?}]
 * @param {string} userMessage - User's message
 * @param {object} options
 * @param {AbortSignal} [options.abortSignal]
 * @param {string} options.systemPrompt
 * @param {function} [options.onToolCall] - Callback when a tool is called: (toolName, args, result) => void
 * @param {function} [options.onAssistantText] - Callback when assistant produces text: (text) => void
 * @param {function} [options.onPendingApproval] - Callback when a file modification needs approval: (pendingOp) => Promise<boolean> (true=approved, false=rejected)
 * @returns {Promise<{assistantText: string, toolCalls: Array, modifiedFiles: string[]}>}
 */
export async function sendAIMessage(charId, conversationMessages, userMessage, options = {}) {
    const {
        abortSignal = null,
        character: explicitCharacter = null,
        systemPrompt,
        onToolCall = null,
        onAssistantText = null,
        onPendingApproval = null,
        llmPresetName = '',
        apiPresetName = '',
    } = options;

    requireStoredPrompt(systemPrompt, i18n('Fill in the prompt or reset it to the default.'));
    const tools = buildTools();
    const allowedNames = new Set(Object.values(TOOL_NAMES));
    const modifiedFiles = [];

    const ctx = getContext();
    if (!ctx || typeof ctx.generateTask !== 'function') {
        throw new Error('context.generateTask is unavailable.');
    }
    const character = explicitCharacter || ctx.characters.find(card => card?.avatar && getCharaFilename(null, { manualAvatarKey: card.avatar }) === charId);

    // Add user message
    conversationMessages.push({ role: 'user', content: userMessage });

    let lastAssistantText = '';

    const runLoop = async () => {
        // Multi-round tool calling loop. Program-driven: any tool call this round
        // reruns the loop, a plain-text response (no tool calls) exits it.
        while (true) {
            if (abortSignal?.aborted) {
                throw new Error('Request aborted');
            }

            // Studio is a dev/authoring tool — the character card is visible (so the
            // AI knows the persona it's authoring without GETting first), but world
            // info stays empty: world books are content the Studio AI edits, not
            // context it should reason against. substituteMacros:false keeps
            // {{user}}/{{char}}/etc. in conversation messages literal so the AI sees
            // the source text it is asked to edit, not the rendered version.
            const generateTaskOpts = {
                taskMessages: [
                    { role: 'system', content: systemPrompt },
                    ...conversationMessages,
                ],
                includeCharacterCard: true,
                worldInfoSource: 'none',
                runtimeWorldInfo: {},
                apiPresetName: String(apiPresetName || '').trim(),
                llmPresetName: String(llmPresetName || '').trim(),
                tools,
                toolChoice: 'auto',
                functionCallMode: 'auto',
                functionCallOptions: {
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
                abortSignal: abortSignal || undefined,
                substituteMacros: false,
            };
            const result = await ctx.generateTask(generateTaskOpts);

            if (abortSignal?.aborted) {
                throw new Error('Request aborted');
            }

            const assistantText = String(result?.assistantText || '').trim();
            const resultReasoning = String(result?.reasoning || '');
            const resultSignature = typeof result?.signature === 'string' && result.signature.length > 0
                ? result.signature
                : null;
            const resultReasoningBlocks = Array.isArray(result?.reasoningBlocks) && result.reasoningBlocks.length > 0
                ? result.reasoningBlocks
                : null;
            const resultReasoningDetails = Array.isArray(result?.reasoningDetails) && result.reasoningDetails.length > 0
                ? result.reasoningDetails
                : null;
            const resultNativeParts = Array.isArray(result?.nativeParts) && result.nativeParts.length > 0
                ? result.nativeParts
                : null;
            const resultNativeContentBlocks = Array.isArray(result?.nativeContentBlocks) && result.nativeContentBlocks.length > 0
                ? result.nativeContentBlocks
                : null;
            const resultResponsesOutputItems = Array.isArray(result?.responsesOutputItems) && result.responsesOutputItems.length > 0
                ? result.responsesOutputItems
                : null;
            const rawCalls = (Array.isArray(result?.toolCalls) ? result.toolCalls : [])
                .map(call => {
                    const callSig = typeof call?.signature === 'string' && call.signature.length > 0
                        ? call.signature
                        : (typeof call?.raw?.signature === 'string' && call.raw.signature.length > 0
                            ? call.raw.signature
                            : (typeof call?.raw?.thoughtSignature === 'string' && call.raw.thoughtSignature.length > 0 ? call.raw.thoughtSignature : null));
                    const callExtra = call?.extra_content && typeof call.extra_content === 'object'
                        ? structuredClone(call.extra_content)
                        : (call?.raw?.extra_content && typeof call.raw.extra_content === 'object' ? structuredClone(call.raw.extra_content) : null);
                    return {
                        id: String(call?.raw?.id || '').trim() || makeCallId(),
                        name: String(call?.name || '').trim(),
                        args: call?.args && typeof call.args === 'object' ? call.args : {},
                        ...(callSig ? { signature: callSig } : {}),
                        ...(callExtra ? { extra_content: callExtra } : {}),
                    };
                })
                .filter(call => allowedNames.has(call.name));

            lastAssistantText = assistantText;

            // Surface the assistant's prose BEFORE running tools so the chat shows
            // text → tool approval/result, matching the AI's actual generation order.
            // Otherwise the approval dialog pops first with no explanatory context.
            if (assistantText && onAssistantText) {
                onAssistantText(assistantText);
            }

            // No tool calls — conversation turn is done
            if (rawCalls.length === 0) {
                if (assistantText) {
                    conversationMessages.push({
                        role: 'assistant',
                        content: assistantText,
                        ...(resultReasoning ? { reasoning: resultReasoning } : {}),
                        ...(resultSignature ? { signature: resultSignature } : {}),
                        ...(resultReasoningBlocks ? { reasoning_blocks: resultReasoningBlocks } : {}),
                        ...(resultReasoningDetails ? { reasoning_details: resultReasoningDetails } : {}),
                        ...(resultNativeParts ? { native_parts: resultNativeParts } : {}),
                        ...(resultNativeContentBlocks ? { native_content_blocks: resultNativeContentBlocks } : {}),
                        ...(resultResponsesOutputItems ? { responses_output_items: resultResponsesOutputItems } : {}),
                    });
                }
                break;
            }

            // Execute tool calls in three steps:
            //  (a) run every tool; file-op tools defer into pendingFileOpItems while
            //      non-file-op tools resolve immediately.
            //  (b) resolve the file-op batch at round end: applyEdits → conflict UI →
            //      single approval card → commit walker.
            //  (c) append assistant message + tool results.
            const toolCallsForMessage = [];
            const toolResults = [];
            const pendingFileOpItems = [];

            // Step (a): execute tools
            for (const call of rawCalls) {
                if (abortSignal?.aborted) {
                    throw new Error('Request aborted');
                }

                const name = String(call.name || '').trim();
                const args = call.args && typeof call.args === 'object' ? call.args : {};
                const callId = String(call.id || '').trim() || makeCallId();

                // file-op tools always defer; the round-end batch handles both
                // auto-apply and approval modes uniformly through edits-lib.
                const result = await executeTool(charId, name, args, { deferWriteOps: true, character });

                toolCallsForMessage.push({
                    id: callId,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                    ...(call.signature ? { signature: call.signature } : {}),
                    ...(call.extra_content ? { extra_content: call.extra_content } : {}),
                });

                if (result.pending_edit) {
                    const slot = toolResults.length;
                    toolResults.push({ role: 'tool', tool_call_id: callId, content: null });
                    pendingFileOpItems.push({
                        edit: result.edit,
                        displayPath: result.displayPath,
                        tool: result.tool,
                        args,
                        callId,
                        slot,
                    });
                } else {
                    if (onToolCall) onToolCall(name, args, result);
                    toolResults.push({
                        role: 'tool',
                        tool_call_id: callId,
                        content: JSON.stringify(result),
                    });
                }
            }

            // Step (b): resolve file-op batch (if any)
            if (pendingFileOpItems.length > 0) {
                const batchEdits = pendingFileOpItems.map(it => it.edit);
                const live = await loadCardAppFilesLive(charId, batchEdits);

                let batchOutcome = '';
                let batchError = '';
                let resolvedClean = [];
                let resolvedNewLive = null;

                let applyResult;
                try {
                    applyResult = applyEdits(batchEdits, live);
                    resolvedClean = applyResult.clean;
                    resolvedNewLive = applyResult.newLive;
                } catch (e) {
                    batchOutcome = 'apply_failed';
                    batchError = String(e?.message || e);
                }

                if (applyResult && applyResult.conflicts.length > 0) {
                    if (!onPendingApproval) {
                        // Auto-apply mode: don't pop a modal mid-stream. Conflicts can't
                        // be silently swallowed — fail the batch so the AI sees it.
                        batchOutcome = 'conflict_cancelled';
                        batchError = 'Auto-apply detected drift between AI proposal and current files.';
                    } else {
                        const resolutions = await showConflictResolution(applyResult.conflicts);
                        if (!resolutions) {
                            batchOutcome = 'conflict_cancelled';
                            batchError = 'User cancelled conflict resolution.';
                        } else {
                            const resolved = [...applyResult.clean];
                            for (const r of resolutions) {
                                if (r.decision === 'apply-mine') resolved.push(r.edit);
                                else if (r.decision === 'manual') {
                                    if (r.edit.op === 'set') resolved.push({ ...r.edit, newValue: r.newValue });
                                    else resolved.push(r.edit);
                                }
                                // 'keep-theirs' = drop
                            }
                            try {
                                applyResult = applyEdits(resolved, live);
                                resolvedClean = applyResult.clean;
                                resolvedNewLive = applyResult.newLive;
                            } catch (e) {
                                batchOutcome = 'apply_failed';
                                batchError = `apply after resolution failed: ${String(e?.message || e)}`;
                            }
                        }
                    }
                }

                if (!batchOutcome) {
                    // No conflicts (or all resolved). Ask for approval if a callback is
                    // wired; otherwise auto-commit.
                    const approved = onPendingApproval
                        ? await onPendingApproval({
                            items: pendingFileOpItems.map(it => ({
                                edit: it.edit,
                                displayPath: it.displayPath,
                                tool: it.tool,
                            })),
                            live,
                            newLive: resolvedNewLive,
                        })
                        : true;
                    if (approved) {
                        try {
                            await commitFileOpEdits(charId, resolvedClean, resolvedNewLive);
                            batchOutcome = 'approved';
                        } catch (e) {
                            batchOutcome = 'commit_failed';
                            batchError = String(e?.message || e);
                        }
                    } else {
                        batchOutcome = 'rejected';
                        batchError = 'User rejected the batch of file modifications.';
                    }
                }

                // Fill toolResults placeholders + fire onToolCall per item.
                // Per-item outcome reflects the truth of THIS edit's apply:
                // `clean` ⇒ applied, `alreadyDone` ⇒ target was already in the
                // desired state (no write), otherwise something dropped via
                // conflict resolution (keep-theirs or manual replacement). Without
                // this distinction the model thinks every edit it proposed landed,
                // even when half the batch was already-done no-ops — same silent-
                // failure class CPA had pre-fix.
                const cleanRefs = new Set(resolvedClean);
                const alreadyDoneRefs = new Set(applyResult?.alreadyDone || []);
                for (const item of pendingFileOpItems) {
                    let r;
                    if (batchOutcome === 'approved') {
                        if (alreadyDoneRefs.has(item.edit)) {
                            r = { ok: true, alreadyDone: true, message: `${item.displayPath}: no change needed (target was already in the desired state).` };
                        } else if (cleanRefs.has(item.edit)) {
                            r = { ok: true, message: `${item.displayPath} applied.` };
                        } else {
                            // Edit isn't in clean or alreadyDone — must have been
                            // dropped via keep-theirs in the conflict modal, or
                            // replaced by a manual-resolution edit at the same path.
                            // Surface the latter as applied (some change landed for
                            // this path), the former as skipped.
                            const resolvedAtPath = item.edit?.path
                                && resolvedClean.some(e => e?.path === item.edit.path);
                            r = resolvedAtPath
                                ? { ok: true, message: `${item.displayPath} applied (via conflict resolution).` }
                                : { ok: true, skipped: true, message: `${item.displayPath}: skipped via conflict resolution (keep-theirs).` };
                        }
                    } else if (batchOutcome === 'commit_failed') {
                        r = { ok: false, error: `commit failed: ${batchError}` };
                    } else if (batchOutcome === 'apply_failed') {
                        r = { ok: false, error: `apply failed: ${batchError}` };
                    } else {
                        r = { ok: false, error: batchError || 'Batch failed.' };
                    }
                    toolResults[item.slot].content = JSON.stringify(r);
                    if (onToolCall) onToolCall(item.tool, item.args, r);
                }

                // modifiedFiles tracking — derive from applied clean edits.
                if (batchOutcome === 'approved') {
                    for (const e of resolvedClean) {
                        for (const p of extractPathsFromEdit(e)) {
                            if (p && !modifiedFiles.includes(p)) modifiedFiles.push(p);
                        }
                    }
                }
            }

            // Append assistant message with tool calls
            conversationMessages.push({
                role: 'assistant',
                content: assistantText || '',
                ...(resultReasoning ? { reasoning: resultReasoning } : {}),
                ...(resultSignature ? { signature: resultSignature } : {}),
                ...(resultReasoningBlocks ? { reasoning_blocks: resultReasoningBlocks } : {}),
                ...(resultReasoningDetails ? { reasoning_details: resultReasoningDetails } : {}),
                ...(resultNativeParts ? { native_parts: resultNativeParts } : {}),
                ...(resultNativeContentBlocks ? { native_content_blocks: resultNativeContentBlocks } : {}),
                ...(resultResponsesOutputItems ? { responses_output_items: resultResponsesOutputItems } : {}),
                tool_calls: toolCallsForMessage,
            });

            // Append tool results
            for (const result of toolResults) {
                conversationMessages.push(result);
            }
        }
    };

    const guard = ctx?.activityGuard;
    if (typeof guard?.run === 'function') {
        await guard.run({
            source: 'cea:studio-chat',
            label: i18n('CardApp Studio AI'),
            scope: 'global',
        }, runLoop);
    } else {
        await runLoop();
    }

    return {
        assistantText: lastAssistantText,
        modifiedFiles,
    };
}

export { TOOL_NAMES, DEFAULT_SYSTEM_PROMPT };
