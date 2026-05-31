/**
 * Per-run Layer-3 registry — compiles profile.customTools[] entries into
 * { exec, simulate, mode, source, schema } shape that loop-tools.js
 * executeLoopTool can dispatch verbatim.
 *
 * Compile failures (SyntaxError, etc.) skip the offending entry with a
 * console.warn + optional trace event. Other entries continue to work.
 *
 * The trace event helper is injected (rather than imported) to keep the
 * runtime-trace module out of this module's load graph — that module
 * transitively pulls SillyTavern's `public/lib.js` bundle, which doesn't
 * exist under jest. Every caller (loop/spec/agenda/director runtime)
 * already imports `recordOrchestrationRuntimeEvent` and passes it in.
 */

const AsyncFunction = (async () => {}).constructor;

export function buildPerRunCustomToolRegistry(profile, trace, recordEvent = null) {
    const out = new Map();
    const entries = Array.isArray(profile?.customTools) ? profile.customTools : [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        try {
            const exec = new AsyncFunction('args', 'ctx', String(entry.body || ''));
            const simulateSource = String(entry.simulateBody || '');
            const simulate = simulateSource
                ? new AsyncFunction('args', 'ctx', simulateSource)
                : null;
            out.set(entry.name, {
                exec,
                simulate,
                mode: entry.mode === 'read' ? 'read' : 'write',
                source: 'profile',
                displayName: String(entry.displayName || ''),
                schema: {
                    type: 'function',
                    function: {
                        name: entry.name,
                        description: String(entry.description || ''),
                        parameters: entry.parameters && typeof entry.parameters === 'object'
                            ? entry.parameters
                            : { type: 'object' },
                    },
                },
            });
        } catch (err) {
            console.warn(`[orchestrator] custom tool '${entry.name}' compile failed:`, err);
            if (trace && typeof recordEvent === 'function') {
                recordEvent(trace, 'custom_tool_compile_failed', {
                    name: String(entry.name || ''),
                    error: String(err?.message || err),
                });
            }
        }
    }
    return out;
}
