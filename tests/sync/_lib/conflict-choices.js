import { readPendingState } from '../../../src/sync/pipeline/pending-status.js';

export function reviewedChoice(entry, choice) {
    return { path: entry.path, choice, review: {
        backendId: entry.backendId,
        selectedOid: choice === 'current' ? entry.current : entry[choice],
        recordVersions: { ...entry.recordVersions },
        currentVersions: { ...entry.currentVersions },
    } };
}

export async function reviewedChoices(contexts, choices) {
    const { conflicts } = await readPendingState(contexts);
    return choices.map(({ path, choice }) => reviewedChoice(conflicts.find(entry => entry.path === path), choice));
}
