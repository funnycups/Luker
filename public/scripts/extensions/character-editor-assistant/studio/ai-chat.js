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
import { characters, this_chid, saveCharacterDebounced, getRequestHeaders } from '../../../../script.js';
import { loadWorldInfo, createWorldInfoEntry, deleteWorldInfoEntry, saveWorldInfo, selected_world_info, charUpdatePrimaryWorld } from '../../../world-info.js';
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
 position: { type: 'number', description: 'Injection position: 0=before char desc (↑Char), 1=after char desc (↓Char), 2=above author note (↑AT), 3=below author note (↓AT), 4=at chat depth (uses depth+role), 5=top of example messages (↑EM), 6=bottom of example messages (↓EM)' },
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
| VN / 视觉小说 / 选项分支 | Scenes, sprites, multiple-choice buttons | CardApp UI work + quick-action buttons whose text is a full sentence; scene-keyword WI entries for location lore |
| 养成 / 小游戏 / 模拟 | Mechanics layered on RP | Decide which mechanics are UI-only (purely cosmetic timers, etc.) and which the AI must reason about (those go through chat vars + macros) |
| 卡片好看点 / 改 UI / 美化 | Pure visual work | CardApp CSS / HTML changes; no character or WI changes needed |

Iteration is the norm. The user runs your output, asks tweaks, repeat. Keep each change small and reversible — don't preemptively rewrite the world book on every request, don't restructure the CardApp file layout for what's actually a CSS tweak.

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

**Where this content goes instead: world books.** State injection blocks, macro vocabularies, location descriptions, NPC rules — anything that's *content for the LLM* — goes into world book entries. Bind one book to the character via \`character_update_fields({world: "book_name"})\` (single book name, no \`.json\` extension). See "Where to put the AI instructions" below for positioning details.

**Other characters in the scenario.** A character card describes ONE persona — the primary character the AI plays. Side characters, NPCs, mentioned-only roles, antagonists, multi-character scenarios where the AI alternates personas — all of these live in world book entries, never in \`character.description\`. Each non-primary character gets its own keyword entry (key includes their name and any aliases), so they activate when referenced. State variables for those characters use a per-character namespace (e.g. \`npc_alice_affinity\`, \`npc_bob_trust\`, \`npc_carol_hp\`) and join the same state-injection entry as the primary character's stats.

## Persistence boundaries

Pick storage by lifetime. Getting this wrong leaves ghost state from a previous run, or loses progression that should survive.

| Surface | Scope | Reset on |
|---------|-------|----------|
| Chat variables (\`chat_metadata.variables\` — op-log target, \`ctx.getVariable\`/\`ctx.setVariable\`) | Per chat per character | New chat created or switched-to |
| Floor State namespaces (\`chat_metadata.<ns>\`, server-backed) | Per chat per character | New chat |
| Character card fields (\`description\`, \`first_mes\`, \`extensions.world\`, …) | Per character — shared across **every** chat with that character | Character deleted |
| Bound world book entries | Per book — shared across every character bound to that book | Book deleted |

Per-run progression (this dungeon's HP, current floor, gold gathered, what's been looted) → **chat variables**. Resets cleanly when the player starts a new chat — which is what "new game" means.

Persistent character knowledge / world facts (location list, NPC personas, item catalogs, cast roster, scenario premise) → **world book entries**. Survives across runs, isn't wiped by "new game".

Character voice, primary persona, opening scene, alternate greetings → **character card** fields. Never resets unless the character is deleted.

Quick test when deciding: "should this survive 'new chat'?" Yes → world book or character. No → chat variables. If you stuff per-run state into character description or world book, you'll see ghost values bleed across playthroughs; if you stuff persistent lore into chat variables, it's gone the moment the player starts over.

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

\`{{addvar::aw_hp::-15}}\` reads as: subtract 15 from \`aw_hp\` (\`addvar\` does numeric arithmetic when both sides parse as numbers; otherwise string-concats). Other ST macros (\`{{user}}\`, \`{{getvar::name}}\`, \`{{time}}\`, …) work normally inside the value field — evaluated at scan time, so \`{{setvar::last_event::{{time}}}}\` records a timestamp.

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

All AI-facing instructions — state injection, macro vocabulary, lore, conditional rules — live in **world book entries**, never in \`character.system_prompt\` (see "Editing the character card" above). Bind a book to the character with \`character_update_fields({world: "book_name"})\`. Create the book itself by creating its first entry; \`worldinfo_create_entry\` will create the book file if it doesn't exist.

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

Keys are OR'd by default: any one match activates the entry. For AND logic across two key lists, fill \`keysecondary\` and set \`selective: true\` (default \`selectiveLogic\` AND_ANY — primary match + at least one secondary match). 99% of CardApp use cases don't need this; ignore \`selective\` and \`keysecondary\` unless the user asks for compound logic.

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

### Floor State for nested structured state

Op-log handles flat scalars. For deeply nested state (quest journal with sub-objectives, NPC relationship graph, inventory with per-item metadata) Floor State fits better — plain objects server-side, per-floor history, reducer composition. Mix the two: scalars (HP, gold, floor) via op-log for AI control; structured slices via Floor State written from CardApp code.

## Other patterns common to real CardApps

- **isGenerating flag.** Track \`let isGenerating = false\` at module scope. Set it true when calling \`ctx.sendMessage()\`, clear it in the non-streaming assistant render. Use it to disable the send button during generation, so users can't double-fire. Always include an error path (try/catch around sendMessage) that resets the flag — otherwise a failed generation leaves the button stuck disabled forever.
- **Quick-action buttons → prose, not labels.** If you have buttons like "🗺️ Explore" or "⚔️ Fight", do not pass the label string into \`ctx.sendMessage\`. Map each button to a full sentence ("我决定继续探索这一层的未知区域。") and send that.
- **World book is the home for AI-facing content.** Lore (locations, NPCs, item catalogs) → keyword entries that fire when relevant. State injection blocks and macro vocabularies → see "Where to put the AI instructions". Dynamic *values* still belong in chat variables, not WI — WI doesn't auto-refresh.

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

 // Studio is a dev/authoring tool — pass system + history raw, no character card,
 // no world info. context.generateTask handles dispatch and response normalization.
 const result = await ctx.generateTask({
 taskMessages: [
 { role: 'system', content: fullSystemPrompt },
 ...conversationMessages,
 ],
 includeCharacterCard: false,
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
