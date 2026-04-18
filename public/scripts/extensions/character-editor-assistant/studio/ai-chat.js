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
import { characters, this_chid, saveCharacterDebounced } from '../../../../script.js';
import { loadWorldInfo, createWorldInfoEntry, deleteWorldInfoEntry, saveWorldInfo, selected_world_info } from '../../../world-info.js';

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

## CSS Scoping
All CSS is automatically scoped to #card-app-container. Use body/html/:root selectors and they'll be rewritten.

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
 apiPresetName = '',
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

 const fullSystemPrompt = systemPrompt + fileListContext;
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
 apiPresetName,
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
