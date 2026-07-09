// Tiny OpenAI-compatible mock LLM endpoint so tests don't burn real API
// credits for paths that don't care about model quality (most chat-flow,
// branch, swipe, persistence, MG-extraction-fired, etc).
//
// Each spec calls `startMockLLM({ scriptedReplies })` and gets back a
// base URL it can plug into Luker as a CUSTOM chat-completion endpoint
// via the connection profile.
//
// `scriptedReplies` is a queue of strings; each /v1/chat/completions
// request pops the next reply. If exhausted, falls back to a deterministic
// echo derived from the last user message so tests don't randomly hang.
//
// Streaming: if request body has stream:true, sends server-sent events
// with one chunk per word and a final [DONE] frame. Tools: if request
// has tools, the mock can be scripted to reply with a tool_calls choice
// via `nextTool({name, arguments})` before the next chat call.
//
// ─────────────────────────────────────────────────────────────────────────
// Director-aware routing (for orchestrator director-mode runtime tests)
// ─────────────────────────────────────────────────────────────────────────
//
// The director runtime drives a multi-agent loop:
//   1. main agent receives the user turn + a tools schema including
//      dispatch_subagent / write_message / apply_message_patches /
//      get_draft / finalize. Each round MUST return at least one
//      tool_call — a plain-text reply is rejected as a "no-tool-call"
//      failure and retried, so a queue of plain replies can NEVER drive
//      the director to commit.
//   2. when the main agent emits dispatch_subagent, the runtime forks a
//      sub-agent mini-loop. The sub-agent's request carries a distinct
//      system-prompt shape: an anti-RP META_FRAME, the <story_context>
//      block, an <orchestration_role> block (the sub-agent's persona),
//      and a final <task> block with the brief. Sub-agents do NOT have
//      dispatch / write_message tools — they read tools (chat, lorebook,
//      memory, search) plus get_draft / draft_search, and terminate by
//      producing a round with ZERO tool calls (the text of that round is
//      what main reads back via await_subagents).
//   3. the main agent eventually calls finalize() to commit the in-flight
//      draft (built up via write_message calls) as the chat bubble.
//
// To drive this from a test, call `mock.scriptDirectorRun({ route })`
// before sending the user turn. `route(req)` is invoked once per
// /chat/completions hit with a request descriptor:
//
//   req.role               — 'director-main' | 'subagent' | 'unknown'
//   req.subagentId         — best-effort identifier extracted from the
//                            sub-agent's system prompt (the first non-
//                            empty line of <orchestration_role>; for
//                            dispatch_inline_subagent this is whatever
//                            the inline systemPrompt's first line says).
//                            Use req.subagentRole as a coarser hint when
//                            specific ids aren't predictable.
//   req.subagentTask       — content of the sub-agent's <task> block
//                            (the brief the main agent passed).
//   req.systemPrompts      — array of all system message contents
//   req.userMessages       — array of all user message contents
//   req.lastUser           — string content of the last user message
//   req.toolNames          — array of tool names exposed to this caller
//                            (handy for "is this the main agent's
//                            tools array?" checks)
//   req.turn               — per-role call counter starting at 0.
//                            For 'director-main', increments on every
//                            director-main call. For 'subagent', a
//                            single shared counter across all subagent
//                            calls (tests usually want per-subagent
//                            counters; track those yourself via a
//                            closure over local state if needed).
//   req.body               — raw parsed JSON body if you need more
//
// route() returns ONE of:
//   - { text: '...' }                              plain assistant text
//   - { tool: 'name', arguments: {...} }           single tool call
//   - { toolCalls: [{name, arguments}, ...] }      parallel tool calls
//   - null / undefined                             fall back to queue
//
// Both streaming and non-streaming transports are handled — the mock
// emits the right shape based on the request body's `stream` flag.
//
// Example — a complete director turn that dispatches one sub-agent then
// writes + finalizes the message body:
//
//   const FINAL = '*Ash lowers the glass.* "Three hulls north."';
//   mock.scriptDirectorRun({
//       route: ({ role, turn, subagentId }) => {
//           if (role === 'director-main' && turn === 0) {
//               return { tool: 'dispatch_subagent',
//                   arguments: { subagentId: 'lorebook_scout', task: 'find reef facts' } };
//           }
//           if (role === 'subagent') {
//               return { text: 'reef shifts on a 19-day cycle.' };
//           }
//           if (role === 'director-main' && turn === 1) {
//               return { toolCalls: [
//                   { name: 'await_subagents', arguments: { handles: ['subagent-0'] } },
//               ] };
//           }
//           if (role === 'director-main' && turn === 2) {
//               return { tool: 'write_message', arguments: { text: FINAL } };
//           }
//           if (role === 'director-main' && turn === 3) {
//               return { tool: 'finalize', arguments: {} };
//           }
//           return null;  // queue fallback
//       },
//   });

import http from 'node:http';

const DEFAULT_REPLY = '*Ash glances toward the sea and answers in two careful sentences, eyes lingering on the path behind you both.* The reef has been restless tonight, but the lantern still holds. We can keep moving.';

// Marker text from the director-mode sub-agent META_FRAME (see
// director-tools.js#runDispatchInternal). Detecting this in a request's
// system messages is the most reliable way to tag the request as
// originating from the sub-agent dispatcher path — the META_FRAME is
// stamped on every sub-agent call regardless of which subagent id /
// inline prompt is in play.
const SUBAGENT_META_FRAME_PREFIX = 'You are an orchestration agent embedded inside a roleplay session.';

// Marker tool names that uniquely identify a director MAIN agent request.
// `dispatch_subagent` / `dispatch_inline_subagent` / `finalize` /
// `write_message` / `apply_message_patches` are all main-only tools —
// sub-agents never see them (see director-tools.js#buildSubAgentToolSchemas
// which exposes only get_draft + draft_search + loop tools). `finalize`
// is the strongest signal because director re-purposes loop's finalize
// name with a different signature, so its presence in the tools array
// is a director-mode tell.
const MAIN_ONLY_TOOL_NAMES = new Set([
    'dispatch_subagent',
    'dispatch_inline_subagent',
    'write_message',
    'apply_message_patches',
    'finalize',
]);

/**
 * @param {object} opts
 * @param {string[]} [opts.scriptedReplies]
 * @param {Array<{name:string, arguments:object}>} [opts.scriptedToolCalls]
 * @param {number} [opts.latencyMs]
 * @returns {Promise<{
 *   port:number,
 *   baseURL:string,
 *   scriptReply:(s:string)=>void,
 *   scriptToolCall:(t:object)=>void,
 *   scriptDirectorRun:(opts:{route:Function})=>void,
 *   clearDirectorRun:()=>void,
 *   requests:object[],
 *   stop:()=>Promise<void>,
 * }>}
 */
export async function startMockLLM({ scriptedReplies = [], scriptedToolCalls = [], latencyMs = 0, streamChunkDelayMs = 0 } = {}) {
    const replies = [...scriptedReplies];
    const tools = [...scriptedToolCalls];
    const requests = [];
    // Per-stream drip delay between SSE frames (default 0 = burst).
    // 11.2 (reconnect) uses this to keep a stream open long enough that
    // the test can go offline mid-flight; server-side buffering + WS
    // replay must still deliver every chunk.
    let chunkDelayMsGlobal = streamChunkDelayMs;
    function setChunkDelay(ms) { chunkDelayMsGlobal = Math.max(0, Number(ms) || 0); }

    // Director routing state — single in-flight router. scriptDirectorRun
    // replaces it; clearDirectorRun nulls it. Per-role turn counters are
    // co-located so each scripted run starts fresh from turn 0.
    let directorRoute = null;
    const turnCounters = { 'director-main': 0, 'subagent': 0 };

    function setDirectorRoute(fn) {
        directorRoute = typeof fn === 'function' ? fn : null;
        turnCounters['director-main'] = 0;
        turnCounters['subagent'] = 0;
    }

    function classifyRequest(parsed) {
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const toolDefs = Array.isArray(parsed?.tools) ? parsed.tools : [];
        const toolNames = toolDefs
            .map(t => String(t?.function?.name || t?.name || ''))
            .filter(Boolean);

        const systemPrompts = messages
            .filter(m => m && m.role === 'system')
            .map(m => stringifyMessageContent(m.content));
        const userMessages = messages
            .filter(m => m && m.role === 'user')
            .map(m => stringifyMessageContent(m.content));

        const lastUser = userMessages.length > 0 ? userMessages[userMessages.length - 1] : '';

        // Sub-agent fingerprint: META_FRAME stamped as one of the system
        // messages in the dispatcher's assembled prompt. Robust against
        // user-defined main system prompts because the META_FRAME wording
        // is hard-coded in the runtime and never reused for the main agent.
        // We `includes` (not `startsWith`) because some chat-completion
        // presets concatenate multiple system messages into one block
        // (the openai preset's "main" prompt prepends character / scenario
        // text before the orchestrator's META_FRAME message), so the
        // META_FRAME isn't necessarily at index 0 of its own system entry.
        const hasSubagentFrame = systemPrompts.some(s => s.includes(SUBAGENT_META_FRAME_PREFIX));
        // Main-agent fingerprint: any of the main-only tool names appear
        // in the tools array. dispatch_subagent is gated on having
        // sub-agents configured, but the message-production tools
        // (write_message/finalize/etc.) appear on EVERY main-agent
        // request, so detection is reliable even when no sub-agents are
        // configured.
        const hasMainTools = toolNames.some(n => MAIN_ONLY_TOOL_NAMES.has(n));

        let role = 'unknown';
        if (hasSubagentFrame && !hasMainTools) role = 'subagent';
        else if (hasMainTools) role = 'director-main';

        // Pull <orchestration_role> + <task> content out of the sub-agent's
        // system messages. The dispatcher emits each as its own discrete
        // system message wrapping the body in XML-style tags (see
        // director-tools.js#runDispatchInternal); we only need to find
        // the system message that contains the tag and unwrap it.
        let subagentId = '';
        let subagentRole = '';
        let subagentTask = '';
        if (role === 'subagent') {
            for (const s of systemPrompts) {
                const roleMatch = /<orchestration_role>\s*([\s\S]*?)\s*<\/orchestration_role>/.exec(s);
                if (roleMatch) {
                    subagentRole = roleMatch[1];
                    // First non-empty line of the role block is the
                    // strongest "who am I?" hint we have without parsing
                    // the entire systemPrompt. For the default profile's
                    // sub-agents this lands on phrases like
                    // "You are a pre-draft chat scout." which tests can
                    // pattern-match on. For dispatch_inline_subagent
                    // this is the first line of the user-supplied
                    // systemPrompt verbatim.
                    const firstLine = subagentRole.split('\n').find(l => l.trim().length > 0);
                    if (firstLine) subagentId = firstLine.trim();
                }
                const taskMatch = /<task>\s*([\s\S]*?)\s*<\/task>/.exec(s);
                if (taskMatch) subagentTask = taskMatch[1];
            }
        }

        return {
            role,
            subagentId,
            subagentRole,
            subagentTask,
            systemPrompts,
            userMessages,
            lastUser,
            toolNames,
            stream: parsed?.stream === true,
            body: parsed,
        };
    }

    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch {}
        requests.push({ url: req.url, method: req.method, body: parsed, headers: req.headers });

        if (latencyMs > 0) await new Promise(r => setTimeout(r, latencyMs));

        // Models list endpoint — Luker probes this for the model dropdown.
        if (req.url.endsWith('/models') || req.url.endsWith('/v1/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                object: 'list',
                data: [
                    { id: 'mock-gpt-4o', object: 'model' },
                    { id: 'mock-claude-sonnet', object: 'model' },
                ],
            }));
            return;
        }

        // Embeddings — deterministic per-string vector derived from a
        // bag-of-tokens hash so semantically overlapping strings cluster
        // by cosine similarity. Real shape, no real model: every input is
        // mapped to a fixed-dim float array via per-token hash → bucket.
        if (req.url.endsWith('/embeddings') || req.url.endsWith('/v1/embeddings')) {
            const inputs = Array.isArray(parsed?.input)
                ? parsed.input
                : (typeof parsed?.input === 'string' ? [parsed.input] : []);
            const model = String(parsed?.model || 'mock-embed');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                object: 'list',
                data: inputs.map((text, index) => ({
                    object: 'embedding',
                    index,
                    embedding: deterministicEmbedding(String(text == null ? '' : text)),
                })),
                model,
                usage: { prompt_tokens: 0, total_tokens: 0 },
            }));
            return;
        }

        // Chat completions.
        if (req.url.endsWith('/chat/completions') || req.url.endsWith('/v1/chat/completions')) {
            // Director routing has priority over the queue when:
            //   (a) a director router was registered AND
            //   (b) the incoming request can be classified as director-main
            //       or subagent (i.e. matches the protocol fingerprint).
            //
            // When the router returns null/undefined for a classified
            // request, OR the request didn't classify as director, we
            // fall back to the existing queue-based behavior — keeping
            // every non-director spec (chat-flow, swipe, persistence,
            // etc.) working unchanged.
            let routerResponse = null;
            let classification = null;
            if (directorRoute) {
                classification = classifyRequest(parsed);
                if (classification.role !== 'unknown') {
                    const reqDescriptor = {
                        ...classification,
                        turn: turnCounters[classification.role],
                    };
                    try {
                        routerResponse = directorRoute(reqDescriptor);
                    } catch (err) {
                        // Surface router exceptions as an HTTP 500 — the
                        // test will fail loudly with the message instead
                        // of silently hanging on a missing reply.
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ error: { message: `mock director route threw: ${err?.message || err}` } }));
                        return;
                    }
                    // Only bump the per-role counter when the router
                    // actually produced something — letting a falsy return
                    // pass through to the queue without consuming a turn
                    // slot keeps the counter aligned with director-handled
                    // calls only.
                    if (routerResponse !== null && routerResponse !== undefined) {
                        turnCounters[classification.role] += 1;
                    }
                }
            }

            const isStream = parsed.stream === true;

            // Router took over → emit its response and return.
            if (routerResponse !== null && routerResponse !== undefined) {
                respondFromRouter(res, parsed, routerResponse, isStream);
                return;
            }

            // Fallback: existing queue-based behavior.
            // Tool calls take precedence — when a tool is scripted next,
            // don't also pop a reply (they were ending up out of sync, so
            // the spec's next "plain text" assertion saw the wrong slot).
            // After the tool completes, the next call picks up the next
            // reply normally. This matches how a real model behaves: it
            // either returns content OR tool_calls, not both per turn.
            const toolCall = tools.length ? tools.shift() : null;
            const reply = toolCall ? null : (replies.length ? replies.shift() : deriveEcho(parsed));
            if (isStream) {
                res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    'connection': 'keep-alive',
                });
                if (toolCall) {
                    // ToolManager.parseToolCalls requires `typeof choice.index === 'number'`
                    // and silently skips choices without it. Without `index: 0` here,
                    // every streaming tool_call gets dropped on the floor.
                    const frame = {
                        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'mock-tc-1', type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }] }, finish_reason: null }],
                    };
                    res.write(`data: ${JSON.stringify(frame)}\n\n`);
                    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
                } else {
                    const words = reply.split(/\s+/);
                    for (let i = 0; i < words.length; i++) {
                        const piece = (i === 0 ? '' : ' ') + words[i];
                        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
                        if (chunkDelayMsGlobal > 0 && i < words.length - 1) {
                            await new Promise(r => setTimeout(r, chunkDelayMsGlobal));
                        }
                    }
                    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
                }
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            const choice = toolCall
                ? { index: 0, message: { role: 'assistant', tool_calls: [{ id: 'mock-tc-1', type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }] }, finish_reason: 'tool_calls' }
                : { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'mock-cmpl-1',
                object: 'chat.completion',
                created: 0,
                model: parsed.model || 'mock-gpt-4o',
                choices: [choice],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
            return;
        }

        // Status / generic 200 for unknown probes.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        port,
        baseURL: `http://127.0.0.1:${port}/v1`,
        scriptReply(s) { replies.push(s); },
        scriptToolCall(t) { tools.push(t); },
        setStreamChunkDelayMs(ms) { setChunkDelay(ms); },
        scriptDirectorRun({ route } = {}) { setDirectorRoute(route); },
        clearDirectorRun() { setDirectorRoute(null); },
        requests,
        stop: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

/**
 * Emit a single chat-completion response derived from the router's return
 * value. Handles four shapes uniformly across streaming and non-streaming
 * transports:
 *   - { text }                                   → assistant text + finish=stop
 *   - { tool, arguments, text? }                 → single tool_call (text optional)
 *   - { toolCalls: [{name, args}], text? }       → N parallel tool_calls (text optional)
 *   - { reasoning } may accompany any of the above
 *
 * When `text` accompanies tool_calls, the runtime sees both — director-
 * mode's main agent loop streams the text into its panel section AND
 * still dispatches the tool calls. Useful for "the agent is narrating
 * what it's about to do" tests that need both the action and the
 * accompanying narration to surface in the panel.
 *
 * For streaming, each tool_call gets its own index in the delta array
 * (parallel-dispatch case) — without distinct indices the runtime's
 * tool-call assembler collapses them into one.
 */
function respondFromRouter(res, parsed, response, isStream) {
    const toolCalls = normalizeToolCalls(response);
    const text = String(response.text ?? '');
    const reasoning = response.reasoning != null ? String(response.reasoning) : '';
    if (isStream) {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
        });
        // Role hint on the first delta — harmless when present, missed
        // when absent. Some consumers expect it.
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        // Reasoning chunks first so the panel's reasoning section gets
        // populated before the text/tool_call deltas land.
        if (reasoning.length > 0) {
            const rwords = reasoning.split(/\s+/);
            for (let i = 0; i < rwords.length; i++) {
                const piece = (i === 0 ? '' : ' ') + rwords[i];
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] })}\n\n`);
            }
        }
        if (text.length > 0) {
            // Stream the body word-by-word so live consumers (run panel,
            // reasoning fold) see incremental updates instead of one big
            // burst at the end.
            const words = text.split(/\s+/);
            for (let i = 0; i < words.length; i++) {
                const piece = (i === 0 ? '' : ' ') + words[i];
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
            }
        }
        if (toolCalls.length > 0) {
            // Emit each tool_call as its own delta. Distinct `index`
            // values within the tool_calls array are what tells the
            // runtime "these are N separate calls, not chunks of one".
            for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i];
                const frame = {
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: i,
                                id: `mock-tc-${i + 1}`,
                                type: 'function',
                                function: { name: tc.name, arguments: tc.arguments },
                            }],
                        },
                        finish_reason: null,
                    }],
                };
                res.write(`data: ${JSON.stringify(frame)}\n\n`);
            }
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }
    // Non-streaming.
    const message = { role: 'assistant', content: text };
    if (reasoning) message.reasoning = reasoning;
    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((tc, i) => ({
            id: `mock-tc-${i + 1}`,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
        }));
    }
    const choice = {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        id: 'mock-cmpl-1',
        object: 'chat.completion',
        created: 0,
        model: parsed.model || 'mock-gpt-4o',
        choices: [choice],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
}

/**
 * Normalize the three permitted router-response shapes into a uniform
 * `[{ name, arguments: string }]` list. Empty list signals "this is a
 * text response, not a tool call".
 *
 * The `arguments` field is always serialized to a string — OpenAI's
 * wire format requires it, and the runtime's tool-call assembler does
 * JSON.parse on the way out. Passing an object pre-stringifies it
 * here so test code can write `{ arguments: { text: '...' } }`
 * without remembering to JSON.stringify.
 */
function normalizeToolCalls(response) {
    if (!response || typeof response !== 'object') return [];
    if (Array.isArray(response.toolCalls)) {
        return response.toolCalls
            .filter(tc => tc && typeof tc === 'object' && (tc.name || tc.tool))
            .map(tc => ({
                name: String(tc.name || tc.tool || ''),
                arguments: serializeToolArgs(tc.arguments),
            }));
    }
    if (response.tool || response.toolName) {
        return [{
            name: String(response.tool || response.toolName || ''),
            arguments: serializeToolArgs(response.arguments),
        }];
    }
    return [];
}

function serializeToolArgs(args) {
    if (typeof args === 'string') return args;
    try { return JSON.stringify(args ?? {}); }
    catch { return '{}'; }
}

/**
 * Some clients send tool / system message content as an array of parts
 * (e.g. `[{ type: 'text', text: '...' }]`). Flatten to a single string
 * so router code can grep without worrying about which shape is in use.
 */
function stringifyMessageContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(p => (typeof p === 'string' ? p : (p?.text || '')))
            .join('');
    }
    return '';
}

function deriveEcho(parsed) {
    const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    const content = typeof lastUser?.content === 'string' ? lastUser.content : (Array.isArray(lastUser?.content) ? lastUser.content.map(p => p.text || '').join(' ') : '');
    if (!content) return DEFAULT_REPLY;
    // Echo with a small RP wrap so it reads like an in-world reply, not "you said: ...".
    return `*Ash pauses, considering your words.* "${content.slice(0, 200)}" *They look up at the lantern light.*`;
}

// ---------------------------------------------------------------------------
// Embeddings — deterministic bag-of-tokens hash → fixed-dim float vector.
//
// Each whitespace-separated token of the input maps to one of EMBED_DIMS
// buckets via a stable djb2-style hash. The token contributes a small
// signed weight to that bucket; collisions average out across many tokens.
// L2-normalize at the end so cosine similarity (= dot product) is bounded
// in [-1, 1]. Strings that share many tokens (e.g. "navigate the coast"
// and "Coastal navigation in fog") end up with overlapping bucket sets
// and positive cosine, which is exactly what the e2e vector tests rely
// on — no real semantic embedding required.
// ---------------------------------------------------------------------------
const EMBED_DIMS = 384;

function hashToken(token) {
    // djb2 — stable across runs, fits in a 32-bit signed range.
    let h = 5381;
    for (let i = 0; i < token.length; i++) {
        h = ((h << 5) + h + token.charCodeAt(i)) | 0;
    }
    return h;
}

function tokenize(text) {
    // Lowercase + strip non-alphanumeric (keep ASCII letters, digits, and
    // BMP letters above U+00C0 so CJK / accented prose still tokenizes
    // reasonably) so capitalization, punctuation, and quotes don't
    // fragment the bag. Empty tokens dropped.
    return String(text).toLowerCase()
        .replace(/[^a-z0-9À-￿]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function deterministicEmbedding(text) {
    const vec = new Array(EMBED_DIMS).fill(0);
    const tokens = tokenize(text);
    if (tokens.length === 0) {
        // Avoid the zero vector (cosine undefined). Seed from raw bytes
        // so that two "empty after tokenize" strings still produce
        // distinct vectors (e.g. pure punctuation, whitespace, etc.).
        const seed = hashToken(text || ' ') | 0;
        for (let i = 0; i < EMBED_DIMS; i++) {
            // Small mixed sequence — keep magnitudes tiny so a single empty
            // input doesn't dominate downstream cosine math.
            vec[i] = (((seed ^ (i * 2654435761)) | 0) % 1000) / 100000;
        }
    } else {
        for (const token of tokens) {
            const h = hashToken(token);
            const bucket = ((h % EMBED_DIMS) + EMBED_DIMS) % EMBED_DIMS;
            // Sign bit from a different hash region so adjacent tokens
            // don't all push the same direction.
            const sign = ((h >>> 16) & 1) === 0 ? 1 : -1;
            // Magnitude derives from token length so common short stop-
            // words contribute less than longer content words. Cheap
            // approximation of TF-IDF weighting without a real corpus.
            const weight = sign * (1 + Math.min(token.length, 12)) / 13;
            vec[bucket] += weight;
            // Also stamp two neighboring buckets at decreasing weight so
            // a near-miss (same token in slightly different form) still
            // overlaps a bit. Keeps the index from being knife-edge.
            const left = (bucket - 1 + EMBED_DIMS) % EMBED_DIMS;
            const right = (bucket + 1) % EMBED_DIMS;
            vec[left] += weight * 0.3;
            vec[right] += weight * 0.3;
        }
    }
    // L2-normalize so cosine = dot product. Backends typically assume
    // unit vectors when computing similarity.
    let norm = 0;
    for (let i = 0; i < EMBED_DIMS; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < EMBED_DIMS; i++) vec[i] = vec[i] / norm;
    return vec;
}
