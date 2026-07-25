// SPDX-License-Identifier: AGPL-3.0-or-later
// Request Inspector — per-user ring buffer for generation request diagnostics.

import express from 'express';
import { randomUUID } from 'node:crypto';

const RING_BUFFER_SIZE = 200;

/** @type {Map<string, InspectorEntry[]>} handle -> entries */
const buffers = new Map();

function getBuffer(handle) {
 if (!buffers.has(handle)) {
 buffers.set(handle, []);
 }
 return buffers.get(handle);
}

/**
 * Return a copy of the inspector ring buffer for a given user handle. Used by
 * the debug-export endpoint to bundle every captured request — full
 * `fullMessages` / `responseText` / `wireRequest`, no truncation. Caller owns
 * the returned array (it's a shallow clone) but the entries themselves still
 * point at the live objects, so don't mutate them.
 *
 * @param {string} handle
 * @returns {object[]}
 */
export function getBufferForHandle(handle) {
 const h = String(handle || '');
 if (!h || !buffers.has(h)) return [];
 return buffers.get(h).slice();
}

function pushEntry(handle, entry) {
 const buf = getBuffer(handle);
 buf.push(entry);
 if (buf.length > RING_BUFFER_SIZE) {
 buf.shift();
 }
}

/**
 * Produce a redacted fingerprint of an API key suitable for the Inspector UI.
 * Plaintext keys never enter the ring buffer — only a prefix/suffix preview
 * plus the original length, so a user can tell which credential was used
 * without leaking it via JSON export or screenshots.
 *
 * @param {string} apiKey
 * @returns {string}
 */
export function fingerprintApiKey(apiKey) {
 const key = String(apiKey ?? '');
 if (!key) return '';
 const len = key.length;
 if (len <= 8) return `${'*'.repeat(len)} (${len} chars)`;
 return `${key.slice(0, 4)}...${key.slice(-4)} (${len} chars)`;
}

const REDACT_QUERY_KEYS = new Set(['key', 'api_key', 'apikey', 'access_token', 'token']);

function sanitizeEndpointUrl(endpoint) {
 const raw = String(endpoint || '');
 if (!raw) return '';
 try {
 const url = new URL(raw);
 for (const name of [...url.searchParams.keys()]) {
 if (REDACT_QUERY_KEYS.has(name.toLowerCase())) {
 url.searchParams.set(name, '***');
 }
 }
 return url.toString();
 } catch {
 return raw;
 }
}

/**
 * Attach the resolved upstream endpoint and a redacted key fingerprint to the
 * current inspection entry. Call this right before fetching the upstream
 * provider from any send*Request function.
 *
 * If `wirePayload` is provided, a deep-cloned snapshot of the outbound request
 * body is recorded as `entry.wireRequest` so the Inspector UI can show what
 * actually went on the wire after post-processing and provider-specific
 * conversion (e.g. Claude `system:` extraction). The `fullMessages` snapshot
 * captured by `startInspection` is the pre-conversion input; this snapshot is
 * the post-conversion output.
 *
 * @param {import('express').Request} request
 * @param {string|URL} endpoint Full URL that the server is about to hit
 * @param {string} apiKey Plaintext API key (never stored)
 * @param {object} [wirePayload] Optional outbound request body to snapshot.
 */
export function attachInspectionEndpoint(request, endpoint, apiKey, wirePayload) {
 const entry = findEntry(request);
 if (!entry) return;
 entry.endpoint = sanitizeEndpointUrl(endpoint);
 entry.apiKeyFingerprint = fingerprintApiKey(apiKey);
 if (wirePayload && typeof wirePayload === 'object') {
 try {
 entry.wireRequest = typeof structuredClone === 'function'
 ? structuredClone(wirePayload)
 : JSON.parse(JSON.stringify(wirePayload));
 } catch {
 try { entry.wireRequest = JSON.parse(JSON.stringify(wirePayload)); } catch { /* skip */ }
 }
 }
}

/**
 * Start tracking a generation request. Call at the top of /generate.
 * Attaches `request.__inspectorId` for later completion.
 * @param {import('express').Request} request
 */
export function startInspection(request) {
 const handle = String(request?.user?.profile?.handle || '');
 if (!handle) return;

 const body = request.body || {};
 const messages = Array.isArray(body.messages) ? body.messages : [];

 const entry = {
 id: randomUUID(),
 type: 'chat',
 handle,
 timestamp: Date.now(),
 source: String(body.chat_completion_source || body.api_type || 'unknown'),
 model: String(body.model || ''),
 stream: Boolean(body.stream),
 endpoint: '',
 apiKeyFingerprint: '',
 messageCount: messages.length,
 messageRoles: messages.map(m => String(m?.role || '?')),
 promptCharLength: messages.reduce((sum, m) => {
 const content = m?.content;
 if (typeof content === 'string') return sum + content.length;
 if (Array.isArray(content)) {
 return sum + content.reduce((s, part) => {
 if (typeof part === 'string') return s + part.length;
 if (part?.text) return s + String(part.text).length;
 if (part?.type === 'image_url' || part?.type === 'image') return s + 100;
 return s;
 }, 0);
 }
 return sum;
 }, 0),
 maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
 // Deep-clone snapshot of the messages array as the client posted it.
 // Downstream send paths mutate request.body.messages in place to fit
 // the upstream provider's schema, so a live reference would expose
 // post-mutation intermediate state at export time.
 fullMessages: (() => {
 try {
 return typeof structuredClone === 'function'
 ? structuredClone(messages)
 : JSON.parse(JSON.stringify(messages));
 } catch {
 return JSON.parse(JSON.stringify(messages));
 }
 })(),
 responseText: '',
 responseParts: [],
 usage: {
 prompt_tokens: null,
 completion_tokens: null,
 total_tokens: null,
 cache_read: null,
 cache_write: null,
 },
 durationMs: null,
 status: 'running',
 httpStatus: null,
 error: '',
 // Normalized OpenAI-shape stop reason (stop/length/tool_calls/content_filter/…).
 // For native providers we translate their vocabulary into OAI's on capture so
 // list-scan filters and cross-provider stats stay comparable. `null` = never
 // received (still running / failed before response / provider silent).
 finishReason: null,
 // Provider-original stop-reason string, verbatim, before any normalization.
 // Claude=`stop_reason` (end_turn/max_tokens/tool_use/…), Gemini=`finishReason`
 // (STOP/MAX_TOKENS/SAFETY/…), OpenRouter=`native_finish_reason` (upstream
 // provider's string when OR proxies e.g. Groq/Together). Kept separate from
 // `finishReason` because the raw value carries diagnostic info the OAI
 // vocabulary erases (e.g. Gemini SAFETY → OAI `content_filter` loses which
 // safety category tripped; Claude `pause_turn` has no OAI equivalent).
 nativeFinishReason: null,
 };

 pushEntry(handle, entry);
 request.__inspectorId = entry.id;
 request.__inspectorTimestamp = entry.timestamp;
}

/**
 * Find the entry for a request.
 * @param {import('express').Request} request
 * @returns {object|null}
 */
export function findEntry(request) {
 const handle = String(request?.user?.profile?.handle || '');
 const id = request?.__inspectorId;
 if (!handle || !id) return null;
 const buf = getBuffer(handle);
 for (let i = buf.length - 1; i >= 0; i--) {
 if (buf[i].id === id) return buf[i];
 }
 return null;
}

// ---- Usage extraction helpers ----

/**
 * SSE events come in two shapes depending on the caller:
 *   - inspector stream tap pushes plain strings (the SSE data line)
 *   - luker-generation jobs push { seq, data, ts } objects
 * Normalize to the string data line.
 */
function normalizeEvent(e) {
 if (typeof e === 'string') return e;
 if (e && typeof e.data === 'string') return e.data;
 return '';
}

function extractUsageFromOAI(payload) {
 const usage = payload?.usage;
 if (!usage || typeof usage !== 'object') return {};
 return {
 prompt_tokens: usage.prompt_tokens ?? null,
 completion_tokens: usage.completion_tokens ?? null,
 total_tokens: usage.total_tokens ?? null,
 cache_read: usage.prompt_tokens_details?.cached_tokens
 ?? usage.cache_read_input_tokens
 ?? usage.prompt_cache_hit_tokens
 ?? null,
 cache_write: usage.cache_creation_input_tokens
 ?? usage.prompt_cache_miss_tokens
 ?? null,
 };
}

function extractUsageFromClaude(payload) {
 const usage = payload?.usage;
 if (!usage || typeof usage !== 'object') return {};
 return {
 prompt_tokens: usage.input_tokens ?? null,
 completion_tokens: usage.output_tokens ?? null,
 total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) || null,
 cache_read: usage.cache_read_input_tokens ?? null,
 cache_write: usage.cache_creation_input_tokens ?? null,
 };
}

function extractUsageFromGemini(payload) {
 const meta = payload?.usageMetadata;
 if (!meta || typeof meta !== 'object') return {};
 return {
 prompt_tokens: meta.promptTokenCount ?? null,
 completion_tokens: meta.candidatesTokenCount ?? null,
 total_tokens: meta.totalTokenCount ?? null,
 cache_read: meta.cachedContentTokenCount ?? null,
 cache_write: null,
 };
}

// ---- Finish-reason extraction helpers ----

// Claude stop_reason → OAI finish_reason. Kept in sync with the mapping used
// on the response-normalization path (src/endpoints/backends/chat-completions.js
// CLAUDE_STOP_REASON_TO_OAI) so inspector-normalized values match what the
// client saw in `choices[0].finish_reason`. `pause_turn` and `refusal` have
// no OAI vocabulary equivalent; leave them null on the normalized field and
// rely on `nativeFinishReason` to carry the truth.
const CLAUDE_STOP_TO_OAI = {
 end_turn: 'stop',
 stop_sequence: 'stop',
 max_tokens: 'length',
 tool_use: 'tool_calls',
};

// Gemini candidates[0].finishReason → OAI. Mirrors
// GEMINI_FINISH_REASON_TO_OAI in the response normalizer. `OTHER`,
// `MALFORMED_FUNCTION_CALL`, and `IMAGE_*` variants deliberately fall
// through to null so the raw value is the sole source of truth for those.
const GEMINI_FINISH_TO_OAI = {
 STOP: 'stop',
 MAX_TOKENS: 'length',
 SAFETY: 'content_filter',
 RECITATION: 'content_filter',
 BLOCKLIST: 'content_filter',
 PROHIBITED_CONTENT: 'content_filter',
 SPII: 'content_filter',
 LANGUAGE: 'content_filter',
};

// Cohere finish_reason → OAI. Mirrors COHERE_FINISH_REASON_TO_OAI.
const COHERE_FINISH_TO_OAI = {
 COMPLETE: 'stop',
 STOP_SEQUENCE: 'stop',
 MAX_TOKENS: 'length',
 TOOL_CALL: 'tool_calls',
 ERROR: null,
};

/**
 * Pull finish/stop reason from a non-streaming response.
 * Returns `{ finishReason, nativeFinishReason }` — either or both may be null
 * when the provider didn't send one (rare) or the payload shape doesn't
 * match the source. `nativeFinishReason` is preserved verbatim (Gemini's
 * SAFETY casing matters; OpenRouter passes through arbitrary upstream tags).
 *
 * @param {object} payload OAI-normalized reply
 * @param {object} [rawApiResponse] provider-native body (Claude/Gemini/Cohere)
 * @param {string} source backend id from body.chat_completion_source
 * @returns {{finishReason: string|null, nativeFinishReason: string|null}}
 */
function extractFinishReasonFromPayload(payload, rawApiResponse, source) {
 let nativeFinishReason = null;
 let finishReason = null;

 if (source === 'claude' && rawApiResponse?.stop_reason) {
 nativeFinishReason = String(rawApiResponse.stop_reason);
 finishReason = CLAUDE_STOP_TO_OAI[nativeFinishReason] ?? null;
 } else if ((source === 'makersuite' || source === 'vertexai') && Array.isArray(rawApiResponse?.candidates)) {
 const raw = rawApiResponse.candidates[0]?.finishReason;
 if (raw) {
 nativeFinishReason = String(raw);
 finishReason = GEMINI_FINISH_TO_OAI[nativeFinishReason] ?? null;
 }
 } else if (source === 'cohere' && rawApiResponse?.finish_reason) {
 nativeFinishReason = String(rawApiResponse.finish_reason);
 finishReason = COHERE_FINISH_TO_OAI[nativeFinishReason] ?? null;
 }

 // Fall back / augment from the OAI-shaped choices array. This is the
 // primary path for OpenAI, DeepSeek, Mistral, xAI, AIMLAPI, OpenRouter,
 // Azure, MiniMax, Chutes, ElectronHub, AI21, and any other OAI-compatible
 // upstream that goes through the runner catch-all. OpenRouter also
 // surfaces `native_finish_reason` on the choice — that's the upstream
 // provider's original string (e.g. Groq's `length`, Together's `eos`),
 // which is exactly what "native" means here even though the runner didn't
 // see a separate raw body.
 const choice = payload?.choices?.[0];
 if (choice) {
 if (!finishReason && choice.finish_reason) {
 finishReason = String(choice.finish_reason);
 }
 if (!nativeFinishReason && choice.native_finish_reason) {
 nativeFinishReason = String(choice.native_finish_reason);
 } else if (!nativeFinishReason && choice.finish_reason) {
 // For plain-OAI providers, native == normalized. Copy so the UI
 // always has something to show when a reason exists at all.
 nativeFinishReason = String(choice.finish_reason);
 }
 }

 return { finishReason, nativeFinishReason };
}

/**
 * Pull finish reason from SSE events. Walks in reverse — the finish-carrying
 * frame is always at the tail of a well-formed stream (Claude message_delta,
 * Gemini final candidates chunk, OAI final delta with finish_reason set).
 *
 * @param {Array<string|{data:string}>} events
 * @param {string} source
 * @returns {{finishReason: string|null, nativeFinishReason: string|null}}
 */
export function extractFinishReasonFromStreamEvents(events, source) {
 if (!Array.isArray(events) || events.length === 0) {
 return { finishReason: null, nativeFinishReason: null };
 }

 for (let i = events.length - 1; i >= 0; i--) {
 const raw = normalizeEvent(events[i]);
 if (!raw || raw === '[DONE]') continue;

 let parsed;
 try { parsed = JSON.parse(raw); } catch { continue; }
 if (parsed?.luker) continue;

 if (source === 'claude') {
 // Anthropic streaming emits message_delta with the terminal
 // stop_reason once the model releases the turn. Nothing else on
 // the stream carries it.
 if (parsed?.type === 'message_delta' && parsed?.delta?.stop_reason) {
 const native = String(parsed.delta.stop_reason);
 return { finishReason: CLAUDE_STOP_TO_OAI[native] ?? null, nativeFinishReason: native };
 }
 continue;
 }

 if (source === 'makersuite' || source === 'vertexai') {
 const raw2 = parsed?.candidates?.[0]?.finishReason;
 if (raw2) {
 const native = String(raw2);
 return { finishReason: GEMINI_FINISH_TO_OAI[native] ?? null, nativeFinishReason: native };
 }
 continue;
 }

 // OpenAI / OpenAI-compatible. finish_reason on the choice (either
 // in delta or on the choice itself for providers that fold it in).
 // Also pick up OpenRouter's `native_finish_reason` when present.
 const choice = parsed?.choices?.[0];
 if (!choice) continue;
 const norm = choice.finish_reason ?? choice.delta?.finish_reason;
 const nat = choice.native_finish_reason ?? choice.delta?.native_finish_reason;
 if (norm || nat) {
 return {
 finishReason: norm ? String(norm) : null,
 nativeFinishReason: nat ? String(nat) : (norm ? String(norm) : null),
 };
 }
 }

 return { finishReason: null, nativeFinishReason: null };
}

/**
 * Extract usage from SSE stream events.
 * @param {string[]} events
 * @param {string} source
 * @returns {object}
 */
export function extractUsageFromStreamEvents(events, source) {
 if (!Array.isArray(events) || events.length === 0) return {};

 for (let i = events.length - 1; i >= 0; i--) {
 const raw = normalizeEvent(events[i]);
 if (!raw || raw === '[DONE]') continue;

 let parsed;
 try {
 parsed = JSON.parse(raw);
 } catch {
 continue;
 }

 if (parsed?.luker) continue;

 if (source === 'claude') {
 if (parsed?.type === 'message_delta' && parsed?.usage) {
 return extractUsageFromClaude({ usage: parsed.usage });
 }
 if (parsed?.type === 'message_start' && parsed?.message?.usage) {
 return extractUsageFromClaude({ usage: parsed.message.usage });
 }
 }

 if (source === 'makersuite' || source === 'vertexai') {
 if (parsed?.usageMetadata) {
 return extractUsageFromGemini(parsed);
 }
 }

 if (parsed?.usage) {
 return extractUsageFromOAI(parsed);
 }
 }

 return {};
}

/**
 * Extract response text from SSE stream events as a fallback when the caller
 * didn't accumulate text itself.
 * @param {string[]} events
 * @param {string} source
 * @returns {string}
 */
function extractTextFromStreamEvents(events, source) {
 if (!Array.isArray(events) || events.length === 0) return '';
 const out = [];
 for (const ev of events) {
 const raw = normalizeEvent(ev);
 if (!raw || raw === '[DONE]') continue;
 let parsed;
 try { parsed = JSON.parse(raw); } catch { continue; }
 if (parsed?.luker) continue;

 if (source === 'claude') {
 if (parsed?.type === 'content_block_delta' && parsed?.delta?.type === 'text_delta') {
 out.push(parsed.delta.text || '');
 }
 continue;
 }
 if (source === 'makersuite' || source === 'vertexai') {
 const parts = parsed?.candidates?.[0]?.content?.parts;
 if (Array.isArray(parts)) {
 for (const p of parts) if (typeof p?.text === 'string') out.push(p.text);
 }
 continue;
 }
 // OpenAI / generic
 const delta = parsed?.choices?.[0]?.delta?.content
 ?? parsed?.choices?.[0]?.text
 ?? parsed?.choices?.[0]?.message?.content;
 if (typeof delta === 'string') out.push(delta);
 else if (Array.isArray(delta)) {
 for (const p of delta) if (p?.type === 'text' && typeof p.text === 'string') out.push(p.text);
 }
 }
 return out.join('');
}

/**
 * Extract ordered response parts from SSE stream events.
 * Each part is either {type:'text', text} or
 * {type:'tool_call', id, name, args}.
 *
 * Handles three streaming dialects:
 *   - Claude: content_block_start / content_block_delta with index-keyed
 *     blocks of either text_delta or input_json_delta
 *   - Gemini: candidates[0].content.parts containing text or functionCall
 *   - OpenAI (and OpenAI-compatible): delta.content text + index-keyed
 *     delta.tool_calls increments whose function.arguments is appended as
 *     a JSON string
 */
function extractPartsFromStreamEvents(events, source) {
 if (!Array.isArray(events) || events.length === 0) return [];

 if (source === 'claude') {
 /** @type {Map<number, {type:string,text:string,name:string,id:string,inputJson:string,thinking:string,signature:string,data:string}>} */
 const blocks = new Map();
 const order = [];
 const ensureBlock = (idx) => {
 let b = blocks.get(idx);
 if (!b) {
 b = { type: 'text', text: '', name: '', id: '', inputJson: '', thinking: '', signature: '', data: '' };
 blocks.set(idx, b);
 order.push(idx);
 }
 return b;
 };
 for (const ev of events) {
 const raw = normalizeEvent(ev);
 if (!raw || raw === '[DONE]') continue;
 let parsed;
 try { parsed = JSON.parse(raw); } catch { continue; }
 if (parsed?.luker) continue;

 if (parsed?.type === 'content_block_start') {
 const idx = parsed.index ?? 0;
 const cb = parsed.content_block || {};
 const b = ensureBlock(idx);
 b.type = cb.type || 'text';
 if (cb.type === 'text' && typeof cb.text === 'string') b.text = cb.text;
 if (cb.type === 'thinking' && typeof cb.thinking === 'string') b.thinking = cb.thinking;
 if (cb.type === 'thinking' && typeof cb.signature === 'string') b.signature = cb.signature;
 if (cb.type === 'redacted_thinking' && typeof cb.data === 'string') b.data = cb.data;
 if (cb.name) b.name = cb.name;
 if (cb.id) b.id = cb.id;
 } else if (parsed?.type === 'content_block_delta') {
 const idx = parsed.index ?? 0;
 const b = ensureBlock(idx);
 const d = parsed.delta;
 if (d?.type === 'text_delta' && typeof d.text === 'string') b.text += d.text;
 else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') b.inputJson += d.partial_json;
 else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') b.thinking += d.thinking;
 else if (d?.type === 'signature_delta' && typeof d.signature === 'string') b.signature += d.signature;
 }
 }

 const parts = [];
 for (const idx of order) {
 const b = blocks.get(idx);
 if (!b) continue;
 if (b.type === 'text') {
 if (b.text) parts.push({ type: 'text', text: b.text });
 } else if (b.type === 'tool_use') {
 parts.push({ type: 'tool_call', id: b.id, name: b.name, args: coerceToolArgs(b.inputJson) });
 } else if (b.type === 'thinking') {
 parts.push({ type: 'reasoning', kind: 'thinking', text: b.thinking, signature: b.signature });
 } else if (b.type === 'redacted_thinking') {
 parts.push({ type: 'reasoning', kind: 'redacted_thinking', data: b.data });
 }
 }
 return parts;
 }

 if (source === 'makersuite' || source === 'vertexai') {
 const parts = [];
 let textAccum = '';
 const flushText = () => {
 if (textAccum) { parts.push({ type: 'text', text: textAccum }); textAccum = ''; }
 };
 for (const ev of events) {
 const raw = normalizeEvent(ev);
 if (!raw || raw === '[DONE]') continue;
 let parsed;
 try { parsed = JSON.parse(raw); } catch { continue; }
 if (parsed?.luker) continue;
 const geminiParts = parsed?.candidates?.[0]?.content?.parts;
 if (!Array.isArray(geminiParts)) continue;
 for (const p of geminiParts) {
 if (typeof p?.text === 'string') {
 textAccum += p.text;
 } else if (p?.functionCall) {
 flushText();
 parts.push({ type: 'tool_call', id: '', name: p.functionCall.name || '', args: p.functionCall.args ?? {} });
 }
 }
 }
 flushText();
 return parts;
 }

 // OpenAI / OpenAI-compatible
 let textAccum = '';
 let reasoningTextAccum = '';
 /** @type {Map<string, object>} keyed by detail.id (fallback ordinal); preserves reasoning_details entries */
 const reasoningDetails = new Map();
 const reasoningDetailsOrder = [];
 /** @type {Map<number, {id:string,name:string,argsStr:string}>} */
 const toolCalls = new Map();
 const toolOrder = [];
 const ensureToolCall = (idx) => {
 let t = toolCalls.get(idx);
 if (!t) {
 t = { id: '', name: '', argsStr: '' };
 toolCalls.set(idx, t);
 toolOrder.push(idx);
 }
 return t;
 };
 const ingestReasoningDetails = (arr) => {
 if (!Array.isArray(arr)) return;
 for (const detail of arr) {
 if (!detail || typeof detail !== 'object') continue;
 const key = detail.id != null ? String(detail.id) : `__ordinal_${reasoningDetailsOrder.length}`;
 if (!reasoningDetails.has(key)) {
 reasoningDetails.set(key, { ...detail });
 reasoningDetailsOrder.push(key);
 } else {
 // Streamed data payloads arrive fragmented across multiple deltas;
 // append instead of overwrite. Metadata fields (type/id/format/index)
 // are same-value across increments — last-write-wins is safe.
 const existing = reasoningDetails.get(key);
 for (const [k, v] of Object.entries(detail)) {
 if (k === 'data' && typeof v === 'string' && typeof existing.data === 'string') {
 existing.data = existing.data + v;
 } else {
 existing[k] = v;
 }
 }
 }
 }
 };
 for (const ev of events) {
 const raw = normalizeEvent(ev);
 if (!raw || raw === '[DONE]') continue;
 let parsed;
 try { parsed = JSON.parse(raw); } catch { continue; }
 if (parsed?.luker) continue;
 const delta = parsed?.choices?.[0]?.delta;
 if (!delta) continue;
 const content = delta.content;
 if (typeof content === 'string') textAccum += content;
 else if (Array.isArray(content)) {
 for (const p of content) if (p?.type === 'text' && typeof p.text === 'string') textAccum += p.text;
 }
 if (typeof delta.reasoning_content === 'string') reasoningTextAccum += delta.reasoning_content;
 if (typeof delta.reasoning === 'string') reasoningTextAccum += delta.reasoning;
 if (Array.isArray(delta.reasoning_details)) ingestReasoningDetails(delta.reasoning_details);
 if (Array.isArray(delta.tool_calls)) {
 for (const tc of delta.tool_calls) {
 const idx = tc?.index ?? 0;
 const t = ensureToolCall(idx);
 if (tc?.id) t.id = tc.id;
 if (tc?.function?.name) t.name = tc.function.name;
 if (typeof tc?.function?.arguments === 'string') t.argsStr += tc.function.arguments;
 }
 }
 }

 const parts = [];
 if (reasoningTextAccum) parts.push({ type: 'reasoning', kind: 'text', text: reasoningTextAccum });
 if (reasoningDetailsOrder.length) {
 parts.push({
 type: 'reasoning',
 kind: 'details',
 details: reasoningDetailsOrder.map(k => reasoningDetails.get(k)),
 });
 }
 if (textAccum) parts.push({ type: 'text', text: textAccum });
 for (const idx of toolOrder) {
 const t = toolCalls.get(idx);
 parts.push({ type: 'tool_call', id: t.id, name: t.name, args: coerceToolArgs(t.argsStr) });
 }
 return parts;
}

/**
 * Extract response text from a non-streaming payload.
 * @param {object} payload OpenAI-shaped payload (post-conversion in chat-completions)
 * @param {string} source backend identifier
 * @param {object} [rawApiResponse] native API response (pre-conversion), if available
 * @returns {string}
 */
function extractTextFromPayload(payload, source, rawApiResponse) {
 if (rawApiResponse) {
 if (source === 'claude' && Array.isArray(rawApiResponse.content)) {
 return rawApiResponse.content
 .filter(p => p?.type === 'text' && typeof p.text === 'string')
 .map(p => p.text)
 .join('');
 }
 if ((source === 'makersuite' || source === 'vertexai') && Array.isArray(rawApiResponse.candidates)) {
 const parts = rawApiResponse.candidates[0]?.content?.parts;
 if (Array.isArray(parts)) {
 return parts.filter(p => typeof p?.text === 'string').map(p => p.text).join('');
 }
 }
 }
 const choice = payload?.choices?.[0];
 const msgContent = choice?.message?.content ?? choice?.text;
 if (typeof msgContent === 'string') return msgContent;
 if (Array.isArray(msgContent)) {
 return msgContent
 .filter(p => p?.type === 'text' && typeof p.text === 'string')
 .map(p => p.text)
 .join('');
 }
 return '';
}

/**
 * Coerce a tool-call args field into a plain object (parsing JSON strings).
 * Falls back to the original value if parsing fails.
 */
function coerceToolArgs(raw) {
 if (raw == null) return {};
 if (typeof raw === 'string') {
 try { return JSON.parse(raw); } catch { return raw; }
 }
 return raw;
}

/**
 * Extract ordered response parts from a non-streaming payload.
 * Each part is either {type:'text', text} or
 * {type:'tool_call', id, name, args}.
 */
function extractPartsFromPayload(payload, source, rawApiResponse) {
 const parts = [];

 if (rawApiResponse) {
 if (source === 'claude' && Array.isArray(rawApiResponse.content)) {
 for (const p of rawApiResponse.content) {
 if (p?.type === 'text' && typeof p.text === 'string') {
 if (p.text) parts.push({ type: 'text', text: p.text });
 } else if (p?.type === 'tool_use') {
 parts.push({ type: 'tool_call', id: p.id || '', name: p.name || '', args: p.input ?? {} });
 } else if (p?.type === 'thinking') {
 parts.push({
 type: 'reasoning',
 kind: 'thinking',
 text: typeof p.thinking === 'string' ? p.thinking : '',
 signature: typeof p.signature === 'string' ? p.signature : '',
 });
 } else if (p?.type === 'redacted_thinking') {
 parts.push({
 type: 'reasoning',
 kind: 'redacted_thinking',
 data: typeof p.data === 'string' ? p.data : '',
 });
 }
 }
 return parts;
 }
 if ((source === 'makersuite' || source === 'vertexai') && Array.isArray(rawApiResponse.candidates)) {
 const geminiParts = rawApiResponse.candidates[0]?.content?.parts;
 if (Array.isArray(geminiParts)) {
 for (const p of geminiParts) {
 if (typeof p?.text === 'string') {
 if (p.text) parts.push({ type: 'text', text: p.text });
 } else if (p?.functionCall) {
 parts.push({ type: 'tool_call', id: '', name: p.functionCall.name || '', args: p.functionCall.args ?? {} });
 }
 }
 return parts;
 }
 }
 }

 const choice = payload?.choices?.[0];
 if (choice) {
 const msg = choice?.message || {};
 if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
 parts.push({ type: 'reasoning', kind: 'text', text: msg.reasoning_content });
 } else if (typeof msg.reasoning === 'string' && msg.reasoning) {
 parts.push({ type: 'reasoning', kind: 'text', text: msg.reasoning });
 }
 if (Array.isArray(msg.reasoning_details) && msg.reasoning_details.length) {
 parts.push({ type: 'reasoning', kind: 'details', details: msg.reasoning_details });
 }
 if (Array.isArray(msg.reasoning_blocks) && msg.reasoning_blocks.length) {
 for (const b of msg.reasoning_blocks) {
 if (b?.type === 'thinking') {
 parts.push({
 type: 'reasoning',
 kind: 'thinking',
 text: typeof b.thinking === 'string' ? b.thinking : '',
 signature: typeof b.signature === 'string' ? b.signature : '',
 });
 } else if (b?.type === 'redacted_thinking') {
 parts.push({
 type: 'reasoning',
 kind: 'redacted_thinking',
 data: typeof b.data === 'string' ? b.data : '',
 });
 }
 }
 }
 const msgContent = msg.content ?? choice?.text;
 if (typeof msgContent === 'string' && msgContent) {
 parts.push({ type: 'text', text: msgContent });
 } else if (Array.isArray(msgContent)) {
 for (const p of msgContent) {
 if (p?.type === 'text' && typeof p.text === 'string' && p.text) {
 parts.push({ type: 'text', text: p.text });
 }
 }
 }
 const tcs = msg.tool_calls;
 if (Array.isArray(tcs)) {
 for (const tc of tcs) {
 parts.push({
 type: 'tool_call',
 id: tc?.id || '',
 name: tc?.function?.name || tc?.name || '',
 args: coerceToolArgs(tc?.function?.arguments ?? tc?.arguments),
 });
 }
 }
 const fc = msg.function_call;
 if (fc) {
 parts.push({ type: 'tool_call', id: '', name: fc.name || '', args: coerceToolArgs(fc.arguments) });
 }
 }
 return parts;
}

/**
 * Complete an inspection with success + usage data from a non-streaming response.
 * @param {import('express').Request} request
 * @param {object} payload
 * @param {object} [rawApiResponse]
 */
export function completeInspection(request, payload, rawApiResponse) {
 const entry = findEntry(request);
 if (!entry) return;

 entry.status = 'success';
 entry.durationMs = Date.now() - entry.timestamp;
 entry.httpStatus = 200;

 const source = entry.source;
 let usage = {};

 if (rawApiResponse) {
 if (source === 'claude') {
 usage = extractUsageFromClaude(rawApiResponse);
 } else if (source === 'makersuite' || source === 'vertexai') {
 usage = extractUsageFromGemini(rawApiResponse);
 }
 }

 if (!usage.prompt_tokens) {
 const oaiUsage = extractUsageFromOAI(payload);
 if (oaiUsage.prompt_tokens) {
 usage = oaiUsage;
 }
 }

 Object.assign(entry.usage, usage);
 entry.responseText = extractTextFromPayload(payload, source, rawApiResponse);
 entry.responseParts = extractPartsFromPayload(payload, source, rawApiResponse);

 const fr = extractFinishReasonFromPayload(payload, rawApiResponse, source);
 entry.finishReason = fr.finishReason;
 entry.nativeFinishReason = fr.nativeFinishReason;
}

/**
 * Complete an inspection from streaming events.
 * @param {import('express').Request} request
 * @param {string[]} events
 * @param {string} [accumulatedText] caller-side accumulated text (preferred over re-parsing events)
 */
export function completeInspectionFromStream(request, events, accumulatedText) {
 const entry = findEntry(request);
 if (!entry) return;

 entry.status = 'success';
 entry.durationMs = Date.now() - entry.timestamp;
 entry.httpStatus = 200;

 const usage = extractUsageFromStreamEvents(events, entry.source);
 Object.assign(entry.usage, usage);

 entry.responseParts = extractPartsFromStreamEvents(events, entry.source);

 if (typeof accumulatedText === 'string' && accumulatedText.length) {
 entry.responseText = accumulatedText;
 } else {
 entry.responseText = entry.responseParts
 .filter(p => p.type === 'text')
 .map(p => p.text)
 .join('') || extractTextFromStreamEvents(events, entry.source);
 }

 const fr = extractFinishReasonFromStreamEvents(events, entry.source);
 entry.finishReason = fr.finishReason;
 entry.nativeFinishReason = fr.nativeFinishReason;
}

/**
 * Mark an inspection as failed.
 * @param {import('express').Request} request
 * @param {string} errorMessage
 * @param {number} [httpStatus]
 */
export function failInspection(request, errorMessage, httpStatus) {
 const entry = findEntry(request);
 if (!entry) return;

 entry.status = 'error';
 entry.durationMs = Date.now() - entry.timestamp;
 entry.httpStatus = httpStatus ?? null;
 entry.error = String(errorMessage || 'Unknown error');
}

/**
 * Mark an inspection as aborted.
 * @param {import('express').Request} request
 */
export function abortInspection(request) {
 const entry = findEntry(request);
 if (!entry) return;
 if (entry.status !== 'running') return;

 entry.status = 'aborted';
 entry.durationMs = Date.now() - entry.timestamp;
}

// ---- ComfyUI Workflow Parsing ----

/**
 * Best-effort extraction of generation parameters from a ComfyUI workflow JSON.
 * @param {string|object} promptData - The workflow (body.prompt is a JSON string)
 * @returns {object}
 */
function parseComfyWorkflow(promptData) {
    const result = { prompt: '', negativePrompt: '', model: '', width: null, height: null, steps: null, cfgScale: null, seed: null, sampler: null };
    let workflow;
    try {
        workflow = typeof promptData === 'string' ? JSON.parse(promptData) : promptData;
    } catch {
        return result;
    }
    if (!workflow || typeof workflow !== 'object') return result;

    const nodes = Object.values(workflow);
    for (const node of nodes) {
        const cls = node?.class_type;
        const inputs = node?.inputs;
        if (!cls || !inputs) continue;

        if (cls === 'KSampler' || cls === 'KSamplerAdvanced') {
            result.steps = inputs.steps ?? result.steps;
            result.cfgScale = inputs.cfg ?? result.cfgScale;
            result.seed = inputs.seed ?? inputs.noise_seed ?? result.seed;
            result.sampler = inputs.sampler_name ?? result.sampler;
        } else if (cls === 'CLIPTextEncode') {
            const text = typeof inputs.text === 'string' ? inputs.text : '';
            // Heuristic: shorter CLIP texts or ones with "negative" in node title are negative prompts
            if (!result.prompt) {
                result.prompt = text;
            } else if (!result.negativePrompt && text.length < result.prompt.length) {
                result.negativePrompt = text;
            }
        } else if (cls === 'CheckpointLoaderSimple' || cls === 'CheckpointLoader') {
            result.model = inputs.ckpt_name ?? result.model;
        } else if (cls === 'EmptyLatentImage') {
            result.width = inputs.width ?? result.width;
            result.height = inputs.height ?? result.height;
        }
    }
    return result;
}

// ---- Image Inspection ----

/**
 * Extract normalized image generation metadata from various backend request bodies.
 * @param {string} source - Backend identifier
 * @param {object} body - request.body
 * @returns {object} Normalized meta
 */
export function extractImageMeta(source, body) {
    const meta = {
        source,
        prompt: '',
        negativePrompt: '',
        model: '',
        width: null,
        height: null,
        steps: null,
        cfgScale: null,
        seed: null,
        sampler: null,
    };

    switch (source) {
        case 'comfyui':
        case 'comfyui_runpod': {
            const parsed = parseComfyWorkflow(body.prompt);
            Object.assign(meta, parsed);
            break;
        }
        case 'sd_webui':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.override_settings?.sd_model_checkpoint || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.cfg_scale ?? null;
            meta.seed = body.seed ?? null;
            meta.sampler = body.sampler_name || null;
            break;
        case 'sd_cpp':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.cfg_scale ?? null;
            meta.seed = body.seed ?? null;
            meta.sampler = body.sampler_name || null;
            break;
        case 'drawthings':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.cfg_scale ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'together':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'pollinations':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'stability':
            meta.prompt = body.payload?.prompt || '';
            meta.model = body.model || '';
            meta.seed = body.payload?.seed ?? null;
            break;
        case 'electronhub': {
            meta.prompt = body.prompt || '';
            meta.model = body.model || '';
            if (typeof body.size === 'string' && body.size.includes('x')) {
                const [w, h] = body.size.split('x').map(Number);
                if (w && h) { meta.width = w; meta.height = h; }
            }
            break;
        }
        case 'chutes':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.guidance ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'bfl':
            meta.prompt = body.prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.guidance ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'falai':
            meta.prompt = body.prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.guidance ?? null;
            meta.seed = body.seed ?? null;
            break;
        default:
            // huggingface, nanogpt, xai, and any future backends
            meta.prompt = body.prompt || body.inputs || '';
            meta.model = body.model || '';
            break;
    }

    return meta;
}

/**
 * Start tracking an image generation request.
 * @param {import('express').Request} request
 * @param {object} meta - from extractImageMeta()
 */
export function startImageInspection(request, meta) {
    const handle = String(request?.user?.profile?.handle || '');
    if (!handle) return;

    const entry = {
        id: randomUUID(),
        type: 'image',
        handle,
        timestamp: Date.now(),
        source: String(meta.source || 'unknown'),
        prompt: String(meta.prompt || ''),
        negativePrompt: String(meta.negativePrompt || ''),
        model: String(meta.model || ''),
        endpoint: '',
        apiKeyFingerprint: '',
        width: meta.width ?? null,
        height: meta.height ?? null,
        steps: meta.steps ?? null,
        cfgScale: meta.cfgScale ?? null,
        seed: meta.seed ?? null,
        sampler: meta.sampler || null,
        durationMs: null,
        status: 'running',
        httpStatus: null,
        error: '',
        outputFormat: null,
        outputSizeBytes: null,
    };

    pushEntry(handle, entry);
    request.__inspectorId = entry.id;
    request.__inspectorTimestamp = entry.timestamp;
}

/**
 * Complete an image inspection with success.
 * @param {import('express').Request} request
 * @param {object} [resultMeta] - { format, sizeBytes }
 */
export function completeImageInspection(request, resultMeta) {
    const entry = findEntry(request);
    if (!entry) return;

    entry.status = 'success';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = 200;
    if (resultMeta) {
        entry.outputFormat = resultMeta.format || null;
        entry.outputSizeBytes = resultMeta.sizeBytes ?? null;
    }
}

/**
 * Mark an image inspection as failed.
 * @param {import('express').Request} request
 * @param {string} errorMessage
 * @param {number} [httpStatus]
 */
export function failImageInspection(request, errorMessage, httpStatus) {
    const entry = findEntry(request);
    if (!entry) return;

    entry.status = 'error';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = httpStatus ?? null;
    entry.error = String(errorMessage || 'Unknown error');
}

// ---- Embedding / Rerank Inspection ----

/**
 * Deep-clone a text list into per-item records suitable for `inputTexts`.
 * Inspector never truncates AI-facing content (matches how chat `fullMessages`
 * and `wireRequest` snapshots preserve the entire request verbatim), so this
 * intentionally keeps the full string. Ring-buffer growth is bounded by
 * `RING_BUFFER_SIZE` at the entry level — see the top of this file.
 *
 * @param {string[]} texts
 * @returns {{index:number, text:string}[]}
 */
function snapshotTexts(texts) {
    if (!Array.isArray(texts)) return [];
    return texts.map((t, i) => ({ index: i, text: String(t ?? '') }));
}

/**
 * Extract normalized embedding / rerank metadata from a vectors router body
 * or the kobold /embed body. `routeKind` disambiguates the body shape:
 *   - 'insert' / 'query' / 'query-multi' / 'rerank': /api/vector/* bodies
 *   - 'kobold-embed': /api/backends/kobold/embed body
 *
 * @param {string} routeKind
 * @param {object} body
 * @returns {object}
 */
export function extractEmbeddingMeta(routeKind, body = {}) {
    const meta = {
        routeKind,
        operation: routeKind === 'rerank' ? 'rerank' : 'embed',
        source: '',
        model: '',
        collectionId: null,
        collectionIds: null,
        inputCount: 0,
        inputCharTotal: 0,
        inputTexts: [],
        query: '',
        topK: null,
        threshold: null,
    };

    switch (routeKind) {
        case 'insert': {
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            meta.collectionId = body.collectionId != null ? String(body.collectionId) : null;
            const items = Array.isArray(body.items) ? body.items : [];
            const texts = items.map(it => String(it?.text ?? ''));
            meta.inputCount = texts.length;
            meta.inputCharTotal = texts.reduce((s, t) => s + t.length, 0);
            meta.inputTexts = snapshotTexts(texts);
            break;
        }
        case 'query': {
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            meta.collectionId = body.collectionId != null ? String(body.collectionId) : null;
            const searchText = String(body.searchText ?? '');
            meta.inputCount = 1;
            meta.inputCharTotal = searchText.length;
            meta.inputTexts = snapshotTexts([searchText]);
            meta.topK = Number(body.topK) || null;
            meta.threshold = Number(body.threshold) || 0;
            break;
        }
        case 'query-multi': {
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            meta.collectionIds = Array.isArray(body.collectionIds)
                ? body.collectionIds.map(String)
                : null;
            const searchText = String(body.searchText ?? '');
            meta.inputCount = 1;
            meta.inputCharTotal = searchText.length;
            meta.inputTexts = snapshotTexts([searchText]);
            meta.topK = Number(body.topK) || null;
            meta.threshold = Number(body.threshold) || 0;
            break;
        }
        case 'rerank': {
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            meta.query = String(body.query ?? '');
            const documents = Array.isArray(body.documents) ? body.documents : [];
            const docTexts = documents.map(d => (typeof d === 'string' ? d : String(d?.text ?? '')));
            meta.inputCount = docTexts.length;
            meta.inputCharTotal = docTexts.reduce((s, t) => s + t.length, 0);
            meta.inputTexts = snapshotTexts(docTexts);
            meta.topK = Number(body.topK) || null;
            break;
        }
        case 'kobold-embed': {
            meta.source = 'koboldcpp';
            meta.model = '';
            const items = Array.isArray(body.items) ? body.items.map(String) : [];
            meta.inputCount = items.length;
            meta.inputCharTotal = items.reduce((s, t) => s + t.length, 0);
            meta.inputTexts = snapshotTexts(items);
            break;
        }
        default:
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            break;
    }

    return meta;
}

/**
 * Start tracking an embedding / rerank request. Attaches
 * `request.__inspectorId` so provider layers can call
 * `attachInspectionEndpoint` before their upstream `fetch`.
 *
 * @param {import('express').Request} request
 * @param {object} meta from extractEmbeddingMeta()
 */
export function startEmbeddingInspection(request, meta) {
    const handle = String(request?.user?.profile?.handle || '');
    if (!handle) return;

    const entry = {
        id: randomUUID(),
        type: 'embedding',
        handle,
        timestamp: Date.now(),
        source: String(meta.source || 'unknown'),
        operation: meta.operation === 'rerank' ? 'rerank' : 'embed',
        routeKind: String(meta.routeKind || ''),
        model: String(meta.model || ''),
        endpoint: '',
        apiKeyFingerprint: '',
        collectionId: meta.collectionId ?? null,
        collectionIds: Array.isArray(meta.collectionIds) ? meta.collectionIds.slice() : null,
        inputCount: Number.isFinite(meta.inputCount) ? meta.inputCount : 0,
        inputCharTotal: Number.isFinite(meta.inputCharTotal) ? meta.inputCharTotal : 0,
        inputTexts: Array.isArray(meta.inputTexts) ? meta.inputTexts : [],
        query: String(meta.query || ''),
        topK: meta.topK ?? null,
        threshold: meta.threshold ?? null,
        wireRequest: null,
        durationMs: null,
        status: 'running',
        httpStatus: null,
        error: '',
        resultCount: null,
        vectorDim: null,
        hits: null,
    };

    pushEntry(handle, entry);
    request.__inspectorId = entry.id;
    request.__inspectorTimestamp = entry.timestamp;
}

/**
 * Complete an embedding / rerank inspection with success.
 *
 * `resultMeta` fields (all optional):
 *   - `resultCount` — number of vectors / hits / reranked docs returned
 *   - `vectorDim`   — dimensionality of the first returned vector (embed only)
 *   - `hits`        — full list of returned hits (query / rerank);
 *                     [{hash, score, text}], never truncated
 *
 * @param {import('express').Request} request
 * @param {object} [resultMeta]
 */
export function completeEmbeddingInspection(request, resultMeta) {
    const entry = findEntry(request);
    if (!entry) return;

    entry.status = 'success';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = 200;
    if (resultMeta) {
        if (Number.isFinite(resultMeta.resultCount)) entry.resultCount = resultMeta.resultCount;
        if (Number.isFinite(resultMeta.vectorDim)) entry.vectorDim = resultMeta.vectorDim;
        if (Array.isArray(resultMeta.hits)) entry.hits = resultMeta.hits;
    }
}

/**
 * Mark an embedding / rerank inspection as failed.
 * @param {import('express').Request} request
 * @param {string} errorMessage
 * @param {number} [httpStatus]
 */
export function failEmbeddingInspection(request, errorMessage, httpStatus) {
    const entry = findEntry(request);
    if (!entry) return;

    entry.status = 'error';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = httpStatus ?? null;
    entry.error = String(errorMessage || 'Unknown error');
}

// ---- Express Router ----

export const router = express.Router();

function buildSearchSnippet(entry) {
 if (entry.type === 'image') {
 return [entry.source, entry.model, entry.prompt, entry.negativePrompt, entry.error].filter(Boolean).join(' ');
 }
 if (entry.type === 'embedding') {
 const inputText = Array.isArray(entry.inputTexts)
 ? entry.inputTexts.map(s => s?.text || '').join(' ')
 : '';
 const hitsText = Array.isArray(entry.hits)
 ? entry.hits.map(h => String(h?.text ?? '')).join(' ')
 : '';
 const combined = [
 entry.source,
 entry.model,
 entry.operation,
 entry.collectionId,
 Array.isArray(entry.collectionIds) ? entry.collectionIds.join(' ') : '',
 entry.query,
 inputText,
 hitsText,
 entry.error,
 ].filter(Boolean).join(' ');
 return combined.length > 8192 ? combined.slice(0, 8192) : combined;
 }
 const messageText = Array.isArray(entry.fullMessages)
 ? entry.fullMessages.map(m => {
 const c = m?.content;
 if (typeof c === 'string') return c;
 if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join(' ');
 return '';
 }).join(' ')
 : '';
 const combined = [entry.source, entry.model, entry.error, messageText, entry.responseText || ''].filter(Boolean).join(' ');
 return combined.length > 8192 ? combined.slice(0, 8192) : combined;
}

router.get('/list', (req, res) => {
 const handle = String(req?.user?.profile?.handle || '');
 if (!handle) return res.status(401).send({ error: 'Unauthorized' });

 const buf = getBuffer(handle);
 const summaries = buf.map(e => {
 const base = {
 id: e.id,
 type: e.type || 'chat',
 timestamp: e.timestamp,
 source: e.source,
 model: e.model,
 durationMs: e.durationMs,
 status: e.status,
 httpStatus: e.httpStatus,
 error: e.error,
 searchText: buildSearchSnippet(e),
 };
 if (e.type === 'image') {
 base.prompt = (e.prompt || '').slice(0, 80);
 base.width = e.width;
 base.height = e.height;
 base.outputFormat = e.outputFormat;
 base.outputSizeBytes = e.outputSizeBytes;
 } else if (e.type === 'embedding') {
 base.operation = e.operation;
 base.routeKind = e.routeKind;
 base.collectionId = e.collectionId;
 base.inputCount = e.inputCount;
 base.inputCharTotal = e.inputCharTotal;
 base.query = (e.query || '').slice(0, 80);
 base.topK = e.topK;
 base.resultCount = e.resultCount;
 base.vectorDim = e.vectorDim;
 } else {
 base.stream = e.stream;
 base.messageCount = e.messageCount;
 base.promptCharLength = e.promptCharLength;
 base.maxTokens = e.maxTokens;
 base.usage = e.usage;
 base.responseChars = (e.responseText || '').length;
 }
 return base;
 });

 summaries.reverse();
 return res.json(summaries);
});

router.get('/:id', (req, res) => {
 const handle = String(req?.user?.profile?.handle || '');
 if (!handle) return res.status(401).send({ error: 'Unauthorized' });

 const buf = getBuffer(handle);
 const entry = buf.find(e => e.id === req.params.id);
 if (!entry) return res.status(404).send({ error: 'Not found' });

 return res.json(entry);
});

router.get('/:id/export', (req, res) => {
 const handle = String(req?.user?.profile?.handle || '');
 if (!handle) return res.status(401).send({ error: 'Unauthorized' });

 const buf = getBuffer(handle);
 const entry = buf.find(e => e.id === req.params.id);
 if (!entry) return res.status(404).send({ error: 'Not found' });

 // Re-compute schema snapshot at export time so caller can compare with
 // `messageSchemaAtCapture`. If the two disagree, something downstream
 // mutated `body.messages` in place after `startInspection`.
 const exportMessages = Array.isArray(entry.fullMessages) ? entry.fullMessages : [];
 const messageSchemaAtExport = exportMessages.map(m => {
 const content = m?.content;
 const ctype = typeof content === 'string'
 ? 'string'
 : (Array.isArray(content) ? 'array' : (content === null ? 'null' : typeof content));
 let clen = 0;
 let chead = '';
 if (typeof content === 'string') {
 clen = content.length;
 chead = content.slice(0, 60);
 } else if (Array.isArray(content)) {
 clen = content.reduce((s, p) => {
 if (typeof p === 'string') return s + p.length;
 if (p && typeof p.text === 'string') return s + p.text.length;
 return s;
 }, 0);
 chead = content.map(p => (typeof p === 'string' ? p : (p?.text || `<${p?.type || '?'}>`))).join('|').slice(0, 60);
 } else if (content !== null && content !== undefined) {
 try { chead = JSON.stringify(content).slice(0, 60); clen = chead.length; } catch { /* ignore */ }
 }
 return {
 role: String(m?.role || ''),
 contentType: ctype,
 contentLen: clen,
 contentHead: chead,
 hasToolCalls: Array.isArray(m?.tool_calls) && m.tool_calls.length > 0,
 toolCallId: m?.tool_call_id ? String(m.tool_call_id).slice(0, 24) : '',
 };
 });

 const filename = `request-${entry.id.slice(0, 8)}-${entry.timestamp}.json`;
 res.setHeader('Content-Type', 'application/json');
 res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
 return res.send(JSON.stringify({ ...entry, messageSchemaAtExport }, null, 2));
});
