/**
 * Request Inspector — DevTools-like Network panel for generation requests.
 * Shows per-user request history with timing, token usage, and full message export.
 * Supports both chat (LLM) and image generation requests.
 */

import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';

const MODULE_NAME = 'RequestInspector';
let cachedList = [];
let cachedDetail = null;
let currentDetailId = null;
let currentFilter = 'all'; // 'all' | 'chat' | 'image'
let currentSearch = '';
let currentDetailSearch = '';

function formatTimestamp(ts) {
 const d = new Date(ts);
 return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms) {
 if (ms == null) return '\u2014';
 if (ms < 1000) return `${ms}ms`;
 return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n) {
 if (n == null) return '\u2014';
 if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
 return String(n);
}

function formatBytes(n) {
 if (n == null) return '\u2014';
 if (n < 1024) return `${n}B`;
 if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
 return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function statusIcon(status) {
 switch (status) {
 case 'success': return '<span class="ri-status ri-success">\u2713</span>';
 case 'error': return '<span class="ri-status ri-error">\u2717</span>';
 case 'aborted': return '<span class="ri-status ri-aborted">\u2298</span>';
 case 'running': return '<span class="ri-status ri-running">\u27F3</span>';
 default: return '<span class="ri-status">?</span>';
 }
}

function typeIcon(type) {
 return type === 'image'
 ? '<span class="ri-type-badge ri-type-image" title="Image">\uD83C\uDFA8</span>'
 : '<span class="ri-type-badge ri-type-chat" title="Chat">\uD83D\uDCAC</span>';
}

function escapeHtml(str) {
 const div = document.createElement('div');
 div.textContent = str;
 return div.innerHTML;
}

function escapeRegex(s) {
 return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape HTML then highlight substring matches of `query` (case-insensitive)
 * by wrapping them in <mark class="ri-hl">. Query is also escaped to avoid
 * mismatching entities introduced by escapeHtml.
 */
function highlightHtml(text, query) {
 const safe = escapeHtml(text);
 const q = (query || '').trim();
 if (!q) return safe;
 const safeQ = escapeHtml(q);
 if (!safeQ) return safe;
 const re = new RegExp(escapeRegex(safeQ), 'gi');
 return safe.replace(re, m => `<mark class="ri-hl">${m}</mark>`);
}

function formatToolCallArgs(rawArgs) {
 if (typeof rawArgs === 'string') {
 try { return JSON.stringify(JSON.parse(rawArgs), null, 2); }
 catch { return rawArgs; }
 }
 return JSON.stringify(rawArgs ?? {}, null, 2);
}

function formatMessage(msg) {
 const sections = [];

 if (msg?.role === 'tool' && msg?.tool_call_id) {
 sections.push(`[tool_result: ${msg.tool_call_id}]`);
 }

 const content = formatMessageContent(msg?.content);
 if (content) sections.push(content);

 if (Array.isArray(msg?.tool_calls)) {
 for (const tc of msg.tool_calls) {
 const name = tc?.function?.name || tc?.name || '?';
 const id = tc?.id || '';
 const args = formatToolCallArgs(tc?.function?.arguments ?? tc?.arguments);
 sections.push(`[tool_call: ${name} (id=${id})]\n${args}`);
 }
 }

 if (msg?.function_call) {
 const fc = msg.function_call;
 const name = fc?.name || '?';
 const args = formatToolCallArgs(fc?.arguments);
 sections.push(`[function_call: ${name}]\n${args}`);
 }

 return sections.join('\n\n');
}

/**
 * Collect reasoning artifacts (thinking blocks, encrypted signatures, plain
 * reasoning text) attached to a message across every provider dialect Luker
 * touches. Returns a flat ordered list so the UI can render each item with a
 * dedicated block style, replacing the raw-JSON fallback for opaque payloads.
 *
 * Supported inputs:
 *   - Claude request side: assistant `content` array containing
 *     `{type:'thinking',thinking,signature}` / `{type:'redacted_thinking',data}`
 *   - Server-normalized OpenAI-shape: `message.reasoning_content` /
 *     `message.reasoning` (plain text) and `message.reasoning_blocks`
 *     (Anthropic-native array) and `message.reasoning_details` (OpenRouter
 *     opaque encrypted array). Top-level `message.signature` is captured too.
 */
function extractMessageReasoning(msg) {
 const items = [];
 if (msg && typeof msg === 'object') {
 if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
 items.push({ kind: 'text', text: msg.reasoning_content, source: 'reasoning_content' });
 }
 if (typeof msg.reasoning === 'string' && msg.reasoning) {
 items.push({ kind: 'text', text: msg.reasoning, source: 'reasoning' });
 }
 if (Array.isArray(msg.reasoning_blocks)) {
 for (const b of msg.reasoning_blocks) {
 if (b?.type === 'thinking') {
 items.push({ kind: 'thinking', text: b.thinking || '', signature: b.signature || '', source: 'reasoning_blocks' });
 } else if (b?.type === 'redacted_thinking') {
 items.push({ kind: 'redacted_thinking', data: b.data || '', source: 'reasoning_blocks' });
 }
 }
 }
 if (Array.isArray(msg.reasoning_details) && msg.reasoning_details.length) {
 items.push({ kind: 'details', details: msg.reasoning_details, source: 'reasoning_details' });
 }
 if (typeof msg.signature === 'string' && msg.signature) {
 items.push({ kind: 'signature', signature: msg.signature, source: 'signature' });
 }
 if (Array.isArray(msg.content)) {
 for (const p of msg.content) {
 if (p?.type === 'thinking') {
 items.push({ kind: 'thinking', text: p.thinking || '', signature: p.signature || '', source: 'content_block' });
 } else if (p?.type === 'redacted_thinking') {
 items.push({ kind: 'redacted_thinking', data: p.data || '', source: 'content_block' });
 }
 }
 }
 }
 return items;
}

/**
 * Render a single reasoning artifact into the Inspector's styled block.
 * Kept consistent with tool_call rendering: badge header + monospace body,
 * folded inside a <details> so long payloads don't dominate the panel.
 */
function renderReasoningItem(item, q) {
 if (!item) return '';
 const kind = String(item.kind || '');
 let badge = t`Reasoning`;
 let bodyHtml = '';
 let extraMeta = '';

 if (kind === 'thinking') {
 badge = t`Thinking`;
 const textPart = item.text
 ? `<pre class="ri-reasoning-body">${highlightHtml(item.text, q)}</pre>`
 : `<div class="ri-reasoning-empty">${escapeHtml(t`(empty thinking body)`)}</div>`;
 const sigPart = item.signature
 ? `<div class="ri-reasoning-sig-row"><span class="ri-reasoning-sig-label">${escapeHtml(t`Signature`)}</span><code class="ri-reasoning-sig">${escapeHtml(item.signature)}</code></div>`
 : '';
 bodyHtml = textPart + sigPart;
 } else if (kind === 'redacted_thinking') {
 badge = t`Redacted Thinking`;
 bodyHtml = `<div class="ri-reasoning-sig-row"><span class="ri-reasoning-sig-label">${escapeHtml(t`Data`)}</span><code class="ri-reasoning-sig">${escapeHtml(item.data || '')}</code></div>`;
 } else if (kind === 'text') {
 badge = t`Reasoning`;
 if (item.source === 'reasoning_content') extraMeta = 'reasoning_content';
 else if (item.source === 'reasoning') extraMeta = 'reasoning';
 bodyHtml = `<pre class="ri-reasoning-body">${highlightHtml(item.text || '', q)}</pre>`;
 } else if (kind === 'details') {
 badge = t`Reasoning Details`;
 extraMeta = `${item.details?.length || 0} entries`;
 const rows = [];
 for (const d of (item.details || [])) {
 const type = d?.type || '?';
 const id = d?.id ? `<span class="ri-tool-call-id" title="${escapeHtml(d.id)}">${escapeHtml(d.id)}</span>` : '';
 const format = d?.format ? `<span class="ri-reasoning-detail-format">${escapeHtml(d.format)}</span>` : '';
 const data = typeof d?.data === 'string' ? d.data : '';
 const dataRow = data ? `<code class="ri-reasoning-sig">${escapeHtml(data)}</code>` : '';
 rows.push(`
 <div class="ri-reasoning-detail-row">
 <div class="ri-reasoning-detail-header">
 <span class="ri-reasoning-detail-type">${escapeHtml(type)}</span>
 ${format}
 ${id}
 </div>
 ${dataRow}
 </div>`);
 }
 bodyHtml = rows.join('\n') || `<div class="ri-reasoning-empty">${escapeHtml(t`(no entries)`)}</div>`;
 } else if (kind === 'signature') {
 badge = t`Signature`;
 bodyHtml = `<div class="ri-reasoning-sig-row"><code class="ri-reasoning-sig">${escapeHtml(item.signature || '')}</code></div>`;
 } else {
 badge = kind;
 bodyHtml = `<pre class="ri-reasoning-body">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`;
 }

 const sourceLabel = item.source ? `<span class="ri-reasoning-source">${escapeHtml(item.source)}</span>` : '';
 const metaLabel = extraMeta ? `<span class="ri-reasoning-meta">${escapeHtml(extraMeta)}</span>` : '';
 return `
 <details class="ri-reasoning" open>
 <summary class="ri-reasoning-header">
 <span class="ri-reasoning-badge">${escapeHtml(badge)}</span>
 ${sourceLabel}
 ${metaLabel}
 </summary>
 <div class="ri-reasoning-body-wrap">${bodyHtml}</div>
 </details>`;
}

function renderReasoningItems(items, q) {
 if (!Array.isArray(items) || !items.length) return '';
 return items.map(it => renderReasoningItem(it, q)).join('\n');
}

function formatMessageContent(content) {
 if (typeof content === 'string') return content;
 if (content == null) return '';
 if (!Array.isArray(content)) return JSON.stringify(content, null, 2);

 const parts = [];
 for (const part of content) {
 if (typeof part === 'string') { parts.push(part); continue; }
 if (part == null) continue;

 if (part.type === 'text' || typeof part.text === 'string') {
 parts.push(String(part.text ?? ''));
 continue;
 }
 if (part.type === 'image_url') {
 const url = part.image_url?.url || '';
 if (url.startsWith('data:')) {
 const mime = url.slice(5, url.indexOf(';')) || 'data';
 parts.push(`[image: ${mime}]`);
 } else {
 parts.push(`[image: ${url.slice(0, 80)}${url.length > 80 ? '…' : ''}]`);
 }
 continue;
 }
 if (part.type === 'image' && part.source) {
 const media = part.source.media_type || part.source.type || 'image';
 parts.push(`[image: ${media}]`);
 continue;
 }
 if (part.type === 'tool_use') {
 const name = part.name || '?';
 const input = JSON.stringify(part.input ?? {}, null, 2);
 parts.push(`[tool_use: ${name}]\n${input}`);
 continue;
 }
 if (part.type === 'tool_result') {
 const inner = formatMessageContent(part.content);
 parts.push(`[tool_result: ${part.tool_use_id || ''}]\n${inner}`);
 continue;
 }
 // Skip thinking/redacted_thinking here — they render as separate reasoning
 // blocks in renderMessageItem via extractMessageReasoning(). Falling back
 // to raw JSON dump would duplicate them and swamp the content pre.
 if (part.type === 'thinking' || part.type === 'redacted_thinking') {
 continue;
 }
 parts.push(JSON.stringify(part, null, 2));
 }
 return parts.join('\n\n');
}

async function fetchList() {
 try {
 const res = await fetch('/api/request-inspector/list');
 if (!res.ok) throw new Error(`HTTP ${res.status}`);
 cachedList = await res.json();
 } catch (err) {
 console.error(`[${MODULE_NAME}] Failed to fetch list:`, err);
 cachedList = [];
 }
 return cachedList;
}

async function fetchDetail(id) {
 try {
 const res = await fetch(`/api/request-inspector/${id}`);
 if (!res.ok) throw new Error(`HTTP ${res.status}`);
 return await res.json();
 } catch (err) {
 console.error(`[${MODULE_NAME}] Failed to fetch detail:`, err);
 return null;
 }
}

function buildFilterBar() {
 const q = escapeHtml(currentSearch);
 return `
 <div class="ri-filter-bar">
 <button class="ri-filter-btn menu_button ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">${t`All`}</button>
 <button class="ri-filter-btn menu_button ${currentFilter === 'chat' ? 'active' : ''}" data-filter="chat">\uD83D\uDCAC ${t`Chat`}</button>
 <button class="ri-filter-btn menu_button ${currentFilter === 'image' ? 'active' : ''}" data-filter="image">\uD83C\uDFA8 ${t`Image`}</button>
 <input type="text" class="ri-search-input text_pole" placeholder="${t`Search source / model / messages / response...`}" value="${q}" />
 </div>`;
}

function getFilteredItems(items) {
 const byType = currentFilter === 'all' ? items : items.filter(item => (item.type || 'chat') === currentFilter);
 const q = currentSearch.trim().toLowerCase();
 if (!q) return byType;
 return byType.filter(item => {
 const hay = (item.searchText || '').toLowerCase();
 return hay.includes(q);
 });
}

function buildInfoCell(item) {
 const type = item.type || 'chat';
 if (type === 'image') {
 const dims = (item.width && item.height) ? `${item.width}\u00D7${item.height}` : '';
 const promptSnippet = escapeHtml((item.prompt || '').slice(0, 40));
 return `<span class="ri-info-prompt" title="${escapeHtml(item.prompt || '')}">${promptSnippet}</span>${dims ? ` <span class="ri-info-dims">${dims}</span>` : ''}`;
 }
 const msgs = item.messageCount != null ? `${item.messageCount} ${t`msgs`}` : '';
 const tokens = item.usage?.prompt_tokens != null ? ` \u00B7 ${formatTokens(item.usage.prompt_tokens)}\u2192${formatTokens(item.usage.completion_tokens)}` : '';
 return `${msgs}${tokens}`;
}

function buildTableHtml(items) {
 const filtered = getFilteredItems(items);
 if (!filtered.length) {
 return `<div class="ri-empty">${t`No generation requests recorded yet.`}</div>`;
 }

 let html = `
 <div class="ri-table-wrap">
 <table class="ri-table">
 <thead>
 <tr>
 <th>${t`Time`}</th>
 <th>${t`Type`}</th>
 <th>${t`Source`}</th>
 <th>${t`Model`}</th>
 <th>${t`Info`}</th>
 <th>${t`Duration`}</th>
 <th>${t`Status`}</th>
 </tr>
 </thead>
 <tbody>`;

 for (const item of filtered) {
 const type = item.type || 'chat';
 const modelShort = (item.model || '').replace(/^(.*\/)?/, '').slice(0, 28);
 html += `
 <tr class="ri-row" data-id="${escapeHtml(item.id)}">
 <td class="ri-mono">${formatTimestamp(item.timestamp)}</td>
 <td>${typeIcon(type)}</td>
 <td>${escapeHtml(item.source)}</td>
 <td title="${escapeHtml(item.model)}">${escapeHtml(modelShort)}</td>
 <td class="ri-info-cell">${buildInfoCell(item)}</td>
 <td class="ri-mono">${formatDuration(item.durationMs)}</td>
 <td>${statusIcon(item.status)}</td>
 </tr>`;
 }

 html += `
 </tbody>
 </table>
 </div>`;
 return html;
}

function buildListHtml(items) {
 return buildFilterBar() + `<div class="ri-list-body">${buildTableHtml(items)}</div>`;
}

function formatToolCallArgsJson(args) {
 if (args == null) return '{}';
 if (typeof args === 'string') return args;
 try { return JSON.stringify(args, null, 2); }
 catch { return String(args); }
}

function buildResponseBodyHtml(detail, q) {
 const parts = Array.isArray(detail.responseParts) ? detail.responseParts : [];

 if (!parts.length) {
 // Legacy entry without parts: render plain responseText.
 return `<pre class="ri-msg-content ri-response-body">${highlightHtml(detail.responseText || t`(empty)`, q)}</pre>`;
 }

 const blocks = [];
 for (const part of parts) {
 if (part?.type === 'tool_call') {
 const argsJson = formatToolCallArgsJson(part.args);
 const idLine = part.id ? `<span class="ri-tool-call-id" title="${escapeHtml(part.id)}">${escapeHtml(part.id)}</span>` : '';
 blocks.push(`
 <div class="ri-tool-call">
 <div class="ri-tool-call-header">
 <span class="ri-tool-call-badge">${t`Function Call`}</span>
 <span class="ri-tool-call-name">${highlightHtml(part.name || '?', q)}</span>
 ${idLine}
 </div>
 <pre class="ri-tool-call-args">${highlightHtml(argsJson, q)}</pre>
 </div>`);
 } else if (part?.type === 'reasoning') {
 // Server-side extractPartsFromStreamEvents / extractPartsFromPayload
 // emits reasoning parts in the same shape as extractMessageReasoning
 // uses; renderReasoningItem consumes both with no adapter.
 blocks.push(renderReasoningItem(part, q));
 } else if (part?.type === 'text' && part.text) {
 blocks.push(`<pre class="ri-msg-content ri-response-body">${highlightHtml(part.text, q)}</pre>`);
 }
 }

 if (!blocks.length) {
 return `<pre class="ri-msg-content ri-response-body">${escapeHtml(t`(empty)`)}</pre>`;
 }
 return blocks.join('\n');
}

function renderMessageItem(msg, index, q) {
 const role = msg?.role || '?';
 const content = formatMessage(msg);
 const reasoningItems = extractMessageReasoning(msg);
 const reasoningHtml = renderReasoningItems(reasoningItems, q);
 const reasoningTextForHit = reasoningItems.map(it => {
 if (it.kind === 'text' || it.kind === 'thinking') return String(it.text || '');
 if (it.kind === 'redacted_thinking') return String(it.data || '');
 if (it.kind === 'signature') return String(it.signature || '');
 if (it.kind === 'details') {
 try { return JSON.stringify(it.details || []); } catch { return ''; }
 }
 return '';
 }).join('\n');
 const charLen = content.length;
 const qLower = q ? q.trim().toLowerCase() : '';
 const hit = !!(qLower && (content.toLowerCase().includes(qLower) || reasoningTextForHit.toLowerCase().includes(qLower)));
 const indexHtml = index != null ? `<span class="ri-msg-index">#${index}</span>` : '';
 const reasoningBadge = reasoningItems.length
 ? `<span class="ri-msg-reasoning-badge" title="${escapeHtml(t`This message carries reasoning artifacts`)}">${escapeHtml(t`reasoning`)}</span>`
 : '';
 const contentPre = content
 ? `<pre class="ri-msg-content">${highlightHtml(content, q)}</pre>`
 : (reasoningHtml ? '' : `<pre class="ri-msg-content">${escapeHtml(t`(empty)`)}</pre>`);
 return `
 <details class="ri-msg${hit ? ' ri-msg-hit' : ''}"${hit ? ' open' : ''}>
 <summary class="ri-msg-summary">
 ${indexHtml}
 <span class="ri-msg-role ri-role-${escapeHtml(role)}">${escapeHtml(role)}</span>
 ${reasoningBadge}
 <span class="ri-msg-len">${charLen.toLocaleString()} ${t`chars`}</span>
 </summary>
 ${reasoningHtml ? `<div class="ri-msg-reasoning-wrap">${reasoningHtml}</div>` : ''}
 ${contentPre}
 </details>`;
}

// Pull a `{ systemText, items, otherKeys }` view out of a wire request body.
// Handles three known shapes:
//   - Claude:  { system: [{type,text}] | string, messages: [{role,content}], ... }
//   - OpenAI:  { messages: [{role,content}], ... }   (system rides inside messages)
//   - Gemini:  { contents: [{role,parts:[{text}]}], systemInstruction: {parts}, ... }
function extractWireMessages(wr) {
 let systemText = null;
 if (typeof wr.system === 'string') {
 systemText = wr.system;
 } else if (Array.isArray(wr.system)) {
 systemText = wr.system.map(s => typeof s === 'string' ? s : (s?.text ?? '')).join('\n\n');
 } else {
 const si = wr.systemInstruction || wr.system_instruction;
 if (typeof si === 'string') {
 systemText = si;
 } else if (Array.isArray(si?.parts)) {
 systemText = si.parts.map(p => p?.text ?? '').join('\n\n');
 } else if (typeof si?.text === 'string') {
 systemText = si.text;
 }
 }

 const items = [];
 const rawMessages = Array.isArray(wr.messages) ? wr.messages : (Array.isArray(wr.contents) ? wr.contents : []);
 for (const m of rawMessages) {
 if (!m) continue;
 const role = m.role || '?';
 // Claude/OAI carry `content`; Gemini carries `parts` — pass through, formatMessageContent handles both.
 const content = (m.content != null) ? m.content : (Array.isArray(m.parts) ? m.parts : '');
 const item = { role, content };
 // Preserve reasoning-shaped fields verbatim so renderMessageItem →
 // extractMessageReasoning() can surface them as styled blocks. Without
 // these, DeepSeek `reasoning_content`, OpenRouter `reasoning_details`,
 // Anthropic `reasoning_blocks`, and per-message `signature` would be
 // stripped and never appear in the UI.
 if (typeof m.reasoning_content === 'string') item.reasoning_content = m.reasoning_content;
 if (typeof m.reasoning === 'string') item.reasoning = m.reasoning;
 if (Array.isArray(m.reasoning_blocks)) item.reasoning_blocks = m.reasoning_blocks;
 if (Array.isArray(m.reasoning_details)) item.reasoning_details = m.reasoning_details;
 if (typeof m.signature === 'string') item.signature = m.signature;
 if (Array.isArray(m.tool_calls)) item.tool_calls = m.tool_calls;
 if (typeof m.tool_call_id === 'string') item.tool_call_id = m.tool_call_id;
 if (typeof m.name === 'string') item.name = m.name;
 items.push(item);
 }

 const consumedKeys = new Set(['messages', 'contents', 'system', 'systemInstruction', 'system_instruction']);
 const otherKeys = Object.keys(wr).filter(k => !consumedKeys.has(k));
 return { systemText, items, otherKeys };
}

function buildWireRequestHtml(detail, q) {
 const wr = detail.wireRequest;
 if (!wr || typeof wr !== 'object') {
 return `
 <div class="ri-detail-section">
 <h4>${t`Wire Request`}</h4>
 <div class="ri-empty">${t`No wire request captured.`}</div>
 </div>`;
 }

 const { systemText, items, otherKeys } = extractWireMessages(wr);
 const blocks = [];
 if (systemText) {
 blocks.push(renderMessageItem({ role: 'system', content: systemText }, null, q));
 }
 items.forEach((m, i) => {
 blocks.push(renderMessageItem(m, i, q));
 });

 const otherJson = otherKeys.length
 ? JSON.stringify(Object.fromEntries(otherKeys.map(k => [k, wr[k]])), null, 2)
 : '';

 const count = (systemText ? 1 : 0) + items.length;
 return `
 <div class="ri-detail-section">
 <h4>${t`Wire Request`} (${count})</h4>
 <div class="ri-messages">
 ${blocks.join('\n') || `<div class="ri-empty">${t`No wire messages.`}</div>`}
 </div>
 ${otherJson ? `
 <details class="ri-wire-meta">
 <summary>${t`Other Params`}</summary>
 <pre class="ri-msg-content">${highlightHtml(otherJson, q)}</pre>
 </details>` : ''}
 </div>`;
}

function buildChatDetailBody(detail) {
 const q = currentDetailSearch;
 let sourceMessagesHtml = '';
 if (Array.isArray(detail.fullMessages)) {
 for (let i = 0; i < detail.fullMessages.length; i++) {
 sourceMessagesHtml += renderMessageItem(detail.fullMessages[i], i, q);
 }
 }

 const partCount = Array.isArray(detail.responseParts) ? detail.responseParts.length : 0;
 const toolCallCount = Array.isArray(detail.responseParts)
 ? detail.responseParts.filter(p => p?.type === 'tool_call').length
 : 0;
 const reasoningCount = Array.isArray(detail.responseParts)
 ? detail.responseParts.filter(p => p?.type === 'reasoning').length
 : 0;
 const respHeaderExtras = [
 toolCallCount > 0 ? `${toolCallCount} ${t`function calls`}` : '',
 reasoningCount > 0 ? `${reasoningCount} ${t`reasoning parts`}` : '',
 ].filter(Boolean).join(', ');
 const responseHeader = respHeaderExtras
 ? `${t`Response Body`} (${(detail.responseText || '').length.toLocaleString()} ${t`chars`}, ${respHeaderExtras})`
 : `${t`Response Body`} (${(detail.responseText || '').length.toLocaleString()} ${t`chars`})`;

 return `
 <div class="ri-detail-section">
 <h4>${responseHeader}</h4>
 ${buildResponseBodyHtml(detail, q)}
 </div>

 ${buildWireRequestHtml(detail, q)}

 <div class="ri-detail-section">
 <h4>${t`Source Messages`} (${detail.messageCount})</h4>
 <div class="ri-messages">
 ${sourceMessagesHtml || `<div class="ri-empty">${t`No messages captured.`}</div>`}
 </div>
 </div>`;
}

function buildChatDetailHtml(detail) {
 const usage = detail.usage || {};
 const cacheInfo = (usage.cache_read != null || usage.cache_write != null)
 ? `<tr><td>${t`Cache Read`}</td><td>${formatTokens(usage.cache_read)}</td></tr>
 <tr><td>${t`Cache Write`}</td><td>${formatTokens(usage.cache_write)}</td></tr>`
 : '';

 const endpointRow = detail.endpoint
 ? `<tr><td>${t`Endpoint URL`}</td><td class="ri-mono" title="${escapeHtml(detail.endpoint)}">${escapeHtml(detail.endpoint)}</td></tr>`
 : '';
 const keyRow = detail.apiKeyFingerprint
 ? `<tr><td>${t`API Key`}</td><td class="ri-mono" title="${escapeHtml(detail.apiKeyFingerprint)}">${escapeHtml(detail.apiKeyFingerprint)}</td></tr>`
 : '';

 return `
 <div class="ri-detail">
 <div class="ri-detail-header">
 <button class="ri-back menu_button">\u2190 ${t`Back`}</button>
 <button class="ri-export menu_button" data-id="${escapeHtml(detail.id)}">${t`Export JSON`}</button>
 <input type="text" class="ri-detail-search text_pole" placeholder="${t`Search in this request...`}" value="${escapeHtml(currentDetailSearch)}" />
 </div>

 <div class="ri-detail-grid">
 <div class="ri-detail-section">
 <h4>${t`Request`}</h4>
 <table class="ri-kv">
 <tr><td>${t`Source`}</td><td>${escapeHtml(detail.source)}</td></tr>
 <tr><td>${t`Model`}</td><td>${escapeHtml(detail.model)}</td></tr>
 ${endpointRow}
 ${keyRow}
 <tr><td>${t`Stream`}</td><td>${detail.stream ? t`Yes` : t`No`}</td></tr>
 <tr><td>${t`Messages`}</td><td>${detail.messageCount}</td></tr>
 <tr><td>${t`Prompt Chars`}</td><td>${(detail.promptCharLength || 0).toLocaleString()}</td></tr>
 <tr><td>${t`Max Tokens`}</td><td>${detail.maxTokens ?? '\u2014'}</td></tr>
 </table>
 </div>

 <div class="ri-detail-section">
 <h4>${t`Response`}</h4>
 <table class="ri-kv">
 <tr><td>${t`Status`}</td><td>${statusIcon(detail.status)} ${escapeHtml(detail.status)}</td></tr>
 <tr><td>HTTP</td><td>${detail.httpStatus ?? '\u2014'}</td></tr>
 <tr><td>${t`Duration`}</td><td>${formatDuration(detail.durationMs)}</td></tr>
 <tr><td>${t`Prompt Tokens`}</td><td>${formatTokens(usage.prompt_tokens)}</td></tr>
 <tr><td>${t`Completion Tokens`}</td><td>${formatTokens(usage.completion_tokens)}</td></tr>
 <tr><td>${t`Total Tokens`}</td><td>${formatTokens(usage.total_tokens)}</td></tr>
 ${cacheInfo}
 ${detail.error ? `<tr><td>${t`Error`}</td><td class="ri-error-text">${escapeHtml(detail.error)}</td></tr>` : ''}
 </table>
 </div>
 </div>

 <div class="ri-detail-body">${buildChatDetailBody(detail)}</div>
 </div>`;
}

function buildImageDetailHtml(detail) {
 const dims = (detail.width && detail.height) ? `${detail.width} \u00D7 ${detail.height}` : '\u2014';

 const endpointRow = detail.endpoint
 ? `<tr><td>${t`Endpoint URL`}</td><td class="ri-mono" title="${escapeHtml(detail.endpoint)}">${escapeHtml(detail.endpoint)}</td></tr>`
 : '';
 const keyRow = detail.apiKeyFingerprint
 ? `<tr><td>${t`API Key`}</td><td class="ri-mono" title="${escapeHtml(detail.apiKeyFingerprint)}">${escapeHtml(detail.apiKeyFingerprint)}</td></tr>`
 : '';

 return `
 <div class="ri-detail">
 <div class="ri-detail-header">
 <button class="ri-back menu_button">\u2190 ${t`Back`}</button>
 <button class="ri-export menu_button" data-id="${escapeHtml(detail.id)}">${t`Export JSON`}</button>
 </div>

 <div class="ri-detail-grid">
 <div class="ri-detail-section">
 <h4>${t`Image Generation`}</h4>
 <table class="ri-kv">
 <tr><td>${t`Source`}</td><td>${escapeHtml(detail.source)}</td></tr>
 <tr><td>${t`Model`}</td><td>${escapeHtml(detail.model || '\u2014')}</td></tr>
 ${endpointRow}
 ${keyRow}
 <tr><td>${t`Dimensions`}</td><td>${dims}</td></tr>
 <tr><td>${t`Steps`}</td><td>${detail.steps ?? '\u2014'}</td></tr>
 <tr><td>${t`CFG Scale`}</td><td>${detail.cfgScale ?? '\u2014'}</td></tr>
 <tr><td>${t`Seed`}</td><td>${detail.seed ?? '\u2014'}</td></tr>
 <tr><td>${t`Sampler`}</td><td>${escapeHtml(detail.sampler || '\u2014')}</td></tr>
 </table>
 </div>

 <div class="ri-detail-section">
 <h4>${t`Response`}</h4>
 <table class="ri-kv">
 <tr><td>${t`Status`}</td><td>${statusIcon(detail.status)} ${escapeHtml(detail.status)}</td></tr>
 <tr><td>HTTP</td><td>${detail.httpStatus ?? '\u2014'}</td></tr>
 <tr><td>${t`Duration`}</td><td>${formatDuration(detail.durationMs)}</td></tr>
 <tr><td>${t`Output Format`}</td><td>${escapeHtml(detail.outputFormat || '\u2014')}</td></tr>
 <tr><td>${t`Output Size`}</td><td>${formatBytes(detail.outputSizeBytes)}</td></tr>
 ${detail.error ? `<tr><td>${t`Error`}</td><td class="ri-error-text">${escapeHtml(detail.error)}</td></tr>` : ''}
 </table>
 </div>
 </div>

 <div class="ri-detail-section">
 <h4>${t`Prompt`}</h4>
 <pre class="ri-img-prompt">${escapeHtml(detail.prompt || t`(empty)`)}</pre>
 </div>

 ${detail.negativePrompt ? `
 <div class="ri-detail-section">
 <h4>${t`Negative Prompt`}</h4>
 <pre class="ri-img-prompt ri-img-neg-prompt">${escapeHtml(detail.negativePrompt)}</pre>
 </div>` : ''}
 </div>`;
}

function buildDetailHtml(detail) {
 if (!detail) return `<div class="ri-empty">${t`Failed to load request details.`}</div>`;
 const type = detail.type || 'chat';
 return type === 'image' ? buildImageDetailHtml(detail) : buildChatDetailHtml(detail);
}

async function openInspectorPanel() {
 const items = await fetchList();
 const content = $('<div class="ri-container"></div>');
 content.html(buildListHtml(items));

 content.on('click', '.ri-filter-btn', function () {
 currentFilter = $(this).data('filter');
 content.html(buildListHtml(cachedList));
 });

 content.on('input', '.ri-search-input', function () {
 currentSearch = $(this).val() || '';
 content.find('.ri-list-body').html(buildTableHtml(cachedList));
 });

 content.on('click', '.ri-row', async function () {
 const id = $(this).data('id');
 if (!id) return;
 currentDetailId = id;
 currentDetailSearch = '';
 cachedDetail = null;
 content.html(`<div class="ri-loading">${t`Loading...`}</div>`);
 const detail = await fetchDetail(id);
 cachedDetail = detail;
 content.html(buildDetailHtml(detail));
 content.closest('.popup-content').scrollTop(0);
 });

 content.on('click', '.ri-back', async function () {
 currentDetailId = null;
 currentDetailSearch = '';
 cachedDetail = null;
 const items = await fetchList();
 content.html(buildListHtml(items));
 content.closest('.popup-content').scrollTop(0);
 });

 content.on('input', '.ri-detail-search', function () {
 currentDetailSearch = $(this).val() || '';
 if (cachedDetail && (cachedDetail.type || 'chat') === 'chat') {
 content.find('.ri-detail-body').html(buildChatDetailBody(cachedDetail));
 }
 });

 content.on('click', '.ri-export', function () {
 const id = $(this).data('id');
 if (!id) return;
 const a = document.createElement('a');
 a.href = `/api/request-inspector/${id}/export`;
 a.download = '';
 document.body.appendChild(a);
 a.click();
 document.body.removeChild(a);
 });

 callGenericPopup(content, POPUP_TYPE.TEXT, '', {
 wide: true,
 large: true,
 okButton: t`Close`,
 allowVerticalScrolling: true,
 });
}

jQuery(() => {
 const $btn = $(`
 <div id="request_inspector_button" class="margin0 menu_button_icon menu_button">
 <i class="fa-fw fa-solid fa-satellite-dish"></i>
 <span data-i18n="Inspector">Inspector</span>
 </div>
 `);

 $btn.on('click', () => openInspectorPanel());

 const $logsBtn = $('#server_logs_button');
 if ($logsBtn.length) {
 $logsBtn.after($btn);
 } else {
 $('#account_controls').append($btn);
 }
});
