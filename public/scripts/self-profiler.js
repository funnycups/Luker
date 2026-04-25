// @ts-nocheck

const STORAGE_KEY = 'luker.selfProfilingEnabled';
const GLOBAL_STATE_KEY = '__lukerSelfProfilerState';
const DEFAULT_SAMPLE_INTERVAL = 10;
const DEFAULT_MAX_BUFFER_SIZE = 50000;

function getGlobalState() {
    if (!globalThis[GLOBAL_STATE_KEY]) {
        globalThis[GLOBAL_STATE_KEY] = {
            profiler: null,
            sampleInterval: DEFAULT_SAMPLE_INTERVAL,
            maxBufferSize: DEFAULT_MAX_BUFFER_SIZE,
            bufferFull: false,
            startedAt: 0,
            startedAtIso: '',
        };
    }

    return globalThis[GLOBAL_STATE_KEY];
}

export function isSelfProfilerSupported() {
    return typeof globalThis.Profiler === 'function';
}

export function getSelfProfilerPreference() {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

export function setSelfProfilerPreference(enabled) {
    try {
        localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    } catch {
        // Ignore storage failures.
    }
}

function createProfiler() {
    const state = getGlobalState();

    const profiler = new Profiler({
        sampleInterval: state.sampleInterval,
        maxBufferSize: state.maxBufferSize,
    });

    profiler.addEventListener('samplebufferfull', () => {
        const activeState = getGlobalState();
        activeState.bufferFull = true;
    });

    return profiler;
}

export function startSelfProfiler() {
    const state = getGlobalState();

    if (!isSelfProfilerSupported()) {
        return false;
    }

    if (state.profiler && !state.profiler.stopped) {
        return true;
    }

    try {
        state.profiler = createProfiler();
        state.bufferFull = false;
        state.startedAt = performance.now();
        state.startedAtIso = new Date().toISOString();
        return true;
    } catch (error) {
        console.warn('Failed to start JS Self-Profiling session', error);
        state.profiler = null;
        return false;
    }
}

export async function stopSelfProfiler() {
    const state = getGlobalState();
    const profiler = state.profiler;

    if (!profiler) {
        return null;
    }

    if (profiler.stopped) {
        state.profiler = null;
        return null;
    }

    try {
        const trace = await profiler.stop();
        state.profiler = null;
        return trace;
    } catch (error) {
        console.warn('Failed to stop JS Self-Profiling session', error);
        state.profiler = null;
        return null;
    }
}

export function bootSelfProfilerFromStorage() {
    if (!getSelfProfilerPreference()) {
        return false;
    }

    return startSelfProfiler();
}

function collectPerformanceContext() {
    const navigation = performance.getEntriesByType('navigation')?.[0] ?? null;
    const paints = performance.getEntriesByType('paint') ?? [];

    return {
        navigation,
        paints,
    };
}

function buildReport(trace, state) {
    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        runtime: {
            userAgent: navigator.userAgent,
            location: globalThis.location?.href ?? '',
            language: navigator.language,
        },
        profiler: {
            sampleInterval: state.sampleInterval,
            maxBufferSize: state.maxBufferSize,
            startedAtIso: state.startedAtIso,
            durationMs: state.startedAt > 0 ? Math.max(0, performance.now() - state.startedAt) : 0,
            bufferFull: state.bufferFull,
            supported: isSelfProfilerSupported(),
        },
        webPerformance: collectPerformanceContext(),
        trace,
    };
}

function downloadJsonFile(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

export async function downloadCurrentSelfProfileReport({ restartAfterDownload = true } = {}) {
    const state = getGlobalState();

    if (!isSelfProfilerSupported()) {
        throw new Error('JS Self-Profiling API is not supported in this browser.');
    }

    if (!state.profiler || state.profiler.stopped) {
        throw new Error('Profiler is not running.');
    }

    const trace = await stopSelfProfiler();
    if (!trace) {
        throw new Error('Failed to collect profile trace.');
    }

    const report = buildReport(trace, state);
    const date = new Date().toISOString().replace(/[.:]/g, '-');
    downloadJsonFile(`luker-self-profile-${date}.json`, report);

    if (restartAfterDownload && getSelfProfilerPreference()) {
        startSelfProfiler();
    }

    return report;
}

export async function syncSelfProfilerEnabled(enabled) {
    if (!enabled) {
        await stopSelfProfiler();
        return;
    }

    startSelfProfiler();
}
