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

import http from 'node:http';

const DEFAULT_REPLY = '*Ash glances toward the sea and answers in two careful sentences, eyes lingering on the path behind you both.* The reef has been restless tonight, but the lantern still holds. We can keep moving.';

/**
 * @param {object} opts
 * @param {string[]} [opts.scriptedReplies]
 * @param {Array<{name:string, arguments:object}>} [opts.scriptedToolCalls]
 * @param {number} [opts.latencyMs]
 * @returns {Promise<{port:number, baseURL:string, scriptReply:(s:string)=>void, scriptToolCall:(t:object)=>void, requests:object[], stop:()=>Promise<void>}>}
 */
export async function startMockLLM({ scriptedReplies = [], scriptedToolCalls = [], latencyMs = 0 } = {}) {
    const replies = [...scriptedReplies];
    const tools = [...scriptedToolCalls];
    const requests = [];

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

        // Chat completions.
        if (req.url.endsWith('/chat/completions') || req.url.endsWith('/v1/chat/completions')) {
            // Tool calls take precedence — when a tool is scripted next,
            // don't also pop a reply (they were ending up out of sync, so
            // the spec's next "plain text" assertion saw the wrong slot).
            // After the tool completes, the next call picks up the next
            // reply normally. This matches how a real model behaves: it
            // either returns content OR tool_calls, not both per turn.
            const toolCall = tools.length ? tools.shift() : null;
            const reply = toolCall ? null : (replies.length ? replies.shift() : deriveEcho(parsed));
            const isStream = parsed.stream === true;
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
        requests,
        stop: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

function deriveEcho(parsed) {
    const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    const content = typeof lastUser?.content === 'string' ? lastUser.content : (Array.isArray(lastUser?.content) ? lastUser.content.map(p => p.text || '').join(' ') : '');
    if (!content) return DEFAULT_REPLY;
    // Echo with a small RP wrap so it reads like an in-world reply, not "you said: ...".
    return `*Ash pauses, considering your words.* "${content.slice(0, 200)}" *They look up at the lantern light.*`;
}
