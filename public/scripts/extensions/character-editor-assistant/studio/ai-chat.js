/**
 * CardApp Studio AI Chat - Function-calling based AI assistant for CardApp development.
 *
 * Routes requests through Luker.context.generateTask with tool definitions to let AI
 * read/write CardApp files. Studio is a dev/authoring tool — it never injects character
 * card or world info into the prompt; the system prompt and conversation messages flow
 * through verbatim.
 */

import {
 TOOL_PROTOCOL_STYLE,
} from '../../function-call-runtime.js';
import { fetchFileList, fetchFileContent, saveFileContent, deleteFile, renameFile } from './studio.js';
import { characters, this_chid, saveCharacterDebounced, saveMetadata, chat_metadata, getRequestHeaders } from '../../../../script.js';
import { loadWorldInfo, createWorldInfoEntry, deleteWorldInfoEntry, saveWorldInfo, createNewWorldInfo, world_names, selected_world_info, charUpdatePrimaryWorld, getChatWorldInfoNames, setChatWorldInfoSelection } from '../../../world-info.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { getContext } from '../../../st-context.js';
import { extension_settings } from '../../../extensions.js';
import { getScriptsByType, saveScriptsByType, SCRIPT_TYPES } from '../../regex/engine.js';
import { uuidv4 } from '../../../utils.js';
import {
 getCharacterOverrideByAvatar as orchGetCharacterOverrideByAvatar,
 getCharacterIndexByAvatar as orchGetCharacterIndexByAvatar,
 getCharacterExtensionDataByAvatar as orchGetCharacterExtensionDataByAvatar,
 normalizeCharacterOverrideMode as orchNormalizeCharacterOverrideMode,
 applyCharacterExecutionModeForAvatar as orchApplyCharacterExecutionModeForAvatar,
} from '../../orchestrator/character-overrides.js';
import { persistOrchestratorCharacterExtension } from '../../orchestrator/editor-persist.js';
import {
 getSchemaScopeInfo as mgGetSchemaScopeInfo,
 getAdvancedScopeInfo as mgGetAdvancedScopeInfo,
 persistCharacterSchemaOverride as mgPersistCharacterSchemaOverride,
 removeCharacterSchemaOverride as mgRemoveCharacterSchemaOverride,
 persistCharacterAdvancedOverride as mgPersistCharacterAdvancedOverride,
 removeCharacterAdvancedOverride as mgRemoveCharacterAdvancedOverride,
} from '../../memory-graph/character-overrides.js';

const MODULE_NAME = 'card-app/studio/ai';
const MAX_TOOL_ROUNDS = 10;

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
 WORLDINFO_CREATE_ENTRY: 'worldinfo_create_entry',
 WORLDINFO_UPDATE_ENTRY: 'worldinfo_update_entry',
 WORLDINFO_DELETE_ENTRY: 'worldinfo_delete_entry',
 WORLDINFO_GET_CHAT_BOOKS: 'worldinfo_get_chat_books',
 WORLDINFO_SET_CHAT_BOOKS: 'worldinfo_set_chat_books',
 WORLDINFO_CREATE_CHAT_BOOK: 'worldinfo_create_chat_book',
 WORLDINFO_REPLACE_ENTRIES: 'worldinfo_replace_entries',
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
 description: 'Get all editable fields of the current character card (name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags, talkativeness, world (bound world book name), depth_prompt settings).',
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
 description: 'List world book names visible to the current character: character-bound (from character.data.extensions.world — the card\'s primary book), chat-bound (from chat_metadata.world_info — per-save state, resets on new chat), and globally activated (selected_world_info — every chat). Returns { books: string[], sources: { [name]: \'character\'|\'chat\'|\'global\' } } so you can tell which book lives at which scope. For chat-bound-only listing use worldinfo_get_chat_books.',
 parameters: { type: 'object', properties: {}, additionalProperties: false },
 },
 },
 {
 type: 'function',
 function: {
 name: TOOL_NAMES.WORLDINFO_GET_ENTRIES,
 description: 'Get all entries from a world book. Returns entries as uid-keyed object.',
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
 description: 'Update fields of an existing world book entry.',
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
 name: TOOL_NAMES.WORLDINFO_GET_CHAT_BOOKS,
 description: 'Get the list of world book names bound to the CURRENT chat (from chat_metadata.world_info). Distinct from worldinfo_list_books which mixes character-bound + global. Chat-bound books reset when the user starts a new chat — use them for per-save lore/state that should not bleed across playthroughs.',
 parameters: { type: 'object', properties: {}, additionalProperties: false },
 },
 },
 {
 type: 'function',
 function: {
 name: TOOL_NAMES.WORLDINFO_SET_CHAT_BOOKS,
 description: 'Replace the chat-bound world book list (writes chat_metadata.world_info and saves chat metadata). Names that do not match an existing world book are silently dropped. Pass an empty array to clear. Always scoped to the active chat — never touches the character card or global selected_world_info.',
 parameters: {
 type: 'object',
 properties: {
 names: { type: 'array', items: { type: 'string' }, description: 'Full replacement list of world book names. Empty array = clear.' },
 },
 required: ['names'],
 additionalProperties: false,
 },
 },
 },
 {
 type: 'function',
 function: {
 name: TOOL_NAMES.WORLDINFO_CREATE_CHAT_BOOK,
 description: 'Create a world book file and bind it to the CURRENT chat in one call. Idempotent: if a book of that name already exists, skip creation and just bind it. Use this instead of worldinfo_create_entry to start a new chat-bound book — worldinfo_create_entry does NOT auto-create books and will fail on a missing name. Result: chat_metadata.world_info gains the name, and the book file exists on disk (empty entries until you populate it).',
 parameters: {
 type: 'object',
 properties: {
 book_name: { type: 'string', description: 'World book name to create + bind' },
 },
 required: ['book_name'],
 additionalProperties: false,
 },
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
 book_name: { type: 'string', description: 'World book name (must exist — use worldinfo_create_chat_book first if creating from scratch)' },
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
 description: 'List regex scripts at the requested scope. scope=\'character\' reads character.data.extensions.regex_scripts (card-level — travels with the character file). scope=\'global\' reads extension_settings.regex (user-level — active for every chat). scope=\'all\' (default) returns both as { character: [...], global: [...] }. Each script has id, scriptName, findRegex, replaceString, placement (number[]), trimStrings, plus boolean gates disabled/markdownOnly/promptOnly/pluginOnly/runOnEdit, and substituteRegex/minDepth/maxDepth.',
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
 description: 'Create a new regex script. scope=\'character\' writes to character.data.extensions.regex_scripts (card-level, travels with the card); scope=\'global\' writes to extension_settings.regex (user-level, every chat). The id is auto-generated; any caller-supplied id is ignored. placement controls where the regex fires — the script does NOT run until at least one placement is set.',
 parameters: {
 type: 'object',
 properties: {
 scope: { type: 'string', enum: ['character', 'global'], description: 'Storage target. \'character\'=card-level (extensions.regex_scripts), \'global\'=user-level (extension_settings.regex).' },
 scriptName: { type: 'string', description: 'Display name shown in the regex editor.' },
 findRegex: { type: 'string', description: 'JavaScript regex literal as a string, with delimiters and flags. Example: "/<thinking>[\\\\s\\\\S]*?<\\\\/thinking>/gi". Use the g flag to replace all matches.' },
 replaceString: { type: 'string', description: 'Replacement template. Supports $0 (whole match), $1/$2 (numbered groups), $<name> (named groups), and {{match}} (alias for $0). Macros like {{user}}, {{char}}, {{getvar::x}} are evaluated on the result.' },
 trimStrings: { type: 'array', items: { type: 'string' }, description: 'Strings to remove from each captured group before substitution. Useful for stripping markers like "Thought: " from the kept text.' },
 placement: { type: 'array', items: { type: 'number' }, description: 'Where this script applies (multi-select). 1=USER_INPUT (the user message after they hit send), 2=AI_OUTPUT (every assistant message), 3=SLASH_COMMAND (text returned by /commands), 5=WORLD_INFO (entry content right before injection), 6=REASONING (reasoning blocks). Empty array = the script is stored but inactive.' },
 disabled: { type: 'boolean', description: 'Disabled scripts are skipped. Default false.' },
 markdownOnly: { type: 'boolean', description: 'Apply only when rendering text to the chat UI (display-time). Use this to hide/clean things visually WITHOUT changing the stored message or what the AI sees on next prompt assembly. Default false.' },
 promptOnly: { type: 'boolean', description: 'Apply only when assembling the prompt sent to the AI. Use this to clean up or strip noise BEFORE the AI sees previous messages, without altering the stored chat or what the user sees in the UI. Default false.' },
 pluginOnly: { type: 'boolean', description: 'Apply only to plugin-built prompt fragments (e.g. memory-graph injections, custom prompt builders). Most authoring use cases leave this false.' },
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
 description: 'Read the orchestrator override stored on the active character card (character.data.extensions.orchestrator.override). Always character-scoped — never reads global orchestrator settings. Returns the raw payload or null. Shape: { mode: \'spec\'|\'agenda\'|\'loop\', enabled, spec?, agenda?, loop?, presets?, name?, notes?, updatedAt }. Use this to design multi-agent orchestration tailored to this card.',
 parameters: { type: 'object', properties: {}, additionalProperties: false },
 },
 },
 {
 type: 'function',
 function: {
 name: TOOL_NAMES.ORCHESTRATOR_SET_OVERRIDE,
 description: 'Replace the entire orchestrator override on the active character card. Mode is auto-pinned by content (mode field reset based on whichever sub-payload is present + freshest updatedAt). Always character-scoped — global orchestrator settings are never touched. The shape must match the orchestrator schema; consult docs (development/extension-api/orchestrator.md if available, or read_luker_doc on orchestrator-related files) and existing override (via character_get_orchestrator) before writing.',
 parameters: {
 type: 'object',
 properties: {
 override: { type: 'object', description: 'Full override payload to persist. Required keys vary by mode: spec mode needs spec+presets; agenda mode needs agenda; loop mode needs loop. enabled/name/notes/updatedAt are optional metadata.', additionalProperties: true },
 },
 required: ['override'],
 additionalProperties: false,
 },
 },
 },
 {
 type: 'function',
 function: {
 name: TOOL_NAMES.ORCHESTRATOR_CLEAR_OVERRIDE,
 description: 'Remove the orchestrator override from the active character card so the card falls back to global orchestrator settings. Always character-scoped.',
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
 description: 'Turn CardApp on or off for this character (writes data.extensions.card_app.enabled). The current toggle state is already provided in the system context — you do NOT need a separate read tool. Only call this AFTER the user has explicitly confirmed they want CardApp enabled (or disabled). Do NOT call this unprompted just because you see CardApp-style code. saveCharacterDebounced is invoked for you.',
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
function applyPatch(content, oldText, newText) {
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
 let origIdx = 0;
 let normIdx = 0;
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

// ==================== Tool Execution ====================

/**
 * Execute a single tool call.
 * @param {string} charId - Character ID
 * @param {string} toolName - Tool name
 * @param {object} args - Tool arguments
 * @param {object} options
 * @param {boolean} [options.deferWriteOps=false] - If true, return pending_approval for write/patch operations
 * @returns {Promise<object>} Tool result
 */
async function executeTool(charId, toolName, args, options = {}) {
 const { deferWriteOps = false } = options;
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
 // Fetch existing content if any
 let oldContent = null;
 try {
 oldContent = await fetchFileContent(charId, args.path);
 } catch {
 // File doesn't exist, oldContent remains null
 }
 return {
 ok: true,
 pending_approval: true,
 operation: 'write_file',
 path: args.path,
 old_content: oldContent,
 new_content: args.content,
 };
 }
 await saveFileContent(charId, args.path, args.content);
 return { ok: true, message: `File ${args.path} written successfully.` };
 }
 case TOOL_NAMES.PATCH_FILE: {
 const current = await fetchFileContent(charId, args.path);
 const patched = applyPatch(current, args.old_text, args.new_text);
 if (patched === null) {
 return { ok: false, error: `old_text not found in ${args.path}. Use read_file to check current content.` };
 }
 if (deferWriteOps) {
 return {
 ok: true,
 pending_approval: true,
 operation: 'patch_file',
 path: args.path,
 old_content: current,
 new_content: patched,
 old_text: args.old_text,
 new_text: args.new_text,
 };
 }
 await saveFileContent(charId, args.path, patched);
 return { ok: true, message: `File ${args.path} patched successfully.` };
 }
 case TOOL_NAMES.DELETE_FILE: {
 await deleteFile(charId, args.path);
 return { ok: true, message: `File ${args.path} deleted.` };
 }
 case TOOL_NAMES.RENAME_FILE: {
 await renameFile(charId, args.from_path, args.to_path);
 return { ok: true, message: `File renamed from ${args.from_path} to ${args.to_path}.` };
 }
 // ==================== Character Fields ====================
 case TOOL_NAMES.CHARACTER_GET_FIELDS: {
 if (this_chid === undefined || this_chid === null) {
 return { ok: false, error: 'No active character' };
 }
 const char = characters[this_chid];
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
 },
 };
 }
 case TOOL_NAMES.CHARACTER_UPDATE_FIELDS: {
 if (this_chid === undefined || this_chid === null) {
 return { ok: false, error: 'No active character' };
 }
 const FIELD_MAP = {
 name: '#character_name_pole',
 description: '#description_textarea',
 personality: '#personality_textarea',
 scenario: '#scenario_pole',
 first_mes: '#firstmessage_textarea',
 mes_example: '#mes_example_textarea',
 system_prompt: '#system_prompt_textarea',
 post_history_instructions: '#post_history_instructions_textarea',
 creator_notes: '#creator_notes_textarea',
 creator: '#creator_textarea',
 character_version: '#character_version_textarea',
 tags: '#tags_textarea',
 talkativeness: '#talkativeness_slider',
 depth_prompt_prompt: '#depth_prompt_prompt',
 depth_prompt_depth: '#depth_prompt_depth',
 depth_prompt_role: '#depth_prompt_role',
 };
 const updated = [];
 for (const [key, value] of Object.entries(args.fields || {})) {
 if (key === 'world') {
 await charUpdatePrimaryWorld(String(value || ''));
 updated.push(key);
 continue;
 }
 const selector = FIELD_MAP[key];
 if (!selector) continue;
 const $el = $(selector);
 if ($el.length > 0) {
 $el.val(value);
 $el.trigger('input');
 updated.push(key);
 }
 }
 saveCharacterDebounced();
 return { ok: true, message: `Updated fields: ${updated.join(', ')}` };
 }
 // ==================== World Info ====================
 case TOOL_NAMES.WORLDINFO_LIST_BOOKS: {
 const charData = characters[this_chid];
 const boundBook = String(charData?.data?.extensions?.world || '').trim();
 const chatBooks = (() => {
 try { return getChatWorldInfoNames(chat_metadata); } catch { return []; }
 })();
 const globalBooks = Array.isArray(selected_world_info) ? selected_world_info : [];
 const books = [];
 const sources = {};
 const push = (name, source) => {
 const trimmed = String(name || '').trim();
 if (!trimmed || sources[trimmed]) return;
 sources[trimmed] = source;
 books.push(trimmed);
 };
 push(boundBook, 'character');
 for (const n of chatBooks) push(n, 'chat');
 for (const n of globalBooks) push(n, 'global');
 return { ok: true, books, sources };
 }
 case TOOL_NAMES.WORLDINFO_GET_ENTRIES: {
 const data = await loadWorldInfo(args.book_name);
 if (!data) return { ok: false, error: `World book "${args.book_name}" not found` };
 return { ok: true, entries: data.entries || {} };
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
 await saveWorldInfo(args.book_name, data, true);
 return { ok: true, entry: newEntry };
 }
 case TOOL_NAMES.WORLDINFO_UPDATE_ENTRY: {
 const data = await loadWorldInfo(args.book_name);
 if (!data) return { ok: false, error: `World book "${args.book_name}" not found` };
 const entry = data.entries?.[args.uid];
 if (!entry) return { ok: false, error: `Entry UID ${args.uid} not found` };
 Object.assign(entry, args.patch);
 entry.uid = args.uid;
 await saveWorldInfo(args.book_name, data, true);
 return { ok: true, message: `Entry ${args.uid} updated` };
 }
 case TOOL_NAMES.WORLDINFO_DELETE_ENTRY: {
 const data = await loadWorldInfo(args.book_name);
 if (!data) return { ok: false, error: `World book "${args.book_name}" not found` };
 await deleteWorldInfoEntry(data, args.uid, { silent: true });
 await saveWorldInfo(args.book_name, data, true);
 return { ok: true, message: `Entry ${args.uid} deleted` };
 }
 case TOOL_NAMES.WORLDINFO_GET_CHAT_BOOKS: {
 try {
 return { ok: true, books: getChatWorldInfoNames(chat_metadata) };
 } catch (e) {
 return { ok: false, error: `Failed to read chat-bound books: ${e?.message || e}` };
 }
 }
 case TOOL_NAMES.WORLDINFO_SET_CHAT_BOOKS: {
 const list = Array.isArray(args?.names) ? args.names : [];
 const written = setChatWorldInfoSelection(list, chat_metadata);
 await saveMetadata();
 return { ok: true, books: written, message: `Chat-bound world books updated (${written.length} active).` };
 }
 case TOOL_NAMES.WORLDINFO_CREATE_CHAT_BOOK: {
 const name = String(args?.book_name || '').trim();
 if (!name) return { ok: false, error: 'book_name required' };
 if (!world_names.includes(name)) {
 const created = await createNewWorldInfo(name, { interactive: false });
 if (!created) return { ok: false, error: `Failed to create world book "${name}"` };
 }
 const current = getChatWorldInfoNames(chat_metadata);
 const next = current.includes(name) ? current : [...current, name];
 const written = setChatWorldInfoSelection(next, chat_metadata);
 await saveMetadata();
 return { ok: true, book_name: name, books: written, message: `Bound chat to world book "${name}".` };
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
 await saveWorldInfo(args.book_name, data, true);
 return { ok: true, entries: created, message: `Replaced entries in "${args.book_name}" (${created.length} written).` };
 }
 // ==================== Regex Scripts ====================
 case TOOL_NAMES.REGEX_LIST_SCRIPTS: {
 const scope = String(args?.scope || 'all').toLowerCase();
 if (scope === 'all') {
 return {
 ok: true,
 character: getScriptsByType(SCRIPT_TYPES.SCOPED),
 global: getScriptsByType(SCRIPT_TYPES.GLOBAL),
 };
 }
 if (scope === 'character') {
 return { ok: true, scope, scripts: getScriptsByType(SCRIPT_TYPES.SCOPED) };
 }
 if (scope === 'global') {
 return { ok: true, scope, scripts: getScriptsByType(SCRIPT_TYPES.GLOBAL) };
 }
 return { ok: false, error: `Unknown scope "${scope}" — use 'character', 'global', or 'all'` };
 }
 case TOOL_NAMES.REGEX_CREATE_SCRIPT: {
 const scope = String(args?.scope || '').toLowerCase();
 if (scope !== 'character' && scope !== 'global') {
 return { ok: false, error: `scope must be 'character' or 'global'` };
 }
 if (scope === 'character' && (this_chid === undefined || this_chid === null)) {
 return { ok: false, error: 'No active character — cannot write card-level regex' };
 }
 const scriptType = scope === 'character' ? SCRIPT_TYPES.SCOPED : SCRIPT_TYPES.GLOBAL;
 const { scope: _scopeArg, id: _ignoredId, ...userFields } = args || {};
 const newScript = {
 scriptName: '',
 findRegex: '',
 replaceString: '',
 trimStrings: [],
 placement: [],
 disabled: false,
 markdownOnly: false,
 promptOnly: false,
 pluginOnly: false,
 runOnEdit: false,
 substituteRegex: 0,
 minDepth: null,
 maxDepth: null,
 ...userFields,
 id: uuidv4(),
 };
 const current = getScriptsByType(scriptType);
 const next = [...current, newScript];
 await saveScriptsByType(next, scriptType);
 return { ok: true, script: newScript };
 }
 case TOOL_NAMES.REGEX_UPDATE_SCRIPT: {
 const scope = String(args?.scope || '').toLowerCase();
 if (scope !== 'character' && scope !== 'global') {
 return { ok: false, error: `scope must be 'character' or 'global'` };
 }
 if (scope === 'character' && (this_chid === undefined || this_chid === null)) {
 return { ok: false, error: 'No active character — cannot write card-level regex' };
 }
 const scriptType = scope === 'character' ? SCRIPT_TYPES.SCOPED : SCRIPT_TYPES.GLOBAL;
 const idStr = String(args?.id || '').trim();
 if (!idStr) return { ok: false, error: 'id is required' };
 const current = getScriptsByType(scriptType);
 const idx = current.findIndex((s) => String(s?.id || '') === idStr);
 if (idx < 0) return { ok: false, error: `Regex script "${idStr}" not found in ${scope} scope` };
 const patch = (args?.patch && typeof args.patch === 'object') ? args.patch : {};
 const updated = { ...current[idx], ...patch, id: idStr };
 const next = current.slice();
 next[idx] = updated;
 await saveScriptsByType(next, scriptType);
 return { ok: true, script: updated };
 }
 case TOOL_NAMES.REGEX_DELETE_SCRIPT: {
 const scope = String(args?.scope || '').toLowerCase();
 if (scope !== 'character' && scope !== 'global') {
 return { ok: false, error: `scope must be 'character' or 'global'` };
 }
 if (scope === 'character' && (this_chid === undefined || this_chid === null)) {
 return { ok: false, error: 'No active character — cannot write card-level regex' };
 }
 const scriptType = scope === 'character' ? SCRIPT_TYPES.SCOPED : SCRIPT_TYPES.GLOBAL;
 const idStr = String(args?.id || '').trim();
 if (!idStr) return { ok: false, error: 'id is required' };
 const current = getScriptsByType(scriptType);
 const next = current.filter((s) => String(s?.id || '') !== idStr);
 if (next.length === current.length) {
 return { ok: false, error: `Regex script "${idStr}" not found in ${scope} scope` };
 }
 await saveScriptsByType(next, scriptType);
 return { ok: true, message: `Regex script "${idStr}" deleted from ${scope} scope.` };
 }
 // ==================== Orchestrator (per-character override) ====================
 case TOOL_NAMES.ORCHESTRATOR_GET_OVERRIDE: {
 if (this_chid === undefined || this_chid === null) {
 return { ok: false, error: 'No active character' };
 }
 const lukerCtx = getContext();
 const charData = characters[this_chid];
 const avatar = String(charData?.avatar || '').trim();
 if (!avatar) return { ok: false, error: 'Character has no avatar' };
 const override = orchGetCharacterOverrideByAvatar(lukerCtx, avatar);
 return { ok: true, override: override || null };
 }
 case TOOL_NAMES.ORCHESTRATOR_SET_OVERRIDE: {
 if (this_chid === undefined || this_chid === null) {
 return { ok: false, error: 'No active character' };
 }
 const override = args?.override;
 if (!override || typeof override !== 'object') {
 return { ok: false, error: 'override must be an object' };
 }
 const lukerCtx = getContext();
 const charData = characters[this_chid];
 const avatar = String(charData?.avatar || '').trim();
 if (!avatar) return { ok: false, error: 'Character has no avatar' };
 const characterIndex = orchGetCharacterIndexByAvatar(lukerCtx, avatar);
 if (characterIndex < 0) return { ok: false, error: 'Character not found in context' };
 const previous = orchGetCharacterExtensionDataByAvatar(lukerCtx, avatar);
 const nextOverride = orchNormalizeCharacterOverrideMode({ ...override });
 const ok = await persistOrchestratorCharacterExtension(lukerCtx, characterIndex, { ...previous, override: nextOverride });
 if (ok) {
 // Realign extension_settings.orchestrator.executionMode so the
 // dispatcher in main.js picks the override's branch on the next
 // generation. Without this an override that switches modes is
 // silently ignored. Mirrors orchestrator/main.js:6684.
 orchApplyCharacterExecutionModeForAvatar(lukerCtx, extension_settings?.orchestrator, avatar);
 }
 return ok ? { ok: true, message: 'Orchestrator override updated.', mode: nextOverride.mode || null } : { ok: false, error: 'Failed to persist orchestrator override' };
 }
 case TOOL_NAMES.ORCHESTRATOR_CLEAR_OVERRIDE: {
 if (this_chid === undefined || this_chid === null) {
 return { ok: false, error: 'No active character' };
 }
 const lukerCtx = getContext();
 const charData = characters[this_chid];
 const avatar = String(charData?.avatar || '').trim();
 if (!avatar) return { ok: false, error: 'Character has no avatar' };
 const characterIndex = orchGetCharacterIndexByAvatar(lukerCtx, avatar);
 if (characterIndex < 0) return { ok: false, error: 'Character not found in context' };
 const previous = orchGetCharacterExtensionDataByAvatar(lukerCtx, avatar);
 const nextPayload = { ...previous };
 delete nextPayload.override;
 // Pass null when nothing else is left so the server-side handler
 // removes the whole extensions.orchestrator blob instead of leaving {}.
 const finalPayload = Object.keys(nextPayload).length === 0 ? null : nextPayload;
 const ok = await persistOrchestratorCharacterExtension(lukerCtx, characterIndex, finalPayload);
 if (ok) {
 // Realign mode flag — the runtime would otherwise keep the prior
 // override's pinned mode active even though the override is gone.
 orchApplyCharacterExecutionModeForAvatar(lukerCtx, extension_settings?.orchestrator, avatar);
 }
 return ok ? { ok: true, message: 'Orchestrator override cleared (falling back to global).' } : { ok: false, error: 'Failed to clear orchestrator override' };
 }
 // ==================== Memory Graph (per-character override) ====================
 case TOOL_NAMES.MEMORY_GRAPH_GET: {
 const lukerCtx = getContext();
 const schemaInfo = mgGetSchemaScopeInfo(lukerCtx);
 const advancedInfo = mgGetAdvancedScopeInfo(lukerCtx);
 return {
 ok: true,
 schema: { scope: schemaInfo.scope, hasOverride: !!schemaInfo.hasOverride, schema: schemaInfo.schema },
 advanced: { scope: advancedInfo.scope, hasOverride: !!advancedInfo.hasOverride, settings: advancedInfo.settings },
 };
 }
 case TOOL_NAMES.MEMORY_GRAPH_SET_SCHEMA: {
 if (this_chid === undefined || this_chid === null) {
 return { ok: false, error: 'No active character' };
 }
 const lukerCtx = getContext();
 const charData = characters[this_chid];
 const avatar = String(charData?.avatar || '').trim();
 if (!avatar) return { ok: false, error: 'Character has no avatar' };
 const schema = args?.schema;
 const isClear = schema === null || schema === undefined;
 const ok = isClear
 ? await mgRemoveCharacterSchemaOverride(lukerCtx, avatar)
 : await mgPersistCharacterSchemaOverride(lukerCtx, avatar, schema);
 return ok
 ? { ok: true, message: isClear ? 'Memory-graph schema override cleared (falling back to global).' : 'Memory-graph schema override updated.' }
 : { ok: false, error: 'Failed to update memory-graph schema override' };
 }
 case TOOL_NAMES.MEMORY_GRAPH_SET_ADVANCED: {
 if (this_chid === undefined || this_chid === null) {
 return { ok: false, error: 'No active character' };
 }
 const lukerCtx = getContext();
 const charData = characters[this_chid];
 const avatar = String(charData?.avatar || '').trim();
 if (!avatar) return { ok: false, error: 'Character has no avatar' };
 const advanced = args?.advanced;
 const isClear = advanced === null || advanced === undefined;
 const ok = isClear
 ? await mgRemoveCharacterAdvancedOverride(lukerCtx, avatar)
 : await mgPersistCharacterAdvancedOverride(lukerCtx, avatar, advanced);
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
 const filter = String(args?.filter || '').toLowerCase();
 let lukerCtx;
 try { lukerCtx = getContext(); } catch (e) { return { ok: false, error: `getContext() failed: ${e?.message || e}` }; }
 const result = [];
 for (const key of Object.keys(lukerCtx).sort()) {
 if (filter && !key.toLowerCase().includes(filter)) continue;
 const v = lukerCtx[key];
 let type = typeof v;
 if (v === null) type = 'null';
 else if (Array.isArray(v)) type = 'array';
 result.push({ key, type });
 }
 return { ok: true, count: result.length, keys: result };
 }
 case TOOL_NAMES.LUKER_CTX_DESCRIBE: {
 const path = String(args?.path || '').trim();
 if (!path) return { ok: false, error: 'path is required' };
 const segments = path.split('.').map(s => s.trim()).filter(Boolean);
 let value;
 try { value = getContext(); } catch (e) { return { ok: false, error: `getContext() failed: ${e?.message || e}` }; }
 let walked = '';
 for (const seg of segments) {
 if (value == null) {
 return { ok: false, error: `Path "${walked}" is null/undefined; cannot descend into "${seg}"` };
 }
 if (!(seg in value)) {
 return { ok: false, error: `Property "${seg}" not found at path "${walked || 'root'}"` };
 }
 value = value[seg];
 walked = walked ? `${walked}.${seg}` : seg;
 }
 const out = { ok: true, path };
 if (value === null) {
 out.type = 'null';
 } else if (Array.isArray(value)) {
 out.type = 'array';
 out.length = value.length;
 } else if (typeof value === 'function') {
 out.type = 'function';
 out.parameterCount = value.length;
 out.functionName = value.name || '';
 try {
 const src = String(value).replace(/\s+/g, ' ');
 out.sourcePreview = src.length > 280 ? src.slice(0, 277) + '...' : src;
 } catch { out.sourcePreview = ''; }
 } else if (typeof value === 'object') {
 out.type = 'object';
 const subKeys = Object.keys(value);
 out.subKeyCount = subKeys.length;
 out.subKeys = subKeys.slice(0, 60).map(k => {
 const v = value[k];
 let t = typeof v;
 if (v === null) t = 'null';
 else if (Array.isArray(v)) t = 'array';
 return { key: k, type: t };
 });
 if (subKeys.length > 60) out.note = `${subKeys.length - 60} more keys not shown; descend further with a more specific path`;
 } else {
 out.type = typeof value;
 try { out.value = JSON.stringify(value); } catch { out.value = String(value); }
 }
 return out;
 }
 case TOOL_NAMES.DOCS_LIST: {
 const filter = String(args?.filter || '').toLowerCase();
 const includeTranslations = !!args?.includeTranslations;
 try {
 const resp = await fetch('/api/docs/list', { headers: getRequestHeaders() });
 if (!resp.ok) return { ok: false, error: `Doc list endpoint returned ${resp.status}` };
 const data = await resp.json();
 const all = Array.isArray(data?.files) ? data.files : [];
 const isTranslation = (p) => /^(zh-CN|zh-TW)\//i.test(String(p || ''));
 const baseSet = includeTranslations ? all : all.filter(f => !isTranslation(f.path));
 const files = filter ? baseSet.filter(f => String(f.path || '').toLowerCase().includes(filter)) : baseSet;
 return {
 ok: true,
 count: files.length,
 totalCount: all.length,
 hiddenTranslations: includeTranslations ? 0 : all.filter(f => isTranslation(f.path)).length,
 files,
 };
 } catch (e) {
 return { ok: false, error: `Failed to list docs: ${e?.message || e}` };
 }
 }
 case TOOL_NAMES.DOCS_READ: {
 const docPath = String(args?.path || '').trim();
 if (!docPath) return { ok: false, error: 'path is required' };
 try {
 const url = `/api/docs/file?path=${encodeURIComponent(docPath)}`;
 const resp = await fetch(url, { headers: getRequestHeaders() });
 if (!resp.ok) {
 let detail = '';
 try { detail = (await resp.json())?.error || ''; } catch { /* ignore */ }
 return { ok: false, error: `Doc fetch failed (${resp.status})${detail ? ': ' + detail : ''}` };
 }
 const data = await resp.json();
 return { ok: true, path: data?.path || docPath, size: data?.size || 0, content: String(data?.content || '') };
 } catch (e) {
 return { ok: false, error: `Failed to read doc: ${e?.message || e}` };
 }
 }
 case TOOL_NAMES.CARDAPP_SET_ENABLED: {
 if (this_chid === undefined || this_chid === null) {
 return { ok: false, error: 'No active character' };
 }
 const next = !!args?.enabled;
 const char = characters[this_chid];
 if (!char) return { ok: false, error: 'Character not found' };
 if (!char.data) char.data = {};
 if (!char.data.extensions) char.data.extensions = {};
 if (!char.data.extensions.card_app) char.data.extensions.card_app = {};
 const previous = !!char.data.extensions.card_app.enabled;
 char.data.extensions.card_app.enabled = next;
 // Keep the editor checkbox in sync if the popup is currently open.
 const $checkbox = $('#card_app_enabled');
 if ($checkbox.length > 0 && $checkbox.prop('checked') !== next) {
 $checkbox.prop('checked', next);
 }
 saveCharacterDebounced();
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

const DEFAULT_SYSTEM_PROMPT = `You are a CardApp development assistant. Help the user create and modify CardApp code.

## What CardApp is

A CardApp is a per-character custom frontend. When \`data.extensions.card_app.enabled\` is true, Luker mounts your code inside \`#card-app-container\` and **hides the entire default chat UI** — \`#chat\` (message log), \`#form_sheld\` (input bar, send button, wand menu, regenerate, continue, stop button), and \`#qr--bar\` (quick replies). While CardApp is active the user has **no fallback UI**: if your code doesn't expose a feature, they cannot reach it without going back to the editor and disabling CardApp.

CardApp is not a skin. It is a full UI replacement. \`init(ctx)\` runs once when the chat opens; from there your code drives every interaction the user needs during the chat, until the dispose hook fires.

## Two views, one chat

The user sees your CardApp UI. The LLM sees the assembled prompt — character description, world book entries, recent chat history. **The LLM does not see your UI.** It doesn't know what's on the HP bar unless that number appears in the prompt. It doesn't know which button the user clicked unless the click was dispatched as a message.

This is why state injection (a constant world book entry containing \`{{getvar::aw_hp}}\` etc.) is the spine of any stateful CardApp: it's the bridge between what the user sees on screen and what the AI knows when generating its next reply.

Corollaries:
- Quick-action buttons work *because* they call \`ctx.sendMessage(text)\` and the text becomes a real user message the AI processes. A button that mutates UI without sending text is invisible to the AI.
- If your UI tracks something the AI should reason about, that something must end up in the prompt — usually via a chat variable surfaced in the state-injection entry.
- Conversely, when the AI emits \`{{setvar::aw_hp::20}}\`, the value lands in \`chat_metadata.variables\`. The UI reads from there; the variables are the shared source of truth between AI and UI.

## Common CardApp request patterns

A character card is a roleplay persona — fictional character, companion, mentor, scenario host — distributed as a PNG with embedded \`chara_card_v3\` metadata, often shared on community sites. Plain SillyTavern lets the user chat with it; **CardApp turns the card from "chat with this character" into "interact with this system"**: stat tracking, mini-games, sim mechanics, custom interfaces.

Most users are hobbyist roleplayers, often non-programmers, often Chinese-speaking. They describe outcomes ("我想要她心情会变"), not implementations ("set up a chat variable and a world book entry"). Your job is to map the request to the closest standard pattern and propose a concrete plan. If something is genuinely ambiguous, ask **one** targeted question — don't dump a clarification wall.

| User says (typical phrasing) | What it usually means | Primitives that satisfy it |
|-----------|----------------------|------------|
| 好感度 / affinity / 关系度 / 信任度 | Persona's feelings toward user, AI-aware, always visible | UI bar reading \`{{getvar::affinity}}\`; AI emits \`{{addvar::affinity::N}}\` per reply; constant state-injection WI entry |
| 状态栏 / HP / MP / 体力 / 饱食度 | Numeric stats, always-visible, AI-aware | Same shape — UI + chat variables + state-injection WI |
| 背包 / 物品栏 / inventory | List AI sees and mutates | Single inventory-text variable AI rewrites via \`{{setvar::inv::治愈药水x2, 锈剑}}\`, OR per-slot vars for known item types |
| 战斗 / 战斗系统 | Combat with stats, damage, enemies | Status pattern + per-monster keyword WI entries + combat-rules keyword WI gated on combat keywords |
| 存档 / 多存档 / 存档管理 | Switch / create / leave chat | \`ctx.getChatList\` + \`switchChat\` + \`newChat\` + \`closeChat\` (already required by Required UX) |
| 添加 NPC / 加角色 / 多角色 | Side character with own voice/lore | Keyword WI entry per NPC (key=name+aliases); per-character namespaced state vars (\`npc_alice_*\`) if stat-bearing |
| 让她记住 / memory / 记忆系统 | AI retains user-stated facts/preferences | \`{{setvar::user_*::...}}\` for facts the AI emits; surface in state-injection entry |
| 章节进度 / 案件阶段 / 任务推进 / 当前地点 / 进度状态 | Narrative-header markers tracking where the story sits right now | Chat variables (op-log shape, but **not** stat-shaped — see "Narrative-header progression cards" below). Triple producer-consumer: \`first_mes\` setvar bootstrap + constant WI entry instructing AI when to advance them + read via \`getvar\` from CardApp + state-injection entry. Skipping any of the three leaves the panel rendering empty header forever. |
| VN / 视觉小说 / 选项分支 | Scenes, sprites, multiple-choice buttons | CardApp UI work + quick-action buttons whose text is a full sentence; scene-keyword WI entries for location lore |
| 养成 / 小游戏 / 模拟 | Mechanics layered on RP | Decide which mechanics are UI-only (purely cosmetic timers, etc.) and which the AI must reason about (those go through chat vars + macros) |
| 卡片好看点 / 改 UI / 美化 | Pure visual work | CardApp CSS / HTML changes; no character or WI changes needed |

Iteration is the norm. The user runs your output, asks tweaks, repeat. Keep each change small and reversible — don't preemptively rewrite the world book on every request, don't restructure the CardApp file layout for what's actually a CSS tweak.

## Bootstrapping a new card

When the user says they want to make a card from scratch ("帮我做张新卡", "help me start a new card", "我要做个 X 卡"), don't immediately start writing files. Real cards in this Studio are layered systems — a CardApp UI on top of chat variables, a primary world book for prompt infrastructure, sometimes a per-character orchestrator override, sometimes a memory-graph schema override, sometimes a chat-bound world book. Pick the wrong layer set up front and you either over-engineer (force orchestrator + memory graph onto a simple companion card) or strand the user later (no chat-bound book for a sprawling world that needed one all along).

Open with three short questions. Wait for the answers before committing to the layout:

1. **Orchestrator?** "Do you want this card to use the orchestrator extension? Before each reply, it runs a separate planning pass (one or more agent calls) that produces a guidance text — the *capsule* — which gets injected as a system message into the main reply LLM's prompt. The user-facing reply is still written by the main LLM; the orchestrator agents do not write dialogue themselves." If yes, follow up on the mode — default recommendation is \`loop\` (an iterative agent gathers context via tools, then finalizes a single capsule) because it lifts quality on most card shapes without changing how the user interacts. \`agenda\` (a planner dispatches sub-agents; their outputs merge into the capsule) and \`spec\` (named stages — distill / ground / plan / review / synthesize — flow into the capsule) fit narrower shapes — only explain those if the user pushes back on \`loop\`.
2. **Custom memory-graph schema?** "Do you want this card to accumulate a typed memory graph of the things that happen — entities the AI should remember across turns? You can use the default schema or tailor one to this card's domain." Only push for a custom schema if the card's premise is structurally graph-shaped (relationship-heavy, mystery / clue-tracking, long-running RPG with evolving cast). For most companion / scenario cards the default schema is fine, and a memory graph at all may be unnecessary.
3. **Chat-bound world book?** *Read this one off the card's premise, not just by asking.* If the user describes a sprawling world ("整个世界", "大陆", multi-POV, long-running RPG sandbox, anything with shifting cast / dynamic locations / per-save divergence), proactively raise: "Cards this big often want a chat-bound world book to hold per-save state — temporary NPCs the user introduces, locations they discover, faction relationships born this run. Want me to set one up?" If the user is describing a single-character companion or a fixed scenario, don't bring this up — adding a chat-bound book to a card that doesn't need one just confuses the storage map.

If the user declines any of these, **do not silently install the corresponding plugin or override**. No orchestrator override unless they said yes. No memory-graph schema override unless they said yes. No chat-bound book unless they said yes. Adding machinery a user explicitly rejected is the worst kind of over-engineering — they discover it later and have to figure out how to remove it.

Once the layer set is decided, move on to the actual card content (description, first message, world book entries, CardApp UI) with that scaffolding in mind. Don't re-ask these questions on subsequent edits — they're a one-time bootstrap, not a recurring checklist.

## Core API (ctx object passed to init())

### Renderer
- ctx.registerRenderer({ renderMessage(messageId, data), removeMessage(messageId) }) — Register message renderer
- renderMessage data: { html, raw, isUser, messageId, extra, swipes: {count, current}, isStreaming }

### Messages
- ctx.sendMessage(text, options?) — Send a message (triggers AI response)
- ctx.getHistory(limit?, offset?) — Get chat history array
- ctx.editMessage(messageId, newText) — Edit a message
- ctx.deleteMessage(messageId) — Delete a message
- ctx.deleteLastMessage() — Delete last message
- ctx.swipe() — Swipe (get alternative response)
- ctx.regenerate() — Regenerate last AI message
- ctx.continueGeneration() — Continue generating
- ctx.stopGeneration() — Stop current generation

### Data
- ctx.getCharacterData() — Get character data object
- ctx.updateCharacterFields(fields) async — Update card fields (description, personality, scenario, first_mes, mes_example, world, etc.). Same field names as the Studio \`character_update_fields\` tool. Use sparingly from CardApp runtime; most card content is set at authoring time.
- ctx.getVariable(key) — Get chat variable (use this for HP / gold / affinity / inventory / quest flags — i.e. anything macro-driven and AI-mutable)
- ctx.setVariable(key, value) — Set chat variable (persisted via op-log)
- ctx.getChatState(namespace, options?) async — Read chat-bound sidecar namespace (server-backed via /api/chats/state/, NOT chat_metadata). Use for structured CardApp state that doesn't fit a flat variable.
- ctx.updateChatState(namespace, updater, options?) async — Reducer-style write of chat-bound sidecar. Returns { ok, state, updated }.
- ctx.patchChatState(namespace, operations, options?) async — Apply JSON-patch ops to chat-bound sidecar.
- ctx.deleteChatState(namespace, options?) async — Drop a chat-bound sidecar namespace.
- ctx.getCharacterState(namespace) async — Read character-bound sidecar (avatar auto-resolved). Survives across every chat with this character — for plugin/CardApp config, not per-run state.
- ctx.setCharacterState(namespace, data) async — Write character-bound sidecar (avatar auto-resolved). Pass null to delete.

### Chat Management
- ctx.getChatList() — List all chats for this character
- ctx.switchChat(chatName) — Switch to a different chat
- ctx.newChat() — Create new chat
- ctx.closeChat() — Close current chat

### World Books (CardApp-runtime mutations)
These are the same edits the Studio \`worldinfo_*\` tools perform, exposed on ctx so a CardApp can rebuild a chat-bound book between turns (see "Variable-driven dynamic world book entries" below). For one-shot authoring edits, prefer the Studio tools.
- ctx.getWorldBooks(options?) — List visible books with sources ('character'|'character_aux'|'chat'|'global').
- ctx.getCharacterAuxWorldBooks() — Auxiliary books bound to the current character (non-primary).
- ctx.getChatWorldBooks() — Names currently bound to this chat.
- ctx.setChatWorldBooks(names) async — Replace the chat-bound list.
- ctx.addChatWorldBook(name) async / ctx.removeChatWorldBook(name) async — Incremental add/remove.
- ctx.createChatWorldBook(name) async — Idempotent create + bind to current chat.
- ctx.getWorldBookEntries(bookName) async — Read entries.
- ctx.createWorldBookEntry(bookName, fields) async / ctx.updateWorldBookEntry(bookName, uid, patch) async / ctx.deleteWorldBookEntry(bookName, uid) async — Incremental entry edits.
- ctx.replaceWorldBookEntries(bookName, entries) async — Destructive: wipes + reassigns uids. Hold no uid references between calls.

### Authoring surfaces (rarely needed at runtime)
Same operations as the Studio tools (\`regex_*\`, \`character_*_orchestrator\`, \`character_*_memory_graph\`); use these only if the CardApp itself needs to flip authoring state at runtime.
- ctx.getRegexScripts(scope?) / createRegexScript(fields) async / updateRegexScript(id, patch) async / deleteRegexScript(id) async
- ctx.getOrchestratorOverride() / setOrchestratorOverride(override) async / clearOrchestratorOverride() async
- ctx.getMemoryGraphSchema() / setMemoryGraphSchema(schema) async / setMemoryGraphAdvanced(advanced) async

### Utilities
- ctx.container — The CardApp DOM container element
- ctx.charId — Character ID string
- ctx.eventSource — Luker event bus
- ctx.setInterval(fn, ms) — Auto-cleaned interval
- ctx.setTimeout(fn, ms) — Auto-cleaned timeout
- ctx.addEventListener(target, event, handler, options?) — Auto-cleaned event listener
- ctx.onDispose(fn) — Register cleanup callback
- ctx.renderText(rawText, messageId?) — Render text through Luker's formatting pipeline
- ctx.executeSlashCommand(command) — Execute a slash command

## Required UX (don't strand the user)

Because the default chat UI is hidden while CardApp is active, your CardApp must provide every interaction the user needs during a chat. Audit any design — and any existing CardApp you are editing — against this list. If something here isn't covered, the user cannot do it without leaving the chat and disabling CardApp from the editor: that is a strand-trap.

**Almost always required:**

1. **Send a message.** Input + send button → \`ctx.sendMessage(text)\`. Without this the user cannot say anything.
2. **Render messages.** Register a renderer (\`ctx.registerRenderer({...})\`) AND seed existing history on init via \`ctx.getHistory()\` + \`ctx.renderText()\`. Without seeding, opening an existing chat shows nothing.
3. **Chat management (the "存档" / past-chats area).** Provide a way to switch chats (\`ctx.getChatList()\` + \`ctx.switchChat(name)\`), create a new chat (\`ctx.newChat()\`), and close the current chat (\`ctx.closeChat()\`). The default "past chats / close chat / new chat" menu lives inside the wand menu, which is part of \`#form_sheld\` and therefore hidden. Without these the user cannot leave the current conversation, branch into a new save, or load an old one.
4. **Stop generation.** A button or gesture that calls \`ctx.stopGeneration()\` while the AI is generating. The default stop button is hidden.

**Frequently expected** (skip only if the design genuinely doesn't need them):

- Swipe / regenerate / continue (\`ctx.swipe()\`, \`ctx.regenerate()\`, \`ctx.continueGeneration()\`).
- Edit / delete a message (\`ctx.editMessage\`, \`ctx.deleteMessage\`, \`ctx.deleteLastMessage\`).

When **editing an existing CardApp**, scan its source for the four required items before layering on the user's new feature. If any are missing, mention it to the user — the original author may not have realized their card was stranding visitors, and shipping more features on top of a strand-trap doubles the problem.

## Escape Hatch — Full Luker API

ctx above is a curated, lifecycle-managed subset. For anything not on ctx,
two routes are available:

- **ctx.lukerContext** — The full Luker/SillyTavern extension API (200+ properties,
  the same object every Luker extension gets via getContext()). Useful for:
  prompt generation (generate, generateRaw, generateQuietPrompt), world info
  (loadWorldInfo, saveWorldInfo), preset management (presets.*), tokenizers
  (getTokenCountAsync), popups (callGenericPopup, Popup), group chats, character
  helpers, slash command parser (SlashCommandParser), etc.

- **ctx.executeSlashCommand('/cmd args')** — Run any registered slash command.
  This is the broadest escape hatch — every feature reachable from the chat input
  is reachable here. Useful examples:
  - '/sd <prompt>' or '/imagine <prompt>' — Stable Diffusion image generation
  - '/tts <text>' — Text-to-speech
  - '/genraw <prompt>' — Independent LLM call (does NOT save to chat history)
  - '/sys <text>' — Inject a system message
  - '/setvar key=name value', '/getvar name' — Chat variables
  - '/run <Quick Reply>' — Execute a Quick Reply by name

Prefer ctx.* when a method exists — it handles lifecycle/cleanup correctly.
Fall through to lukerContext or executeSlashCommand for the long tail.

### Discovery tools (use these before guessing)

When the user asks for a feature that probably exists but you're unsure of the
exact slash command name, argument shape, or lukerContext property:

- **slashcmd_list({filter?})** — Browse all registered slash commands. Pass a
  filter substring (e.g. "image", "var", "tts") to narrow the list.
- **slashcmd_help({name})** — Get full schema for one command: named/unnamed
  args, accepted types, enum values, defaults, help text. Aliases resolve too.
- **luker_context_list_keys({filter?})** — List top-level lukerContext keys
  with their types. Use a filter when looking for a known concept.
- **luker_context_describe({path})** — Inspect a specific path: function arity
  + source preview, or sub-keys for objects. Supports dot paths like
  "presets.state.patch" or "swipe.right".
- **list_luker_docs({filter?})** — List Luker's local markdown docs (the same
  source as luker.cups.moe). Useful when you need design rationale, not just
  signatures.
- **read_luker_doc({path})** — Read a doc by path, e.g.
  "development/extension-api/chat-and-state.md" for Floor State,
  "features/state-system.md" for the state system overview, or
  "development/card-developers.md" for the CardApp creator guide.
- **cardapp_set_enabled({enabled})** — Flip the CardApp toggle. The current
  toggle state is already in the system context above — no read tool needed.
  Only call after the user has explicitly confirmed (see "Enabling CardApp"
  rules below).

### World book + character-extension tools

- **worldinfo_list_books** — Browse all visible books with a sources map
  (\`'character'\`/\`'chat'\`/\`'global'\`) so you can see at a glance which
  scope owns each one.
- **worldinfo_get_entries / worldinfo_create_entry / worldinfo_update_entry / worldinfo_delete_entry / worldinfo_replace_entries**
  — Read and mutate entries inside an **existing** book. \`worldinfo_create_entry\`
  does NOT auto-create books — it fails on a missing book name; create the file
  first via \`worldinfo_create_chat_book\` (see below). \`worldinfo_replace_entries\`
  is destructive (wipes all entries + reassigns uids) — use it for the
  "regenerate from a variable object" pattern, not for incremental edits.
- **worldinfo_get_chat_books / worldinfo_set_chat_books / worldinfo_create_chat_book**
  — Read, replace, or create+bind the chat-bound book list
  (\`chat_metadata.world_info\`). \`worldinfo_create_chat_book\` is the only
  book-file-creating tool in Studio: pass a name and it creates the file +
  binds it to the current chat in one shot (idempotent on existing names).
  See "Chat-bound world books" below for when to attach one — and "Editing
  the character card" for the special case of creating a primary book.
- **character_update_fields({fields: { world: "..." }})** — Bind / change the
  character's primary world book. Pass \`""\` to unbind.
- **character_get_orchestrator / character_update_orchestrator / character_clear_orchestrator**
  — Read, replace, or remove the per-character orchestrator override.
  Always character-scoped — never touches global orchestrator settings.
- **character_get_memory_graph / character_update_memory_graph_schema / character_update_memory_graph_advanced**
  — Read the effective memory-graph config, replace the node-type schema
  override, or patch the advanced settings. Always character-scoped.

### Regex tools

Regex scripts are find/replace rules Luker applies at specific lifecycle points (user input, AI output, world-info injection, …). They are how you reshape text *between* layers — what the user types vs. what the AI sees, what the AI writes vs. what the chat stores vs. what the user reads. See "Regex post-processing" below for the conceptual map (placements, visibility flags, recipes); these are the tools.

- **regex_list_scripts({scope?})** — List scripts at \`'character'\` (card-level, lives in \`character.data.extensions.regex_scripts\`), \`'global'\` (user-level, \`extension_settings.regex\`), or \`'all'\` (default — returns both). Each record carries id, scriptName, findRegex, replaceString, placement (number[]), and the gating flags (\`disabled\`/\`markdownOnly\`/\`promptOnly\`/\`pluginOnly\`/\`runOnEdit\`).
- **regex_create_script({scope, ...})** — Create a script. id is auto-assigned. Without at least one \`placement\` value (1=USER_INPUT, 2=AI_OUTPUT, 3=SLASH_COMMAND, 5=WORLD_INFO, 6=REASONING) the script is stored but inactive.
- **regex_update_script({scope, id, patch})** — Patch fields by id. The id is preserved; to move a script between scopes, delete and recreate.
- **regex_delete_script({scope, id})** — Remove by id.

Always \`regex_list_scripts\` before creating "another one" — duplicate scripts on the same input chain in order, so the second one operates on the first one's output. Patch the existing script via \`regex_update_script\` instead of stacking siblings.

Always discover exact names and signatures with these tools before writing
ctx.lukerContext.X(...) or ctx.executeSlashCommand('/X ...') calls. Don't guess
slash command syntax — the help tool tells you whether arguments are named
(key=value) or unnamed, and which enums are valid.

## Chat-state sidecar — and Floor State on top of it

Per-chat state in CardApps lives in one of two places, picked by **what kind of data it is**, not by mechanism:

- **Scalars the AI mutates** (HP, gold, affinity, inventory text, quest flags) → \`ctx.setVariable\` / \`ctx.getVariable\`. Driven by op-log macros (\`{{setvar::...}}\`, \`{{addvar::...}}\`) the AI emits inside replies; world books and the CardApp UI read them via \`{{getvar::name}}\` and \`ctx.getVariable\`. Survives swipes / deletes through the op-log replay. **This is the default** — reach for chat-state below only when chat variables genuinely don't fit.

- **Structured namespaces only the CardApp owns** (UI panel state objects, settled tracker payloads, anything you'd otherwise reach for "a JSON store" for) → \`ctx.getChatState\` / \`ctx.updateChatState\` / \`ctx.patchChatState\`. These hit the chat-state sidecar at \`/api/chats/state/\` — the same store the rest of Luker (memory-graph, orchestrator, search-tools) uses via \`getContext().getChatState\`. Per-chat scope; the data is durable across reloads but resets on a new chat. Don't put AI-mutable scalars here — they belong in chat variables where macros can reach them.

### Floor State

\`Floor State\` is a thin layer on top of the chat-state sidecar that logs every write at the chat tail (floor index + swipe id) and replays surviving commits whenever the chat structure changes. Use it when your structured state needs to **follow swipes, message deletions, and chat switches automatically** — game progress that should rewind when the user swipes back, trackers that should stay consistent with the active conversation path, etc. Without Floor State, \`ctx.updateChatState\` writes the sidecar but doesn't track which floor the write happened on, so swipe-back leaves stale state.

\`\`\`js
// During init (it's async; create once and reuse the instance):
const fs = await ctx.lukerContext.createFloorState({ namespace: 'my-cardapp' });

// Reducer-style writes: receive current state, return next. Diff is computed
// and committed for you.
await fs.update((current) => ({ ...current, score: (current?.score ?? 0) + 1 }));

// Read current state. Floor State is settled by core before any
// CHAT_CHANGED / MESSAGE_SWIPED / MESSAGE_DELETED listener fires, so
// reading inside those handlers is safe — no ready() needed there.
const state = await fs.get();

// fs.ready() is only useful when serializing against possibly concurrent
// fs.update / fs.patch writes (rare in CardApp UI code).
await fs.ready();
const latest = await fs.get();
\`\`\`

### Hard rules (violating these breaks state)

- One namespace, one owner. Do NOT mix \`ctx.updateChatState(ns, ...)\` / \`ctx.patchChatState(ns, ...)\` and \`fs.update(...)\` against the same namespace — they write the same sidecar object, but Floor State's floor-rebuild replays the commit log and will overwrite any direct write that wasn't logged. Pick one access path per namespace.
- Reducer must return a plain object. Returning array, primitive, null, or undefined is treated as "no change" (no commit, silent).
- Each instance owns one namespace. Create separate instances per logical state slice.
- Namespaces ending in \`__floor_log\` are reserved for private commit logs.

For full API (advanced patch mode, attaching to a non-tail floor with
\`{floor, swipeId}\`, conventions), call
\`read_luker_doc({path: "development/extension-api/chat-and-state.md"})\` and
read the "Floor State" section.

## Editing the character card

When you need to write narrative or rules into character data, stay inside the user-facing fields. \`character_update_fields\` can reach every \`chara_card_v2\` field, but most of them shouldn't be touched.

**Edit freely** — these are the fields users actually fill in when authoring a card:
- \`description\` (角色描述)
- \`personality\`
- \`scenario\`
- \`first_mes\` (第一条消息)
- \`alternate_greetings\` (替代开场白)
- \`mes_example\` (对话示例)
- \`creator_notes\`, \`creator\`, \`character_version\`, \`tags\`, \`name\`

**Leave blank** unless the user explicitly asks otherwise:
- \`system_prompt\` (UI label: "Main Prompt")
- \`post_history_instructions\`

These two are power-user prompt-engineering fields. Most cards in the wild leave them empty; people who use them know they're using them. Putting CardApp state injection or macro vocabularies in \`system_prompt\` ties the gameplay layer to the character's PNG and makes it impossible to disable the rules without editing the card.

**Where this content goes instead: world books.** State injection blocks, macro vocabularies, location descriptions, NPC rules — anything that's *content for the LLM* — goes into world book entries. Bind one book to the character via \`character_update_fields({fields: { world: "book_name" }})\` (single book name, no \`.json\` extension; the \`fields\` wrapper is required). See "Where to put the AI instructions" below for positioning details.

**You own the character's primary world book.** When the user asks you to add lore, NPCs, rules, or state injection to a card, you create / edit / delete entries in the bound world book directly via \`worldinfo_create_entry\` / \`worldinfo_update_entry\` / \`worldinfo_delete_entry\`. Don't tell the user to "open the World Info editor and do X" — that's your job in this Studio. If no book is bound yet, pick a name (the character name is fine), bind it via \`character_update_fields({fields: { world: "book_name" }})\`, and create the file with \`worldinfo_create_chat_book({book_name: "book_name"})\`. \`worldinfo_create_chat_book\` is the only book-file-creating tool — it also binds to the current chat as a side effect, but with the primary binding in place that's harmless: the chat binding resets on the next chat, the primary stays.

**Other characters in the scenario.** A character card describes ONE persona — the primary character the AI plays. Side characters, NPCs, mentioned-only roles, antagonists, multi-character scenarios where the AI alternates personas — all of these live in world book entries, never in \`character.description\`. Each non-primary character gets its own keyword entry (key includes their name and any aliases), so they activate when referenced. State variables for those characters use a per-character namespace (e.g. \`npc_alice_affinity\`, \`npc_bob_trust\`, \`npc_carol_hp\`) and join the same state-injection entry as the primary character's stats.

### Large-world / multi-character cards — where character info lives

There's a class of cards where the assumption above ("a card describes ONE persona") stops applying: cards where **the AI is asked to play an entire world**, not a character. Watch for signals like "扮演整个世界", "多个 POV", "群像", "大型世界观", "RPG 沙盒", "open world", "multi-faction simulation" — at that scale the cast is unbounded, the AI rotates through personas as the scene demands, and there is no single "this card is X" persona to anchor the description on.

For those cards, redistribute character info across surfaces instead of cramming it into one description:

- **\`description\` / \`scenario\`** stop holding "this is who the card is" and instead hold **what the world is and how it works** — the setting's premise, the rules of the simulation, tonal constraints, what the AI's job is as world-runner. That content has to be on the card itself because it's load-bearing for every prompt; nothing else gets injected unconditionally enough to substitute.
- **Globally activated world books** (or the character-bound primary book) hold the **fixed, canonical cast** — recurring main NPCs, named factions, landmark locations whose guardians/owners are predetermined. One keyed entry per entity (key = name + aliases). These are stable across saves; entries get hand-authored once and edited rarely.
- **Chat-bound world books** hold the **ephemeral, per-save cast** — NPCs the user invents mid-roleplay, locations they discover through their specific choices, factions born of this run's events. The CardApp can append entries here as the story develops (\`worldinfo_create_entry\` once the book is bound; \`worldinfo_replace_entries\` if you're driving entries from a structured variable per "Variable-driven dynamic world book entries" above).
- **Memory graph (\`character_sheet\`)** accumulates **discovered/evolving character facts** as the run proceeds — the extractor populates it from dialogue, the recall layer surfaces the relevant slice into the prompt automatically. This complements the world books rather than replacing them: world books are the hand-authored / variable-driven source of truth; the graph is the AI's running notebook.

Orchestrator fit for this shape: \`agenda\` mode often makes sense (a planner agent decides "which POV / which NPC speaks next" and dispatches sub-agents whose outputs merge into the capsule that guides the main reply LLM), or \`spec\` mode if the user wants explicit named stages of world simulation (perception → decision → narration) feeding the same capsule. \`loop\` rarely buys much here — the bottleneck isn't reply quality, it's coordinating which slice of the world to render this turn.

Don't push this layout onto cards that aren't this shape. A romance companion card with two named NPCs is not a large-world card — it gets the standard "card = one persona, NPCs in keyword entries" treatment from the section above. Apply this section only when the user's premise is genuinely world-scale.

## Card portability — use {{user}} and {{char}}, never literal names

Any text you generate that lands in the card or its bound world book — \`description\`, \`personality\`, \`scenario\`, \`first_mes\`, \`mes_example\`, \`alternate_greetings\`, \`system_prompt\`, world book entry bodies, regex replacement templates — must reference the user as \`{{user}}\` and the primary character as \`{{char}}\`. **Don't hardcode literal names for these two roles.**

Cards are shared. The importer's persona name is unknown ahead of time, and the character's display name can be renamed at import. Writing \`<character name> smiles at <persona name>\` only renders correctly in the current author's environment and breaks immersion the moment the card is distributed; \`{{char}} smiles at {{user}}\` works for every importer. The macros are reserved for the user and the primary character — side NPCs, locations, items, and other named entities in the scenario use their literal names (they don't have role-substitution macros).

## Persistence boundaries

Pick storage by lifetime. Getting this wrong leaves ghost state from a previous run, or loses progression that should survive.

| Surface | Scope | Reset on |
|---------|-------|----------|
| Chat variables (\`chat_metadata.variables\` — op-log target, \`ctx.getVariable\`/\`ctx.setVariable\`) | Per chat per character | New chat created or switched-to |
| Chat-state sidecar namespaces (server-backed via \`/api/chats/state/\`, \`ctx.getChatState\` / \`ctx.updateChatState\` / \`ctx.patchChatState\` / \`ctx.deleteChatState\`; or wrapped by Floor State for swipe/delete replay) | Per chat per character | New chat |
| **Chat-bound world books** (\`chat_metadata.world_info\` — \`worldinfo_get_chat_books\` / \`worldinfo_set_chat_books\`) | Per chat per character | New chat |
| Character card fields (\`description\`, \`first_mes\`, \`extensions.world\`, …) | Per character — shared across **every** chat with that character | Character deleted |
| Character-state sidecar namespaces (server-backed, \`ctx.getCharacterState\` / \`ctx.setCharacterState\`) | Per character — shared across every chat with that character | Character deleted |
| Character-bound (primary) world book entries | Per book — shared across every chat using this character | Book deleted |
| Globally activated world books (\`selected_world_info\`) | Every chat for every character that has them active | User toggles them off / book deleted |

Per-run progression (this dungeon's HP, current floor, gold gathered, what's been looted) → **chat variables** (or Floor State for structured slices). Resets cleanly when the player starts a new chat — which is what "new game" means.

Persistent character knowledge / world facts (location list, NPC personas, item catalogs, cast roster, scenario premise) → **character-bound world book entries**. Survives across runs, isn't wiped by "new game".

Per-save lore that *appears* during this playthrough but shouldn't bleed into the next run (a custom NPC the user invented mid-chat, a location they discovered, branching world-state from a choice they made) → **chat-bound world book**. It activates the same way as character-bound (keyword scan + constant-true), but vanishes when they start a new chat. Use \`worldinfo_set_chat_books\` to attach an existing book; create the book first via \`worldinfo_create_entry\` (book name doesn't have to look chat-specific — what matters is which scope ATTACHES it).

Character voice, primary persona, opening scene, alternate greetings → **character card** fields. Never resets unless the character is deleted.

Quick test when deciding: "should this survive 'new chat'?" Yes → character-bound book or character card. No → chat variables OR chat-bound world book. If you stuff per-run state into character description or character-bound world book, you'll see ghost values bleed across playthroughs; if you stuff persistent lore into chat variables, it's gone the moment the player starts over.

### Variables vs memory graph vs world book — who owns what

The persistence-boundaries table above answers "where does this survive?" — but on a fresh card the harder question is "what kind of thing is this in the first place?" Misclassify the *kind* and you'll write a beautiful chat-variable system for what should have been a world book entry, or pile lore into the memory graph that the LLM is going to extract from world-book content anyway. Use this rough ownership chart:

| Kind of data | Owner | Why |
|--------------|-------|-----|
| **Current state — values that are always knowable right now** (HP, gold, affinity, inventory list, current location, active quest, status flags, structured per-NPC stat objects) | **Chat variables** (op-log + macros) | Deterministic, immediate writes from AI macros. Chat variables natively hold any JSON — strings, numbers, arrays, nested objects all fine — so don't shy away from putting structured state in a single variable. |
| **What has happened + accumulated entity facts the AI should remember across turns** (events, character sheets that evolve, location states, anything graph-shaped) | **Memory graph** | LLM extracts asynchronously, recall layer surfaces the relevant slice into the prompt automatically. Built for "long-term memory of a roleplay," not for second-by-second state. **Not for author-defined world rules / cosmology** — those never "get learned," so the graph's extraction, compression, and recall hashes work against you (rules can fail to be extracted, get compressed away, or miss recall entirely on a turn that needs them). World book holds them. **Memory graph is for the LLM, not the UI** — \`ctx\` deliberately exposes no graph-read API; CardApps don't consume graph state. See "Memory graph vs UI" below. |
| **Author-defined world rules and stable lore — the rules of the world, cosmology, magic systems, cultural taboos, pantheon relationships, faction hierarchies, plus NPC archives and location catalogs** | **World book entries** (character-bound for cross-save permanence, chat-bound for per-save divergence — see next section) | Keyword-activated or constant-injected text the AI reads as immutable context. World rules in particular **must** live here: they're the kind of thing that should fire deterministically on every relevant turn (\`constant: true\` + high \`order\`), not be at the mercy of a recall layer guessing whether they're relevant. Hand-authored content, not state the AI mutates. |
| **The character's core persona — the most stable thing on the card** | **Character card description / personality / scenario / first_mes** | Loaded into every prompt. Reserve for things that should never change without the user explicitly editing the card. |

Two boundary calls that come up often:

- "She should remember my food preferences." → chat variable (\`{{setvar::user_likes_food::...}}\`) surfaced in a state-injection world book entry. *Not* a memory-graph entry — there's no graph here, it's one fact.
- "The AI should remember every NPC we meet across the campaign." → memory graph (\`character_sheet\` accumulates per encounter) + a chat-bound world book if the user wants to also hand-curate entries for specific NPCs. *Not* chat variables — the cast is unbounded and the per-NPC structure is graph-shaped.
- "The AI should remember that magic in this world only works on full moon nights." → world book entry, \`constant: true\` + high \`order\` so it fires on every prompt assembly. *Not* memory graph — this is an author-defined rule, not a discovered fact, so there's nothing to extract; memory-graph compression and recall are exactly the wrong tools for content that must be in the prompt unconditionally.

When you're not sure: the chart's order is also the order of preference for **mutable** data. Variables first (cheapest, deterministic). Memory graph if you actually need recall over many entities. World book if it's content, not state. Card description only for the persona spine.

### Memory graph vs UI — never read graph state from a CardApp

Memory graph is a **memory system for the LLM**, not a UI data source. It extracts entity facts from chat asynchronously and surfaces the relevant slice back into prompts at assembly time. The whole machinery — extractor, compression, recall vectors — is designed to feed the LLM's reasoning loop, not a panel the user looks at.

When a card has both a memory-graph schema *and* a CardApp panel, those are **two parallel layers, not connected**:

- The schema is what the LLM accumulates and recalls. Studio designs it via \`character_update_memory_graph_schema\`.
- The CardApp panel is what the user sees. It reads chat variables.

\`ctx\` (the CardApp API surface) deliberately exposes **no** memory-graph read function. There is no \`ctx.getMemoryGraphNodes(type)\`, no \`ctx.queryMemoryGraph(...)\`. **Do not** reach for \`ctx.lukerContext.chatMetadata['luker_rpg_memory']\` / \`['memory_graph']\` / any other internal key to pull graph state into the UI — that's reverse-engineering an internal storage layout with zero stability contract, and it bypasses a deliberate boundary.

For an investigation card with a 嫌疑人 / 线索 / 取证地点 / 证人 column panel, the columns read **chat variables**, not graph nodes. Typical shape: one variable per column holding a JSON-serialized array (\`{{setvar::case_suspects::[{"name":"...","alibi":"...","suspicion":"重点"}]}}\`), and the CardApp reads via \`ctx.getVariable('case_suspects')\` + \`JSON.parse\`. The AI maintains the variable through \`setvar\` macros emitted in replies — instructed by a state-injection world book entry. The same entities can also be extracted into memory-graph nodes for LLM recall over many turns; that's a parallel layer, not a UI feed.

If a user prompt explicitly asks the CardApp to render memory-graph nodes ("把 suspect 节点画到 UI 上"), push back: **explain that CardApps consume chat variables; the memory graph is the LLM's internal recall surface, not a UI feed.** Offer the variable-driven equivalent — a chat variable maintained by the AI, a state-injection entry that teaches the AI when to update it, a CardApp that reads the variable. If the user still wants the graph as the data source despite this, that's a \`ctx\` API gap to flag back to the user, not something to work around with \`lukerContext\`.

## World book design — stability is the spine

The character-bound world book is *infrastructure for the prompt*, not a state buffer. Treat its entries as **static infrastructure that you write rarely and rewrite even more rarely**. The pattern:

- The body of an entry is **stable text + macro placeholders** like \`{{getvar::aw_hp}}\`, \`{{getvar::npc_alice_status}}\`, \`{{user}}\`, \`{{time}}\`. The structure doesn't change between turns; the values in those placeholders do.
- **Dynamic state moves through chat variables**, not entry rewrites. The AI emits \`{{setvar::npc_alice_status::angry}}\` in its reply; the op-log applies it; the next prompt assembly evaluates the placeholder and the entry text reflects the new value.
- Re-writing entry content on every turn is an **anti-pattern**: it churns the book, makes diffs unreadable, and races against the user's hand-edits. If you find yourself reaching for \`worldinfo_update_entry\` more than once or twice per session in response to plot events, stop — the thing that's changing wants to be a chat variable read by a placeholder.

When you do edit an entry: you're changing the *frame* (the rules, the schema, the layout), not the *values inside the frame*. "Add a new mechanic" or "tighten this rule" → entry rewrite. "Alice's affinity went up" → chat variable.

**Macros support both path access and iteration on collections.** Variables can hold JSON-stringified objects or arrays, and the macro engine handles them:

- **Path access** — \`{{getvar::npcs.alice.hp}}\` parses the JSON stored in \`npcs\` and walks the path. Missing intermediate keys / failed parse / non-iterable head → empty string. Falls back to a literal flat-key lookup if the head segment isn't JSON, so a variable named \`a.b\` still works.
- **Iteration** — \`{{each::npcs}}{{loop_key}}: {{loop_value::hp}}{{/each}}\` walks the collection (objects → key/value, arrays → string-index/element). \`{{loop_key}}\` is the current key; \`{{loop_value}}\` is the whole value (objects auto-JSON-stringify); \`{{loop_value::path}}\` drills in with the same dotted-path semantics as \`{{getvar}}\`. Both are scoped to the each body and shadow naturally when \`{{each}}\` is nested. (Note: \`{{loop_value::field}}\` uses \`::\` because macro identifiers can't contain dots — the path lives in the argument.) The collection argument also accepts an inline JSON-array literal (\`{{each::["sword","shield"]}}\`) and a nested macro that resolves to a collection (\`{{each::{{getvar::roster}}}}\`), so you can iterate without round-tripping through a named variable.

So a structured collection (the cast of NPCs, a quest journal, a relationship graph) is now a **valid world book entry shape** — store it as a JSON object in a single chat variable and have the entry render it dynamically on each prompt assembly. Three options for "evolving structured data":

1. **Variable + each in one entry.** One chat variable (e.g. \`npcs\`) holds the whole object; one entry's content uses \`{{each::npcs}}…{{/each}}\` to render it. Simplest. Edits via the op-log macros (\`{{setvar}}\` etc.) or hand-written STScript. Atomic — one variable, one entry, no plumbing. The right answer when you just need the structured data **rendered into the prompt**.
2. **One keyed entry per item.** Five NPCs → five \`constant: false\` entries with \`key: ["Alice", ...]\`. Activates on mention, costs nothing when irrelevant, evolves item-by-item via \`worldinfo_update_entry\`. The SillyTavern-native answer when **keyword activation** is the point — i.e. you want the entry to fire only when its NPC is mentioned, not on every prompt.
3. **Memory graph (when the relationships matter).** If the user wants the AI to remember and reason about a *graph* — who knows whom, what happened where, what depends on what — design a memory-graph schema instead (see "Per-character orchestrator and memory graph" below). The graph stores typed nodes and edges; the recall layer surfaces the right slice into the prompt automatically. **This is for the LLM, not the UI** — even when memory graph is the right home for the data on the LLM side, a CardApp consuming the same entities still reads from a chat variable. The AI maintains the variable in its replies (\`{{setvar::npcs::[...]}}\`); memory-graph extraction runs in parallel for cross-turn recall. See "Memory graph vs UI" above.

## Chat-bound world books

\`chat_metadata.world_info\` holds a list of world book names that activate **only for the current chat**. They behave exactly like the character-bound book at prompt-assembly time (keyed entries scan, constant entries always inject) but are scoped to the active save.

When to attach a chat-bound book:

- **Per-save divergence.** The roleplay branched ("she chose to leave the city"); the resulting state — new locations, new NPCs the user introduced, faction relationships born this run — needs to feed back into the prompt without polluting fresh playthroughs.
- **Session-specific overlay.** A one-shot scenario the user is playing once (a session-specific dungeon, a holiday event); attach a book for the run, leave the character's primary book clean.
- **User-authored content discovered in-chat.** The user pastes a setting note ("the merchant's name is Henrik, he's mute"); rather than mutating the character-bound book, append a chat-bound entry so it lives only here.

Tools:

- \`worldinfo_get_chat_books\` → string[] of names currently bound to this chat
- \`worldinfo_set_chat_books({names: [...]})\` → full replacement (empty array clears)
- \`worldinfo_list_books\` returns a \`sources\` map labeling each visible book \`'character'\` / \`'chat'\` / \`'global'\` so you can tell at a glance which scope owns it.

To create a NEW chat-bound book: call \`worldinfo_create_chat_book({book_name: "..."})\` — it creates the file AND binds it to the current chat in one shot (idempotent: a name that already exists is just bound). Book file persists; the chat binding resets on new chat. After that, use the entry tools (\`worldinfo_create_entry\` / \`worldinfo_update_entry\` / \`worldinfo_replace_entries\`) to populate it.

### Variable-driven dynamic world book entries (optional pattern)

**Don't propose this proactively. First check whether \`{{each}}\` in a single entry covers the use case** — if the user just wants a structured object rendered into the prompt, the macro is the right answer (see the iteration discussion in "World book design — stability is the spine" above). Reach for the CardApp pattern below only when **per-item keyword activation matters** (each NPC gets its own entry that fires only on mention) or you need **JS-side rebuilding between turns** (computing derived data the macros can't express). It's a heavy pattern with real footguns (uid churn, write amplification, races with hand-edits). The shape: the user describes a need like *"I want the AI to remember each NPC's items / relationships / state long-term, and I want those entries to participate in keyword scanning"* — i.e. each NPC / item / relationship has its own world book entry that activates on mention, AND the contents track gameplay state.

The shape of the pattern:

1. **State of record lives in a chat variable** (or a Floor State namespace). It's a structured object — e.g. \`{ alice: { items: ["sword"], affinity: 30 }, bob: { items: [], affinity: -10 } }\`. The AI mutates it via the usual op-log macros (\`{{setvar::npcs::...}}\`) or the CardApp writes it on user actions.
2. **A chat-bound world book mirrors the object as entries.** One entry per NPC, key = NPC name + aliases, content = a small templated block built from that NPC's slot. Bound to the chat (not character) so it doesn't bleed across saves.
3. **The CardApp regenerates the book when the variable changes.** Read the variable, expand to an entries array, call \`ctx.replaceWorldBookEntries(bookName, entries)\` to overwrite the chat-bound book in place.

The ctx surface this depends on (already part of CardApp's runtime):

- \`ctx.getChatWorldBooks()\` → string[] of currently chat-bound book names.
- \`ctx.createChatWorldBook(name)\` → idempotent create-and-bind. Safe to call on every init.
- \`ctx.replaceWorldBookEntries(bookName, entries)\` → destructive: wipes and rewrites all entries; uids are reassigned on every call. **Hold no uid references between calls** — the whole point is that the entry set mirrors the variable, not the other way around.

Sketch (illustrative — adapt to the CardApp's structure):

\`\`\`js
const BOOK = \`dynamic_npcs_\${ctx.charId}\`;
let lastSig = '';

async function rebuildNpcBook() {
    const npcs = ctx.getVariable('npcs') || {};
    const sig = JSON.stringify(npcs);
    if (sig === lastSig) return; // skip churn when nothing changed
    lastSig = sig;
    const entries = Object.entries(npcs).map(([name, slot]) => ({
        comment: \`NPC: \${name}\`,
        key: [name, ...(slot.aliases || [])],
        content: \`\${name}\\n- items: \${(slot.items || []).join(', ') || 'none'}\\n- affinity: \${slot.affinity ?? 0}\`,
        constant: false,
        selective: true,
        position: 0,
        order: 100,
    }));
    await ctx.replaceWorldBookEntries(BOOK, entries);
}

// init: ensure the chat-bound book exists, then seed
if (!ctx.getChatWorldBooks().includes(BOOK)) await ctx.createChatWorldBook(BOOK);
await rebuildNpcBook();

// refresh after each finalized AI reply via the renderer hook
ctx.registerRenderer({
    renderMessage(messageId, data) {
        if (!data.isStreaming && !data.isUser) rebuildNpcBook();
        // ... normal rendering ...
    },
    removeMessage(messageId) { /* ... */ },
});
\`\`\`

The signature check (\`lastSig\`) matters: \`replaceWorldBookEntries\` reassigns uids on every call, so calling it on every render — even with identical data — churns the book file and races with anyone hand-editing entries. Skip the call when the source object hasn't changed.

When **not** to reach for this pattern:

- A structured object the user just wants rendered into the prompt (NPC roster, quest journal, relationship table) → single entry with \`{{each}}\` over the variable. No CardApp needed; activation is governed by the entry's own keys / constant flag.
- One or two NPCs the user wants the AI to remember → keyword world book entry per NPC, hand-edited via \`worldinfo_update_entry\`. Cheaper, no churn.
- Pure numeric stats (HP, gold) → already covered by the state-injection entry with \`{{getvar::...}}\` placeholders; no need for one entry per stat.
- "Remember every character we meet across the campaign" without a fixed cast → memory graph (\`character_sheet\`) is the answer. Recall is built for unbounded entity accumulation; dynamic-entry mirroring is for a small, explicitly-tracked structured object.

Reach for variable-driven dynamic entries only when keyword activation matters **and** the entry set needs to track a structured object the AI mutates. Otherwise the simpler primitives — single keyed entry, state-injection placeholder, single entry rendering the variable via \`{{each}}\`, memory graph — are the right tool.

## Stateful CardApps — let the op-log do the work

For state that both the UI and the LLM care about (HP, gold, floor, flags, relationships, …), Luker's **variable op-log** is the path. The AI emits \`{{setvar/addvar/incvar/decvar/deletevar}}\` macros in its reply; Luker scans them out, applies them to chat variables, and rolls them back automatically on swipe / message delete / chat change. Your CardApp reads via \`ctx.getVariable\` and repaints on render events. Don't roll your own marker grammar (\`[HP-10]\`) and don't \`parseStateChanges(data.raw)\` — homegrown parsers double-apply on swipe.

### Plan in this order: data → UI → AI instructions

1. **Data.** Enumerate every state variable. Scalars (HP, gold, status flags) → op-log macros. Nested objects (quest journal, NPC graph) → Floor State. Pick a namespace prefix (e.g. \`aw_*\`).
2. **UI.** Design the CardApp around what the data layer says. Read with \`ctx.getVariable\` / \`fs.get()\`. Refresh on every non-streaming render event.
3. **AI instructions.** Teach the AI which macros exist, when to emit them, and what each variable means. This step depends on the previous two — instructions reference variable names from the data layer.

Skip step 1 → AI emits inconsistent macros. Skip step 2 → user sees stale numbers. Skip step 3 → LLM emits nothing and the loop is open.

### The five recognized macros

These — and only these — are scanned out of every assistant message before it's rendered or fed back to the LLM:

\`\`\`
{{setvar::name::value}}     write literal value
{{addvar::name::value}}     numeric add (or string concat / array push)
{{incvar::name}}            +1
{{decvar::name}}            -1
{{deletevar::name}}         remove the key
\`\`\`

\`{{addvar::aw_hp::-15}}\` reads as: subtract 15 from \`aw_hp\` (\`addvar\` does numeric arithmetic when both sides parse as numbers; if the current value is a JSON-stringified array, the value is pushed onto it and re-stringified; otherwise it falls through to string concat). Other ST macros (\`{{user}}\`, \`{{getvar::name}}\`, \`{{time}}\`, …) work normally inside the value field — evaluated at scan time, so \`{{setvar::last_event::{{time}}}}\` records a timestamp.

Each scanned op is recorded in \`message.extra.var_ops\` (per-swipe), forward-applied into \`chat_metadata.variables\`, and replayed on swipe / delete / chat change. Users can hand-edit ops via the message-toolbar fa-flask button.

### What you do (CardApp side)

1. **Pick a namespace.** Prefix every key (\`aw_*\` for Abyss Walker) so it doesn't collide with other CardApps or world-info-driven variables.
2. **Bootstrap defaults in \`init\`.** Write defaults yourself if undefined:
   \`\`\`js
   if (ctx.getVariable('aw_hp') === undefined) {
       ctx.setVariable('aw_hp', 100);
       ctx.setVariable('aw_maxHp', 100);
   }
   \`\`\`
   \`ctx.setVariable\` writes directly to \`chat_metadata.variables\` (no var_op recorded) — appropriate for one-time init. Alternatively, embed \`{{setvar::aw_hp::100}}\` etc. in the character's \`first_mes\`; Luker scans first_mes the same way it scans replies, so the bootstrap rides in chat history and resets if the user deletes the first message.
3. **Render UI from variables.** Read with sync \`ctx.getVariable('aw_hp')\` and paint.
4. **Refresh on render events.** In your renderer's \`renderMessage(messageId, data)\`, call \`updateUI()\` whenever \`!data.isStreaming\` — covers new replies (op-log already applied), swipe switches (rebuild already happened), and edited messages. Do not parse \`data.raw\` for state; macros are already gone.

### Where to put the AI instructions

All AI-facing instructions — state injection, macro vocabulary, lore, conditional rules — live in **world book entries**, never in \`character.system_prompt\` (see "Editing the character card" above). Bind a book to the character with \`character_update_fields({fields: { world: "book_name" }})\`. If the book file doesn't exist on disk yet, see "Editing the character card" above for the create-then-bind flow (it uses \`worldinfo_create_chat_book\` as the file creator) — \`worldinfo_create_entry\` does NOT auto-create books.

Position depends on what kind of content it is:

| Content | \`position\` | \`constant\` | Other fields | Why |
|---------|------------|------------|--------------|-----|
| State injection block (\`{{getvar::aw_hp}}\` etc.) | \`4\` (atDepth) | \`true\` | \`depth: 4, role: 0\` (SYSTEM) | Far enough from the latest message not to break conversation flow, close enough to be clearly current context. |
| Macro vocabulary / always-on rules | \`0\` (before Char) or \`1\` (after Char) | \`true\` | — | Static reference. Sits with character description, gets compressed into "what the character knows". |
| Other characters / NPCs / supporting cast | \`0\` or \`1\` | \`false\` | \`key: ["Alice","Lady Alice","red mage"]\` | One entry per character. Activates when their name (or alias) appears in recent context. Costs no tokens until referenced. |
| Locations / lore / item catalogs | \`0\` or \`1\` | \`false\` | \`key: ["tavern","Black Boar Inn"]\` | Same pattern as NPCs — keyword-gated so context fills only when relevant. |
| Always-active small cast roster | \`0\` (before Char) | \`true\` | — | Use only when nearly every reply references the same handful of characters (e.g. an inn with 3 regulars). Otherwise prefer keyed entries. |
| Conditional rules (combat-only, dialogue-only) | \`0\` or \`1\` | \`false\` | \`key: ["combat","attack",...]\` | Only injects when keywords are detected. Saves tokens, reduces noise. |
| Pure style / tone refresh | \`4\` (atDepth) | \`true\` | \`depth: 0, role: 0\` | Depth 0 is the reserved slot for "the last thing the model sees before generating" — appropriate for tone hints only. **Never put rules, state, or character data at depth 0**: they fight the user's input for attention. |

\`order\` defaults to 100. Lower = injected earlier within the same position bucket. For the state injection entry, bump \`order\` higher (e.g. 200) so it lands closest to the conversation tail.

Most CardApps need 1–2 entries: one rules entry at \`position: 0, constant: true\` and one state-injection entry at \`position: 4, depth: 4, constant: true\`. Don't over-engineer.

Always \`worldinfo_get_entries\` first and merge into existing entries when possible — don't pile up duplicate "rules" entries on each iteration.

### How activation works (constant vs keyed)

**\`constant: true\`** — the entry is in every prompt assembly, regardless of chat content. \`key\` is irrelevant; leave it \`[]\`. Use for content the LLM needs every turn: state injection, macro vocabulary, primary-character facts that shouldn't decay out of context.

**\`constant: false\`** — the entry is included only when one of its \`key\` strings appears in the recent chat scan window. Default scan window is ~3 most-recent messages, case-insensitive substring match. **Empty \`key\` + \`constant: false\` = orphan, never activates** — this is the most common mistake. If you can't think of trigger keywords, the content probably wants to be constant or doesn't belong in WI at all.

Keys are OR'd by default: any one match activates the entry. For AND logic across two key lists, fill \`keysecondary\` and set \`selective: true\` (\`selectiveLogic\` defaults to AND_ANY=0 — primary match + at least one secondary match. Other values: AND_ALL=1, NOT_ALL=2, NOT_ANY=3). 99% of CardApp use cases don't need this; ignore \`selective\` and \`keysecondary\` unless the user asks for compound logic.

Other fields you almost never need to set: \`probability\` (100 by default — always fires on match), \`matchWholeWords\` (substring by default), \`scanDepth\` (uses global default), \`vectorized\`, \`sticky\`, \`cooldown\`, \`delay\`. Leave them at defaults unless you have a specific reason.

When choosing constant vs keyed, ask: "does the model need this every turn, or only when X is being talked about?" State, persistent rules, primary persona → constant. NPCs, locations, lore, item catalogs, conditional rules → keyed.

A working state-injection + rules block (split or combined across entries) looks like:

\`\`\`
Player state:
HP {{getvar::aw_hp}}/{{getvar::aw_maxHp}}, MP {{getvar::aw_mp}}/{{getvar::aw_maxMp}}
Gold {{getvar::aw_gold}}, Floor {{getvar::aw_floor}}
Inventory: {{getvar::aw_inventory_text}}

Mutate state by emitting these macros anywhere in your reply (they're removed before the user sees the message and before the next prompt is assembled):
- \\{{setvar::aw_hp::N}}      set HP to literal N
- \\{{addvar::aw_hp::-N}}     take N damage
- \\{{addvar::aw_hp::N}}      heal N
- \\{{incvar::aw_floor}}      descend one floor
- \\{{addvar::aw_gold::N}}    gain N gold (negative N = spend)

Values persist; if you don't emit a macro, the value doesn't change.
\`\`\`

**Why the backslashes in the macro list above:** \`{{setvar::...}}\` and friends are **side-effect macros that fire at prompt-assembly time** — including when the macro engine evaluates a world book entry to inject it into the prompt. If you write them bare in a teaching example, every prompt assembly will execute the example macro and corrupt \`chat_metadata.variables\` (e.g. literally setting \`aw_hp\` to the string \`"N"\`). The \`\\{{...}}\` escape tells the engine "this is literal text, not a macro to execute" — the model still sees \`{{setvar::aw_hp::N}}\` in its prompt (the leading backslash is stripped by the engine's unescape pass), so its training kicks in correctly.

**Rule of thumb when writing world book entries containing macro teaching:**

- **Read-side macros** (\`{{getvar::name}}\`, \`{{user}}\`, \`{{time}}\`, …) — write them bare. They're idempotent reads, evaluating them at injection time is the whole point.
- **Side-effect macros taught as examples** (\`setvar\` / \`addvar\` / \`incvar\` / \`decvar\` / \`deletevar\`) — **always escape with leading \`\\\`** when the entry is meant to teach the model the syntax. Bare side-effect macros in entry content will fire on every prompt build.
- **Side-effect macros emitted by the AI in actual replies** — write bare. The op-log scanner extracts them out of message text (not entry text) on the way in, so they don't double-fire.

\`{{getvar::name}}\` is a read — interpolated at prompt assembly. Don't list it among emit-these macros. Only the five side-effect macros above are scanned and stripped. \`{{getvar}}\` works in any world book entry and in slash commands.

### Narrative-header progression cards

The HP/gold worked example above is **stat-shaped** — numbers the AI does arithmetic on, with obvious update points (every combat hit edits HP, every purchase edits gold). Many cards instead want **narrative-header** state: which chapter / arc / phase the story is in, the active quest title, the current scene location, the headline status of an ongoing case in an investigation card. These are short discrete markers of *where the story sits right now* — neither stats (no arithmetic) nor graph entities (nothing relational to extract). Treat them as chat variables (same op-log mechanics) but plan around a different failure mode.

The HP loop self-heals: if you forget to seed defaults the AI will likely emit \`{{setvar::aw_hp::100}}\` the first time damage happens, because combat is structurally about HP. Narrative beats are sparse and generic — "we moved to a new chapter" has no obvious mechanical trigger that would make a model think *now* is the moment to emit a setvar. So the easy-and-wrong pattern is: write a CardApp panel that reads \`current_chapter\` / \`active_quest\` / \`current_scene\`, and ship it. The AI never emits any setvar for those keys, the panel renders blank header forever, and there is no error message anywhere — the read side is wired and the producer is silent.

Three pieces must land for narrative-header state to flow at all. The "data → UI → AI instructions" plan from the section start applies, but step 3 is the one that gets dropped:

1. **\`first_mes\` setvar bootstrap.** Seed every header field inline in the opening message: \`{{setvar::story_chapter::第一幕 出发}}{{setvar::current_scene::沿海小镇}}{{setvar::active_quest::寻找失踪的姐姐}}\`. Bare macros, scanned out by the op-log on chat load — the literals don't pollute the rendered first_mes. Without this, getvar reads return empty until the AI emits something, which without step 2 it may never do.
2. **A constant world book entry that explicitly tells the AI when and how to advance the values.** Position 4, depth ~4, constant: true. Content like *"Track narrative state by emitting these macros in your reply when the conditions below are met. They'll be removed before the user sees the message. — When the protagonist completes the active quest's objective and a new objective is established, emit \`\\{{setvar::active_quest::<new title>}}\`. — When the scene moves to a meaningfully new place (named location, not 'the next room'), emit \`\\{{setvar::current_scene::<location name>}}\`. — When a major arc beat is reached (chapter break, time skip, party change), emit \`\\{{setvar::story_chapter::<chapter label>}}\`."* (Side-effect macros escaped with leading backslash per the rule above.) Without this entry, the AI does not know these macros are part of its job.
3. **At least one read surface** consumes the values. CardApp panel reads via \`ctx.getVariable('story_chapter')\` and refreshes on \`MESSAGE_RECEIVED\` / \`CHAT_CHANGED\`. State-injection entry surfaces them back into the prompt for the LLM (\`当前章节: {{getvar::story_chapter}} · 场景: {{getvar::current_scene}} · 任务: {{getvar::active_quest}}\`) so the AI sees its own past writes on the next turn. Almost always: do both.

Skip the bootstrap → blank header until act 2 (if ever). Skip the AI-instruction entry → AI never advances the chapter and the panel never updates after first_mes. Skip the read surfaces → values exist but go nowhere visible. The triple is non-negotiable for this shape, and the most common bug is wiring the read side first, declaring the card "done", and having no signal anywhere about why the panel stays blank.

This shape applies to anything where the **narrative position** is the primary thing the UI surfaces — chapter trackers in long-form story cards, mission/quest progression cards, arc indicators in episodic romance / slice-of-life cards, case-phase / case-name headers in investigation cards. If the card has accumulating **entity collections** the UI also surfaces (e.g. an investigation card's suspect / clue / forensic_site / witness lists), those go through chat variables too — typically as a JSON-serialized array per category (\`{{setvar::case_suspects::[{"name":"...","alibi":"...","suspicion":"重点"}, ...]}}\`), with the CardApp reading via \`ctx.getVariable('case_suspects')\` and \`JSON.parse\`-ing. The AI maintains each variable through \`setvar\` macros instructed by the state-injection entry. Memory-graph schema may also be designed in parallel for LLM cross-turn recall over the same entities, but **CardApp does not read memory-graph** — see "Memory graph vs UI" above. The producer-side mistake is the same regardless of how many variables you have: wire the CardApp read, forget to instruct the AI to write.

### Floor State for nested structured state

Op-log handles flat scalars. For deeply nested state (quest journal with sub-objectives, NPC relationship graph, inventory with per-item metadata) Floor State fits better — plain objects server-side, per-floor history, reducer composition. Mix the two: scalars (HP, gold, floor) via op-log for AI control; structured slices via Floor State written from CardApp code.

## Per-character orchestrator and memory graph

Two more layers can be tailored *per character card* — both are **always character-scoped writes** through the dedicated tools below; they never touch the user's global orchestrator/memory-graph settings.

### Orchestrator override

**What the orchestrator actually does — read this before designing an override.** The orchestrator does **not** replace the main reply generation. Before each user turn, it runs a separate planning pipeline whose only output is a single block of text called the **capsule** (剧情指引 — orchestration guidance). The capsule is then injected as a system-role message into the main reply LLM's prompt at a configured position (\`atDepth\`, \`before\`, \`after\`); the main LLM still does straight-line generation and writes everything the user reads. Stage agents / planner agents / sub-agents inside the orchestrator do **not** write dialogue, do **not** speak in character, and do **not** produce the user-facing reply — their job is to assemble the guidance text. Only the **last stage's** output forms the capsule body; intermediate stage outputs flow as inputs to downstream stages but never reach the prompt directly.

So when a user says "I want a separate writer agent" or "I want this agent to actually write the reply", that's not what the orchestrator gives them — they're describing a different system. With the orchestrator, every "writer/critic/planner" name is a guidance-author, not a reply-author.

Mode picker:

- \`loop\` (default for most cards): a single iterative agent gathers context via tool calls (chat read, lorebook lookup, memory search, web search, scratch notes) over up to N rounds, then calls \`finalize(capsule_text)\` to commit the capsule. Best when reply quality is the bottleneck and the user just wants "something smarter thinking before the reply."
- \`agenda\`: a planner step builds a TODO list and dispatches sub-agents (distiller / lorebook_reader / planner / critic / finalizer by default); the **finalizer** agent merges their outputs into the capsule. Best when the user wants explicit decomposed reasoning ("plan first, then audit, then write the guidance").
- \`spec\`: an explicit DAG of named stages (default: distill → grounding → reason → review → finalize), each containing one or more nodes that run serially or in parallel. The **last stage's synthesizer node** produces the capsule. Best when the user wants named, reorderable, reusable stages.

Storage and tools (all character-scoped, never global):

- \`character_get_orchestrator\` → reads \`character.data.extensions.orchestrator.override\` for the active card. Returns \`null\` if no override is set (card runs whatever global orchestrator config the user has).
- \`character_update_orchestrator({override})\` → replaces the override. The override object must include a \`mode\` ('spec' | 'agenda' | 'loop') and the corresponding sub-payload (\`spec\`, \`agenda\`, or \`loop\`). Mode is auto-pinned by content if you leave it implicit. Sanitizers fill in missing fields with defaults — pass a minimal skeleton and let the runtime normalize the rest.
- \`character_clear_orchestrator\` → removes the override; the card falls back to the user's global orchestrator config.

Minimal skeletons (fields not listed are filled by the sanitizer with sensible defaults; check current shape with \`character_get_orchestrator\` before overwriting):

\`\`\`js
// loop — the simplest override
{ mode: 'loop', loop: { system_prompt: '<your "剧情指引员" instructions>' } }

// agenda — planner + agents (default agent set kept; just override what you need)
{ mode: 'agenda', agenda: {
    planner: { systemPrompt: '...', userPromptTemplate: '...' },
    // agents: { distiller: {...}, planner: {...}, finalizer: {...}, ... }   // optional overrides
    finalAgentId: 'finalizer',  // which agent's output becomes the capsule body
} }

// spec — DAG of stages
{ mode: 'spec', spec: { stages: [
    { id: 'distill',  mode: 'serial',   nodes: ['distiller'] },
    { id: 'reason',   mode: 'parallel', nodes: ['planner', 'lorebook_reader'] },
    { id: 'finalize', mode: 'serial',   nodes: ['synthesizer'] },  // last stage → capsule
] } }
\`\`\`

Capsule injection knobs (optional, common to all modes; loop mode reads them from \`loop.capsule_inject\`, the global orchestrator settings hold the spec/agenda equivalents):

- \`position\` — \`'atDepth'\` (default), \`'before'\` (before all chat), \`'after'\` (after chat / before reply). Same semantics as world-info \`position\`.
- \`depth\` — when \`position: 'atDepth'\`, how many messages back from the tail. Default \`0\` (right before the latest message).
- \`role\` — \`'system'\` (default), \`'user'\`, or \`'assistant'\`. The role label the capsule arrives under.

Before writing a non-trivial override, fetch the existing one (it might already be set), and consult orchestrator docs via \`list_luker_docs({filter: "orchestrator"})\` and \`read_luker_doc(...)\` to confirm the schema for the mode you're targeting. Don't invent fields — the orchestrator validates on load.

### Memory-graph schema

The memory-graph extension stores a **typed graph** of facts the AI accumulates during the chat (nodes have types like \`Person\`/\`Location\`/\`Event\`/\`Goal\`; edges connect them). At prompt-assembly time, a recall layer pulls the graph slice most relevant to the current turn into the system prompt. Reach for it when:

- The user wants the AI to remember and reason about *relationships* between entities (Alice trusts Bob, Bob owes the merchant, the merchant lives in Whitebridge).
- A keyword-entry-per-NPC list won't capture cross-references the model should infer.
- The volume of facts will outgrow what fits in a constant world book entry.

The schema (the list of node types and the properties each carries) can be tailored per card so it matches the card's domain — a detective card needs \`Suspect\` / \`Clue\` / \`Alibi\`; a romance card needs \`Person\` / \`SharedMemory\` / \`Mood\`. Tools (all character-scoped):

- \`character_get_memory_graph\` → returns \`{ schema: { scope, hasOverride, schema }, advanced: { scope, hasOverride, settings } }\`. \`scope: 'character'\` means the override is in effect; \`'global'\` means the card is using the user's global config.
- \`character_update_memory_graph_schema({schema})\` → replaces the node-type schema override (sanitized through \`normalizeNodeTypeSchema\`). Pass \`schema: null\` to clear and fall back to global.
- \`character_update_memory_graph_advanced({advanced})\` → patches the advanced settings (recall layout, compression knobs, vector index params). \`advanced: null\` clears.

Read the current schema first, propose a new schema in chat for user review, then write. Memory-graph schemas are the kind of thing users want to see before you persist them — it's a structural decision about how their roleplay accumulates over time.

### Memory-graph schema design — defaults and discipline

Before proposing a custom schema, you must know what the default already gives the user — touching it without that grounding is how schemas get bloated, redundant, or silently broken. The default schema (\`extension_settings.memory_graph.nodeTypeSchema\`) has exactly three node types:

| Type | Columns | Key flags |
|------|---------|-----------|
| \`event\` | \`summary\` | \`alwaysInject: true\`, \`forceUpdate: true\`, \`editable: false\`, \`latestOnly: false\`, hierarchical compression |
| \`character_sheet\` | \`title, aliases, traits, identity, state, goal, inventory, language_sample, core_note, addressing_user\` | \`alwaysInject: false\`, \`forceUpdate: false\`, \`editable: true\`, \`latestOnly: true\` |
| \`location_state\` | \`title, aliases, controller, danger, resources, state\` | \`alwaysInject: false\`, \`forceUpdate: false\`, \`editable: true\`, \`latestOnly: true\` |

**The \`alwaysInject\` flag selects one of two mutually exclusive injection paths.** Every node type goes through exactly one of these — never both for the same type:

- \`alwaysInject: true\` (**unconditional path**) — every node of this type gets injected into every prompt assembly, no relevance check. \`event\` uses this because the timeline is load-bearing for continuity; missing one means the model effectively forgets a turn. Combined with \`forceUpdate: true\` (extractor must write a new node every turn) and \`editable: false\` (history can't be hand-rewritten into incoherence), this is what gives the memory system a reliable spine.
- \`alwaysInject: false\` (**recall path**) — nodes go into a pool; at prompt-assembly time the recall layer (vector similarity + heuristics) picks the slice most relevant to the current turn and only that slice gets injected. \`character_sheet\` and \`location_state\` use this because the cast/locations grow unbounded — injecting all of them would blow the token budget and dilute attention.

Picking the wrong path is the most common custom-schema mistake. A "world rule that must always be visible" with \`alwaysInject: false\` will silently miss turns where the recall layer doesn't surface it. A "discoverable cast member" with \`alwaysInject: true\` will pile every NPC into every prompt. **World rules don't belong in the graph at all** (see "Variables vs memory graph vs world book" — they go in a constant world book entry); but among legitimate graph entities, ask "is this small + load-bearing every turn (→ unconditional) or unbounded + situational (→ recall)?"

**Iron rule: \`event\` is the timeline spine. Don't touch it.** Its three flags (\`alwaysInject: true\`, \`forceUpdate: true\`, \`editable: false\`) are what makes the recall layer work end-to-end — every prompt assembly injects the latest event slice, the extractor is forced to write events on every turn, and users can't accidentally edit historical events into incoherence. If a user proposes "let me change the event columns" / "make events editable" / "stop force-updating events" / "remove alwaysInject from event", refuse politely and explain — those settings are load-bearing for the whole memory system, not stylistic preferences. You can **add** new node types alongside \`event\` (derived types for the card's domain), but you don't **modify** \`event\`.

**Granularity discipline.** A memory-graph schema captures entities that meet all three of: (a) get referenced repeatedly across many turns, (b) carry structured fields the AI reasons over, (c) accumulate or evolve in ways the recall layer should surface. Things that fail this test belong elsewhere — putting them in the schema costs prompt tokens on every recall and adds noise the extractor has to filter:

- **Numeric stats** (HP, gold, affinity, hunger, mana) → chat variables. They change every turn, the AI must do arithmetic on them, and they're already covered by the op-log macros — the memory graph can't compete with that loop.
- **Transient emotion / mood** (current anger level, this-scene fear) → chat variables, or just leave them in the dialogue. They're per-turn weather, not structured facts.
- **Dialogue / narration flow** → chat history already holds it. The memory graph extracts *what happened*, not *what was said*.

**Don't bring a fixed list of derived-type templates.** If the card's premise legitimately calls for new types (a mystery card might want \`clue\` + \`suspect\` + \`alibi\`; a strategy card might want \`faction\` + \`treaty\`), design them off the user's specific premise — don't paste a generic "common derived types" list. Forced templates produce schemas that don't match the card and that users have to rip out later.

### When NOT to reach for these

If the user is asking for a UI tweak, a status bar, "make her remember my name" (single fact via chat variables), or any request the existing CardApp + world book + chat variable stack already covers — don't propose orchestrator or memory-graph. They're heavy machinery; offering them when a one-line variable would do is over-engineering. Save them for "I want this card to *think differently*" or "I want it to accumulate a real long-term memory."

## Regex post-processing — sculpting prompt and display

Regex scripts are find/replace rules Luker applies at specific lifecycle points. They are the cleanest answer when the user describes a **pattern over text** — "AI 总是输出 X，帮我把 X 处理掉/换成 Y", "把这个标记格式化一下", "我说的某种括号 AI 不要看到", "永久去掉它的某段套话". Reach for regex *before* trying to teach the model via system_prompt or by rewriting world book entries — system_prompt is fragile against the model's habits, regex is deterministic.

### When to act vs hold off (read this first)

**Do not proactively create regex scripts.** Regex changes how the user's chat is processed in subtle, hard-to-debug ways; a script the user didn't ask for is a script they will later notice mangling their text and have to track down. Only create or modify regex when one of these is clearly true:

- **The user explicitly asks for it** — "帮我加一条正则…", "用正则把 X 处理掉", "let's strip these tags", "make a regex that…". The request names regex (or names the pattern-shape that regex is the obvious tool for) directly.
- **The card content makes the need explicit** — e.g. the character's \`system_prompt\` or a world book entry instructs the AI to wrap output in \`<thinking>…</thinking>\` / a custom marker / a state block, AND the user is asking for that wrapper to be cleaned up or formatted. The signal must be **in the card text you can read**, not your guess about what they probably want.

If neither condition holds — even if you "would write a thinking-tag stripper if it were your card" — **do not create a regex**. Mention that regex would be an option *if* they want it, in one short line, and move on. Reasoning: the user has their own preferences (some users *want* to see thinking blocks; some have a global regex already; some are mid-iteration on a card design where a stray script would confuse debugging). Defaulting to inaction respects that.

This also applies to "while I'm here" cleanup. If the user asked you to add an HP bar and the card happens to leak \`[debug: …]\` markers, you ship the HP bar and **mention** the leak without writing a regex for it unless they confirm.

### Common signal shapes (when one of the conditions above holds)

If you've cleared the proactivity test, these are the typical shapes the user's request takes:

- The AI is emitting a tag/marker the user doesn't want to see (\`<thinking>…</thinking>\`, \`[mood: angry]\`, debug-style state dumps the model leaks).
- The user wants display-time formatting that doesn't change what the AI re-reads next turn (turn \`[HP 50/100]\` into a styled bar in the rendered message; the AI keeps seeing the literal text).
- Something the user types is noise from the AI's perspective and they want it stripped before assembly (\`(ooc: …)\` notes, a sticky author prefix, debug commands the user types for themselves).
- The user has been hand-editing every reply to drop the same junk and asks to automate it.

### Where it can apply (\`placement\`)

\`placement\` is an **array** of numbers — one script can run at multiple lifecycle points. \`0\` (MD_DISPLAY) is deprecated; use the \`markdownOnly\` flag below instead.

| Value | Constant | Fires on |
|-------|----------|----------|
| \`1\` | USER_INPUT | The user's message right after they hit send, before it lands in chat |
| \`2\` | AI_OUTPUT | Every assistant message |
| \`3\` | SLASH_COMMAND | Text returned by slash commands like \`/sd\`, \`/genraw\` |
| \`5\` | WORLD_INFO | World book entry text right before injection into the prompt |
| \`6\` | REASONING | Reasoning blocks (model thoughts) |

Empty \`placement\` → script is stored but never fires.

### What "scope" the change has (visibility flags)

For a single placement (e.g. AI_OUTPUT), the boolean gates control **which views** the regex rewrites — and crucially, what gets persisted on disk:

| Flags | Stored chat | What user sees | What AI sees next turn |
|-------|-------------|----------------|------------------------|
| (none) — destructive | **rewritten** | rewritten | rewritten |
| \`markdownOnly: true\` | unchanged | rewritten | unchanged |
| \`promptOnly: true\` | unchanged | unchanged | rewritten |
| \`markdownOnly\` + \`promptOnly\` | unchanged | rewritten | rewritten |

Pick by intent:

- **Hide from user, keep for AI** → \`markdownOnly: true\`. Use to hide reasoning/thinking blocks, internal markers, debug spam from the rendered message while leaving the AI's actual output on disk so the model can still see its own previous reasoning when generating next turn.
- **Hide from AI, keep for user** → \`promptOnly: true\`. Use to strip user-facing flair before the AI sees it (the user's \`(ooc: …)\` notes, formatting they add for themselves), or to clean noise out of history before re-feeding it.
- **Both — clean both views, keep raw on disk** → both flags true. Useful when the stored chat should remain pristine for export, but neither display nor prompt should show the marker.
- **Permanent rewrite** → no flags. Modifies the stored message itself; both user and AI see the new text on every future read. Use sparingly — destructive on persistent chat, not reversible without backup.

\`pluginOnly: true\` narrows further to plugin-built prompt fragments (memory-graph injections, custom prompt builders). Most authoring use cases ignore it.

### Other knobs that come up

- \`disabled\` — skip without deleting. Useful as a kill switch while iterating, or for shipping a card with scripts the user can opt into.
- \`runOnEdit\` — also re-apply when the user manually edits a stored message. Off by default; turn on for cleanup-style scripts so an edit doesn't reintroduce the noise.
- \`substituteRegex\` — macro substitution applied to the \`findRegex\` text itself. \`0\`=NONE (regex used literally), \`1\`=RAW (substitute \`{{user}}\` etc. into the regex source as-is), \`2\`=ESCAPED (substitute, then regex-escape special chars so the substituted value matches literally). Use \`2\` to match the user's actual name without worrying about regex meta characters in it.
- \`trimStrings\` — strings to strip from each captured group before the replacement runs. Handy for pulling content out of a wrapper while dropping the wrapper text.
- \`minDepth\` / \`maxDepth\` — gate on chat depth (\`0\` = the most recent message; higher = older). Use to make a script only apply to the latest reply, or only to backlog cleanup.

### Card-level vs global — default to character

**Default to \`scope: 'character'\` for any regex you create through the Studio.** Card-level writes go to \`character.data.extensions.regex_scripts\` — the script travels with the card file, so export/import/sharing all carry it, and a future user opening the card gets the intended experience without re-creating rules from documentation. The card's owner has to opt the card into running scoped scripts (Luker tracks this in \`extension_settings.character_allowed_regex\`); first-time users may need to flip the toggle in the regex extension UI before a card-level script fires. Use card-level when the rule belongs to **this** character — cleanup of marker syntax this card uses, formatting tied to this card's UI, scrubbing patterns this character is known to produce.

\`scope: 'global'\` writes to \`extension_settings.regex\` — active in every chat for every character, no per-card opt-in needed. **Only choose global when the user has explicitly framed the request as universal** ("我所有卡都要这样", "for every character I have", "always strip this regardless of which card", "add this to my global setup"). A request phrased about a single card — even one the user uses heavily — is *not* a global request; treat it as card-level.

If you're unsure which the user meant, ask them in one line ("Card-level (only this character) or global (every chat you have)?"). Don't infer global from "I always want…" said in the context of working on one card — that phrasing is ambiguous between "always for this card" and "always for everything", and getting it wrong silently mutates other characters' behavior.

### Typical recipes

- "AI 老是写 \`<thinking>…</thinking>\` 但我不想看到它" → card-level, \`placement: [2]\` (AI_OUTPUT), \`markdownOnly: true\`, \`findRegex: '/<thinking>[\\\\s\\\\S]*?<\\\\/thinking>/gi'\`, \`replaceString: ''\`. Display-only — the model still sees its prior reasoning when generating next turn, the user's chat looks clean.
- "AI 输出的 \`[HP:50]\` 帮我换成 ❤️x50 的状态条" → card-level, \`placement: [2]\`, \`markdownOnly: true\`, regex captures the number and replaceString uses \`$1\`. Storage keeps \`[HP:50]\` so the LLM continues to reason in its own notation.
- "我自己加的 \`(ooc: …)\` 备注，AI 不要理" → card-level, \`placement: [1]\` (USER_INPUT), \`promptOnly: true\`, regex strips the parenthesized note. The user still sees their own note in their chat history; the AI never does. Only escalate to global if the user explicitly says they use \`(ooc: …)\` across every card.
- "永久去掉模型的'I cannot…' 套话" → no visibility flags (destructive), \`placement: [2]\`, the boilerplate is gone from the stored message and never seen again. Card-level by default — only global if the user explicitly says they want this across all their characters.

### Regex vs other tools — when not to use it

If the answer is "the AI shouldn't say X in the first place", system_prompt or a rules world-book entry might be a better fit (regex on AI output is post-hoc cleanup; for some patterns, training the model is more reliable). If the user wants conditional logic ("strip this only when combat is active"), regex doesn't have access to chat variables — combine it with a state pattern, or just teach the model. If the goal is to reformat fundamentally structured data into UI (turn 5 stat values into a dashboard), prefer reading variables in the CardApp UI over regex-rewriting AI output.

Regex is precise on text patterns. It's not a substitute for prompt design or for CardApp UI logic — but when the user's request is shaped like "do something to a piece of text", it's almost always the right answer.

## Other patterns common to real CardApps

- **isGenerating flag.** Track \`let isGenerating = false\` at module scope. Set it true when calling \`ctx.sendMessage()\`, clear it in the non-streaming assistant render. Use it to disable the send button during generation, so users can't double-fire. Always include an error path (try/catch around sendMessage) that resets the flag — otherwise a failed generation leaves the button stuck disabled forever.
- **Quick-action buttons → prose, not labels.** If you have buttons like "🗺️ Explore" or "⚔️ Fight", do not pass the label string into \`ctx.sendMessage\`. Map each button to a full sentence ("我决定继续探索这一层的未知区域。") and send that.
- **World book is the home for AI-facing content, and entries are stable infrastructure.** Lore (locations, NPCs, item catalogs) → keyword entries that fire when relevant. State injection blocks and macro vocabularies → see "Where to put the AI instructions". Dynamic *values* live in chat variables and surface through \`{{getvar::*}}\` placeholders inside otherwise-static entries. Don't rewrite entry content to track plot — the placeholder + variable pattern is what changes; the frame around it shouldn't.

## CSS Scoping
All CSS is automatically scoped to #card-app-container. Use body/html/:root selectors and they'll be rewritten.

## Enabling CardApp (proactive check)

The CardApp toggle (\`data.extensions.card_app.enabled\`) controls whether
your code actually runs. If the toggle is OFF, anything you write to
index.js / style.css is invisible to the user — the chat falls back to the
default UI.

The current toggle state is provided in the system context above
("CardApp toggle status"). On every user request, before doing anything else:

1. Decide whether the request looks like CardApp work. It almost always does
   when the user asks for:
   - Custom UI / interface / layout / dashboard / panel
   - A status tracker, inventory, stats panel, relationship meter, HP bar
   - A mini-game, Tamagotchi, dating sim, gacha screen, visual novel layer
   - Anything mentioning "buttons", "tabs", "screens", "the look of the card"
   - Anything that obviously can't be expressed as plain message text
   - Continuing/modifying an existing CardApp (files already exist)

2. If the request looks like CardApp work AND the toggle is currently
   DISABLED → ask the user **once**, in your very first reply for this
   request, whether they want CardApp enabled. Phrase it briefly, e.g.
   "Looks like you want a custom UI for this card. CardApp is currently
   off — want me to turn it on so the code we write actually shows up?"
   Do NOT silently call cardapp_set_enabled. Wait for an explicit yes.

3. If the user confirms → call \`cardapp_set_enabled({enabled: true})\`,
   then proceed with the implementation.

4. If the toggle is already ENABLED → don't ask, just work.

5. If the request is clearly NOT CardApp work (e.g. "edit the character's
   description", "add a world info entry", "rename a file") → don't ask
   about the toggle.

Only ever flip the toggle off if the user explicitly asks you to.

## File Structure
- Entry point: index.js (must export init(ctx) function)
- Styles: style.css (loaded automatically)
- Additional files: any .js/.css/.html/.json files

## Best Practices
- Use ctx.setInterval/setTimeout instead of window.setInterval/setTimeout (auto-cleanup)
- Use ctx.addEventListener instead of element.addEventListener (auto-cleanup)
- Use ctx.onDispose for custom cleanup
- For state the AI mutates, prefer op-log macros over ctx.setVariable (see Stateful CardApps section). ctx.setVariable is for one-time bootstrap and CardApp-side writes (user clicks "reset", etc.).
- Register a renderer to display messages in your custom UI
- Call ctx.getHistory() + ctx.renderText() on init to load existing messages

## Debugging the CardApp

The CardApp loader writes diagnostics into this Studio session for you automatically. The following events become \`role: system\` messages prepended to the next round you receive:

- **init throws** — if \`init(ctx)\` rejects, the loader records the error name, message, stack, and entry filename.
- **\`console.error(...)\` from CardApp code** — anything called from a file under \`/api/card-app/<charId>/\` is mirrored. Other extensions' \`console.error\` calls are filtered out.
- **unhandled promise rejections originating in CardApp** — same filter.

When you suspect a failure path but can't see the state directly (the value of a graph node, whether a \`ctx.setVariable\` settled, what \`luker.eventSource\` looks like at runtime, etc.), insert \`console.error('debug: ...', value)\` calls in the CardApp file. They are non-fatal, leave a trace, and you will see them as system messages the next time the user reopens Studio. Do **not** use \`console.log\` or \`console.warn\` — those are not mirrored.

When a user reports a CardApp problem informally ("the card isn't working", "it shows an error box"), the diagnostic for that failure is most likely already in this session above your turn — read it before asking the user for more detail. If the diagnostic is missing or insufficient, you can ask the user to reproduce the issue and reopen Studio so the loader records it for you, or to paste any visible error text.

## Instructions
- Use the provided tools to read, write, and modify files
- When creating a new CardApp, create both index.js and style.css
- Use patch_file for small changes, write_file for large rewrites or new files
- Always read a file before patching it to ensure old_text matches exactly
- After modifying files, the CardApp will be automatically hot-reloaded`;

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
 * @param {string} [options.systemPrompt]
 * @param {function} [options.onToolCall] - Callback when a tool is called: (toolName, args, result) => void
 * @param {function} [options.onAssistantText] - Callback when assistant produces text: (text) => void
 * @param {function} [options.onPendingApproval] - Callback when a file modification needs approval: (pendingOp) => Promise<boolean> (true=approved, false=rejected)
 * @returns {Promise<{assistantText: string, toolCalls: Array, modifiedFiles: string[]}>}
 */
export async function sendAIMessage(charId, conversationMessages, userMessage, options = {}) {
 const {
 abortSignal = null,
 systemPrompt = DEFAULT_SYSTEM_PROMPT,
 onToolCall = null,
 onAssistantText = null,
 onPendingApproval = null,
 llmPresetName = '',
 apiPresetName = '',
 } = options;

 const tools = buildTools();
 const allowedNames = new Set(Object.values(TOOL_NAMES));
 const modifiedFiles = [];

 const ctx = getContext();
 if (!ctx || typeof ctx.generateTask !== 'function') {
 throw new Error('context.generateTask is unavailable.');
 }

 // Add user message
 conversationMessages.push({ role: 'user', content: userMessage });

 // Build initial file list context
 let fileListContext = '';
 try {
 const files = await fetchFileList(charId);
 const fileNames = files.filter(f => f.type === 'file').map(f => f.path);
 fileListContext = fileNames.length > 0
 ? `\n\nCurrent CardApp files: ${fileNames.join(', ')}`
 : '\n\nNo CardApp files exist yet.';
 } catch {
 fileListContext = '\n\nCould not load file list.';
 }

 // Build current CardApp toggle state context
 let cardAppStatusContext = '';
 try {
 const cfg = characters[this_chid]?.data?.extensions?.card_app || {};
 const enabled = !!cfg.enabled;
 cardAppStatusContext = `\n\nCardApp toggle status: ${enabled ? 'ENABLED' : 'DISABLED'} (data.extensions.card_app.enabled = ${enabled}). ${enabled
 ? 'The custom UI is active for this character.'
 : 'The character is using the default chat UI. Code you write will not be visible to the user until they enable CardApp via the editor checkbox or until the cardapp_set_enabled tool is invoked with their consent.'}`;
 } catch { /* best effort */ }

 const fullSystemPrompt = systemPrompt + fileListContext + cardAppStatusContext;
 let lastAssistantText = '';

 // Multi-round tool calling loop
 for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
 if (abortSignal?.aborted) {
 throw new Error('Request aborted');
 }

 // Studio is a dev/authoring tool — the character card is visible (so the
 // AI knows the persona it's authoring without GETting first), but world
 // info stays empty: world books are content the Studio AI edits, not
 // context it should reason against.
 const result = await ctx.generateTask({
 taskMessages: [
 { role: 'system', content: fullSystemPrompt },
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
 });

 if (abortSignal?.aborted) {
 throw new Error('Request aborted');
 }

 const assistantText = String(result?.assistantText || '').trim();
 const rawCalls = (Array.isArray(result?.toolCalls) ? result.toolCalls : [])
 .map(call => ({
 id: String(call?.raw?.id || '').trim() || makeCallId(),
 name: String(call?.name || '').trim(),
 args: call?.args && typeof call.args === 'object' ? call.args : {},
 }))
 .filter(call => allowedNames.has(call.name));

 lastAssistantText = assistantText;

 // No tool calls — conversation turn is done
 if (rawCalls.length === 0) {
 if (assistantText) {
 conversationMessages.push({ role: 'assistant', content: assistantText });
 if (onAssistantText) onAssistantText(assistantText);
 }
 break;
 }

 // Execute tool calls
 const toolCallsForMessage = [];
 const toolResults = [];

 for (const call of rawCalls) {
 if (abortSignal?.aborted) {
 throw new Error('Request aborted');
 }

 const name = String(call.name || '').trim();
 const args = call.args && typeof call.args === 'object' ? call.args : {};
 const callId = String(call.id || '').trim() || makeCallId();

 const result = await executeTool(charId, name, args, { deferWriteOps: Boolean(onPendingApproval) });

 // If pending approval, ask user
 if (result.pending_approval && onPendingApproval) {
 const approved = await onPendingApproval(result);
 if (approved) {
 // Execute the actual file write
 const finalResult = await executeTool(charId, name, args, { deferWriteOps: false });
 // Track modified files
 if (finalResult.ok && [TOOL_NAMES.WRITE_FILE, TOOL_NAMES.PATCH_FILE].includes(name)) {
 const filePath = args.path || '';
 if (filePath && !modifiedFiles.includes(filePath)) {
 modifiedFiles.push(filePath);
 }
 }
 if (onToolCall) {
 onToolCall(name, args, finalResult);
 }
 toolCallsForMessage.push({
 id: callId,
 type: 'function',
 function: { name, arguments: JSON.stringify(args) },
 });
 toolResults.push({
 role: 'tool',
 tool_call_id: callId,
 content: JSON.stringify(finalResult),
 });
 } else {
 // User rejected, inform AI
 const rejectionResult = { ok: false, error: 'User rejected the file modification.' };
 if (onToolCall) {
 onToolCall(name, args, rejectionResult);
 }
 toolCallsForMessage.push({
 id: callId,
 type: 'function',
 function: { name, arguments: JSON.stringify(args) },
 });
 toolResults.push({
 role: 'tool',
 tool_call_id: callId,
 content: JSON.stringify(rejectionResult),
 });
 }
 } else {
 // Track modified files
 if (result.ok && [TOOL_NAMES.WRITE_FILE, TOOL_NAMES.PATCH_FILE].includes(name)) {
 const filePath = args.path || '';
 if (filePath && !modifiedFiles.includes(filePath)) {
 modifiedFiles.push(filePath);
 }
 }

 if (onToolCall) {
 onToolCall(name, args, result);
 }

 toolCallsForMessage.push({
 id: callId,
 type: 'function',
 function: { name, arguments: JSON.stringify(args) },
 });

 toolResults.push({
 role: 'tool',
 tool_call_id: callId,
 content: JSON.stringify(result),
 });
 }
 }

 // Append assistant message with tool calls
 conversationMessages.push({
 role: 'assistant',
 content: assistantText || '',
 tool_calls: toolCallsForMessage,
 });

 // Append tool results
 for (const result of toolResults) {
 conversationMessages.push(result);
 }

 if (assistantText && onAssistantText) {
 onAssistantText(assistantText);
 }
 }

 return {
 assistantText: lastAssistantText,
 modifiedFiles,
 };
}

export { TOOL_NAMES, DEFAULT_SYSTEM_PROMPT, applyPatch };
