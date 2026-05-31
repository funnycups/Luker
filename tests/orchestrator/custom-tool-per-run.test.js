// tests/orchestrator/custom-tool-per-run.test.js
import { describe, test, expect, jest } from '@jest/globals';
import { buildPerRunCustomToolRegistry } from '../../public/scripts/extensions/orchestrator/per-run-custom-tools.js';

describe('buildPerRunCustomToolRegistry', () => {
    test('returns empty map when profile has no customTools', () => {
        expect(buildPerRunCustomToolRegistry({}, null).size).toBe(0);
        expect(buildPerRunCustomToolRegistry(null, null).size).toBe(0);
    });

    test('compiles a valid entry into an exec + schema', async () => {
        const profile = {
            customTools: [
                { name: 'echo', description: 'd', parameters: {}, mode: 'read', body: 'return { got: args.x };', simulateBody: '' },
            ],
        };
        const reg = buildPerRunCustomToolRegistry(profile, null);
        const entry = reg.get('echo');
        expect(entry.mode).toBe('read');
        expect(entry.source).toBe('profile');
        expect(entry.schema.function.name).toBe('echo');
        const result = await entry.exec({ x: 1 }, {});
        expect(result).toEqual({ got: 1 });
    });

    test('compiles simulateBody when present', async () => {
        const profile = {
            customTools: [
                { name: 'w', description: 'd', parameters: {}, mode: 'write',
                  body: 'throw new Error("nope");',
                  simulateBody: 'return { ok: true, simulated: true, value: args.v };' },
            ],
        };
        const reg = buildPerRunCustomToolRegistry(profile, null);
        const entry = reg.get('w');
        const result = await entry.simulate({ v: 7 }, {});
        expect(result).toEqual({ ok: true, simulated: true, value: 7 });
    });

    test('skips entries whose body fails to compile (warns + trace event)', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const trace = { events: [], nextEventSeq: 1, updatedAt: '' };
        // Stand-in for runtime-trace's `recordOrchestrationRuntimeEvent`,
        // which the runtime callers inject. Mirrors the canonical helper's
        // shape: pushes `{ seq, at, type, ...details }` and advances seq /
        // updatedAt.
        const recordEvent = (t, type, details) => {
            const event = { seq: Number(t.nextEventSeq || 1), at: new Date().toISOString(), type: String(type), ...details };
            t.events.push(event);
            t.nextEventSeq = event.seq + 1;
            t.updatedAt = event.at;
        };
        const profile = {
            customTools: [
                { name: 'good', description: 'd', parameters: {}, mode: 'read', body: 'return 1;', simulateBody: '' },
                { name: 'bad', description: 'd', parameters: {}, mode: 'read', body: 'this is not js)))', simulateBody: '' },
            ],
        };
        const reg = buildPerRunCustomToolRegistry(profile, trace, recordEvent);
        expect(reg.has('good')).toBe(true);
        expect(reg.has('bad')).toBe(false);
        expect(trace.events.find(e => e.type === 'custom_tool_compile_failed' && e.name === 'bad')).toBeTruthy();
        expect(trace.updatedAt).not.toBe('');
        warnSpy.mockRestore();
    });

    test('compile failure without recordEvent is tolerated (no throw, no event)', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const trace = { events: [], nextEventSeq: 1 };
        const profile = {
            customTools: [
                { name: 'bad', description: 'd', parameters: {}, mode: 'read', body: '!!!', simulateBody: '' },
            ],
        };
        expect(() => buildPerRunCustomToolRegistry(profile, trace, null)).not.toThrow();
        expect(trace.events).toHaveLength(0);
        warnSpy.mockRestore();
    });

    test('simulate is null when simulateBody is empty/missing', () => {
        const profile = {
            customTools: [
                { name: 'a', description: 'd', parameters: {}, mode: 'write', body: 'return {};', simulateBody: '' },
            ],
        };
        const reg = buildPerRunCustomToolRegistry(profile, null);
        expect(reg.get('a').simulate).toBeNull();
    });

    test('trace=null is tolerated (no throw)', () => {
        const profile = {
            customTools: [
                { name: 'bad', description: 'd', parameters: {}, mode: 'read', body: '!!!', simulateBody: '' },
            ],
        };
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => buildPerRunCustomToolRegistry(profile, null)).not.toThrow();
        warnSpy.mockRestore();
    });
});
