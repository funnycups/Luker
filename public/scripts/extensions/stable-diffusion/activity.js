/**
 * Image generation activity: the capsule shown while any image job runs and
 * the shared run panel opened from it. One round per job; each round holds
 * the prompt and the generated image (or the failure reason).
 */
import { createRunStore, createRunPanel } from '/scripts/run-panel/index.js';

export const IMAGE_ACTIVITY_MODE = 'image';

const identity = text => String(text);

function substitute(translate, text, values) {
    return String(translate(String(text)) ?? text).replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}

function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatImageActivityPill(run, translate = identity, { acknowledged = false, retryStates = null } = {}) {
    const active = run?.rounds?.filter(round => round.status === 'running') ?? [];
    if (active.length > 0) {
        const oldest = active.reduce((earliest, round) => Math.min(earliest, round.startedAt), Infinity);
        const retrying = active.find(round => retryStates?.has(round.id));
        if (retrying) {
            const { attempt, maxRetries } = retryStates.get(retrying.id);
            return {
                visible: true,
                text: substitute(translate, 'Retrying · ${0}/${1}', [attempt, maxRetries]),
                tone: 'attention',
                loading: true,
                detail: formatElapsed(performance.now() - oldest),
            };
        }
        const generatingImage = active.some(round => round.sections.length > 0);
        const label = translate(generatingImage ? 'Generating image' : 'Generating prompt');
        return {
            visible: true,
            text: active.length > 1 ? `${label} · ${active.length}` : label,
            tone: 'running',
            loading: true,
            detail: formatElapsed(performance.now() - oldest),
        };
    }
    const failed = run?.rounds?.filter(round => round.status === 'failed').length ?? 0;
    if (failed > 0 && !acknowledged) {
        const label = translate('Image generation failed');
        return {
            visible: true,
            text: failed > 1 ? `${label} · ${failed}` : label,
            tone: 'error',
            loading: false,
            detail: '',
        };
    }
    return { visible: false, text: '', tone: 'running', loading: false, detail: '' };
}

export function formatImageActivitySummary(run, translate = identity) {
    const total = run?.rounds?.length ?? 0;
    const failed = run?.rounds?.filter(round => round.status === 'failed').length ?? 0;
    return failed > 0
        ? substitute(translate, 'Tasks: ${0} · ${1} failed', [total, failed])
        : substitute(translate, 'Tasks: ${0}', [total]);
}

/**
 * Build an isolated image-activity tracker and its run panel.
 * @param {{ translate?: Function, getChatKey?: () => string|null }} [options]
 */
export function createImageActivity({ translate = identity, getChatKey = () => null } = {}) {
    const store = createRunStore();
    const activeJobs = new Map();
    const retryStates = new Map();
    let acknowledged = false;
    let jobCounter = 0;
    let generationCounter = 0;
    let runId = null;
    const format = (text, ...values) => substitute(translate, text, values);

    function closeRunningSections(run, roundId, status) {
        if (!run || run.runId !== runId) return;
        const round = run.rounds.find(candidate => candidate.id === roundId);
        for (const section of round?.sections ?? []) {
            if (section.status === 'running') {
                store.setSectionStatus({ runId: run.runId, roundId, sectionId: section.id, status });
            }
        }
    }

    function abortAll() {
        const run = store.getCurrentRun();
        if (!run || run.status !== 'running') return;
        for (const [roundId, entry] of [...activeJobs]) {
            closeRunningSections(run, roundId, 'aborted');
            store.setRoundStatus({ runId: run.runId, roundId, status: 'aborted' });
            activeJobs.delete(roundId);
            try { entry.abort?.(); } catch (error) { console.error('[sd] cannot abort image job', error); }
        }
        const latest = store.getCurrentRun();
        if (latest && latest.runId === run.runId) {
            const failed = latest.rounds.some(round => round.status === 'failed');
            store.finishRun({ runId: run.runId, status: failed ? 'error' : 'aborted' });
        }
    }

    const panel = createRunPanel({
        store,
        t: format,
        idPrefix: 'luker-sd-run-panel',
        autoOpen: false,
        pillOnStart: true,
        pillFormatter: run => formatImageActivityPill(run, translate, { acknowledged, retryStates }),
        summaryFormatter: run => formatImageActivitySummary(run, translate),
        modeLabels: { [IMAGE_ACTIVITY_MODE]: format('Image Generation') },
        emptyStateText: format('No image generation yet.'),
        kindIcons: { prompt: '💬', image: '🖼️', error: '⚠️' },
        keepOpenKinds: ['prompt', 'image', 'error'],
        autoCollapseRounds: false,
        exportFilename: ({ runId: id }) => `image-generation-${id}.json`,
        onStop: () => abortAll(),
        onOpen: () => { acknowledged = true; },
    });
    panel.init();

    function ensureRun() {
        const running = store.getCurrentRun();
        if (running && running.status === 'running') return running.runId;
        jobCounter = 0;
        generationCounter = 0;
        acknowledged = false;
        retryStates.clear();
        runId = store.startRun({ mode: IMAGE_ACTIVITY_MODE, chatKey: getChatKey(), stopFn: abortAll });
        return runId;
    }

    /**
     * @param {{ kind?: 'generation'|'illustration', messageIndex?: number, abort?: () => void }} [options]
     */
    function beginJob({ kind = 'generation', messageIndex = null, abort = null } = {}) {
        const activeRunId = ensureRun();
        jobCounter += 1;
        const roundId = `image-job-${jobCounter}`;
        let label;
        if (kind === 'illustration' && Number.isInteger(messageIndex)) {
            label = format('Message #${0}', messageIndex + 1);
        } else {
            generationCounter += 1;
            label = format('Generation #${0}', generationCounter);
        }
        store.appendRound({ runId: activeRunId, round: { id: roundId, label } });
        activeJobs.set(roundId, { abort });
        const sectionIds = new Map();

        const job = {
            id: roundId,
            addSection(key, { kind: sectionKind, title, body = '', meta = null }) {
                if (!activeJobs.has(roundId)) return null;
                if (sectionIds.has(key)) return sectionIds.get(key);
                const sectionId = `${roundId}-${key}`;
                store.ensureSection({ runId: activeRunId, roundId, section: { id: sectionId, kind: sectionKind, title, meta } });
                if (body) store.appendToSection({ runId: activeRunId, roundId, sectionId, delta: String(body) });
                sectionIds.set(key, sectionId);
                return sectionId;
            },
            updateSection(key, { status, meta } = {}) {
                if (!activeJobs.has(roundId)) return;
                const sectionId = sectionIds.get(key);
                if (!sectionId) return;
                store.setSectionStatus({ runId: activeRunId, roundId, sectionId, status, meta });
            },
            setPrompt(prompt) {
                job.addSection('prompt', { kind: 'prompt', title: format('Prompt'), body: prompt });
            },
            setImage(imageUrl) {
                job.addSection('image', { kind: 'image', title: format('Image'), meta: { imageUrl } });
                job.updateSection('image', { status: 'done' });
            },
            setError(message) {
                job.addSection('error', { kind: 'error', title: format('Error'), body: message });
                job.updateSection('error', { status: 'failed' });
            },
            setRetry(attempt, maxRetries) {
                if (!activeJobs.has(roundId)) return;
                retryStates.set(roundId, { attempt, maxRetries });
                panel.refreshPill();
            },
            finish(status = 'done') {
                if (!activeJobs.has(roundId)) return;
                activeJobs.delete(roundId);
                retryStates.delete(roundId);
                if (status !== 'done') closeRunningSections(store.getCurrentRun(), roundId, status);
                store.setRoundStatus({ runId: activeRunId, roundId, status });
                if (activeJobs.size > 0) return;
                const run = store.getCurrentRun();
                if (!run || run.runId !== activeRunId) return;
                const failed = run.rounds.some(round => round.status === 'failed');
                const aborted = run.rounds.some(round => round.status === 'aborted');
                store.finishRun({ runId: activeRunId, status: failed ? 'error' : aborted ? 'aborted' : 'committed' });
            },
        };
        return job;
    }

    return {
        store,
        beginJob,
        abortAll,
        openPanel: () => panel.open(),
        destroy: () => panel.destroy(),
    };
}

let defaultActivity = null;

export function initImageActivity(options) {
    if (!defaultActivity) defaultActivity = createImageActivity(options);
    return defaultActivity;
}

export function beginImageActivityJob(options) {
    return initImageActivity().beginJob(options);
}

export function openImageActivityPanel() {
    initImageActivity().openPanel();
}
