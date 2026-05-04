/**
 * CardApp Studio AI Chat - Function-calling based AI assistant for CardApp development.
 *
 * Uses sendOpenAIRequest('quiet') with tool definitions to let AI read/write CardApp files.
 * Reuses function-call-runtime.js for tool call extraction and validation.
 */

import { sendOpenAIRequest } from '../../../openai.js';
import {
 TOOL_PROTOCOL_STYLE,
 extractToolCallsFromResponse,
 getResponseMessageContent,
 validateParsedToolCalls,
} from '../../function-call-runtime.js';
import { fetchFileList, fetchFileContent, saveFileContent, deleteFile, renameFile } from './studio.js';
import { characters, this_chid, saveCharacterDebounced, getRequestHeaders } from '../../../../script.js';
import { loadWorldInfo, createWorldInfoEntry, deleteWorldInfoEntry, saveWorldInfo, selected_world_info } from '../../../world-info.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { getContext } from '../../../st-context.js';

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
 description: 'Get all editable fields of the current character card (name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags, talkativeness, depth_prompt settings).',
 parameters: { type: 'object', properties: {}, additionalProperties: false },
 },
 },
 {
 type: 'function',
 function: {
 name: TOOL_NAMES.CHARACTER_UPDATE_FIELDS,
 description: 'Update one or more character card fields. Supported keys: name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes, creator, character_version, tags (comma-separated string), talkativeness (number 0-1), depth_prompt_prompt, depth_prompt_depth, depth_prompt_role.',
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
 description: 'List world book names associated with the current character (character-bound + globally activated).',
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
 selective: { type: 'boolean', description: 'Selective triggering (default false)' },
 disable: { type: 'boolean', description: 'Disabled (default false)' },
 position: { type: 'number', description: 'Injection position' },
 order: { type: 'number', description: 'Sort order' },
 depth: { type: 'number', description: 'Injection depth' },
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
 const books = [];
 const charData = characters[this_chid];
 const boundBook = String(charData?.data?.extensions?.world || '').trim();
 if (boundBook) books.push(boundBook);
 if (Array.isArray(selected_world_info)) {
 for (const name of selected_world_info) {
 if (name && !books.includes(name)) books.push(name);
 }
 }
 return { ok: true, books };
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

CardApp is Luker's custom UI system for character cards. A CardApp replaces the default chat interface with a custom frontend.

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
- ctx.getVariable(key) — Get chat variable
- ctx.setVariable(key, value) — Set chat variable (persisted)
- ctx.getChatState(namespace) — Get namespaced chat state
- ctx.setChatState(namespace, key, value) — Set namespaced chat state

### Chat Management
- ctx.getChatList() — List all chats for this character
- ctx.switchChat(chatName) — Switch to a different chat
- ctx.newChat() — Create new chat
- ctx.closeChat() — Close current chat

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

Always discover exact names and signatures with these tools before writing
ctx.lukerContext.X(...) or ctx.executeSlashCommand('/X ...') calls. Don't guess
slash command syntax — the help tool tells you whether arguments are named
(key=value) or unnamed, and which enums are valid.

## Floor State (recommended for CardApp persistent state)

**Use Floor State instead of ctx.setChatState/getChatState for any per-chat
state that should follow swipes, message deletions, and chat switches
automatically.** This is the right answer for game progress, trackers,
counters, inventories, and almost anything a CardApp persists per chat.

Floor State is a thin layer on top of chat state that logs every write at the
chat tail (floor index + swipe id) and replays surviving commits whenever the
chat structure changes. So when the user swipes back, deletes a message, or
switches chats, your state stays consistent with the active conversation path
without any reconciliation code on your side.

### Quick start

\`\`\`js
// During init (it's async; create once and reuse the instance):
const fs = await ctx.lukerContext.createFloorState({ namespace: 'my-cardapp' });

// Reducer-style writes: receive current state, return next. Diff is computed
// and committed for you.
await fs.update((current) => ({ ...current, score: (current?.score ?? 0) + 1 }));

// Read current state:
const state = await fs.get();

// In handlers that fire near CHAT_CHANGED / MESSAGE_SWIPED / MESSAGE_DELETED,
// await ready() before reading so any in-flight rebuild finishes first:
await fs.ready();
const latest = await fs.get();
\`\`\`

### Hard rules (violating these breaks state)

- One namespace, one owner. Do NOT mix \`ctx.setChatState(ns, ...)\` and
  \`fs.update(...)\` against the same namespace — the floor rebuild will
  overwrite the raw write.
- Reducer must return a plain object. Returning array, primitive, null, or
  undefined is treated as "no change" (no commit, silent).
- Each instance owns one namespace. Create separate instances per logical
  state slice.
- Namespaces ending in \`__floor_log\` are reserved for private commit logs.

For full API (advanced patch mode, attaching to a non-tail floor with
\`{floor, swipeId}\`, conventions), call
\`read_luker_doc({path: "development/extension-api/chat-and-state.md"})\` and
read the "Floor State" section.

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
- Use ctx.setVariable for persistent game state
- Register a renderer to display messages in your custom UI
- Call ctx.getHistory() + ctx.renderText() on init to load existing messages

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
 apiSettingsOverride = null,
 } = options;

 const tools = buildTools();
 const allowedNames = new Set(Object.values(TOOL_NAMES));
 const modifiedFiles = [];

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

 // Build messages for the API
 const requestMessages = [
 { role: 'system', content: fullSystemPrompt },
 ...conversationMessages,
 ];

 // Call the LLM
 const responseData = await sendOpenAIRequest('quiet', requestMessages, abortSignal, {
 tools,
 toolChoice: 'auto',
 replaceTools: true,
 requestScope: 'extension_internal',
 llmPresetName,
 apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
 functionCallOptions: {
 protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
 },
 });

 if (abortSignal?.aborted) {
 throw new Error('Request aborted');
 }

 const assistantText = String(getResponseMessageContent(responseData) || '').trim();
 const rawCalls = extractToolCallsFromResponse(responseData)
 .filter(call => allowedNames.has(String(call?.name || '').trim()));

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
