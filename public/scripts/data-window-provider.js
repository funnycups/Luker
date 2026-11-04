// Live data source for the Data window: the sync source and the backup source share one snapshot.
import { createSyncSource } from './data-window-sync.js';
import { createBackupSource } from './data-window-backup.js';

/**
 * Creates the provider the Data window reads from and acts through.
 * @param {object} [options]
 * @param {string} [options.handle] User whose data backup/restore/migration acts on
 * @returns {object} Provider with subscribe/snapshot, start/stop and every action the window calls
 */
export function createLukerProvider({ handle } = {}) {
    const listeners = new Set();
    const emit = () => listeners.forEach(fn => fn());
    const state = {
        available: true,
        unavailableReason: '',
        statusError: false,
        listError: false,
        device: { label: '', placeholder: '' },
        schedule: { idle: 60, poll: 300 },
        syncCategories: [],
        backends: [],
        conflicts: [],
        notices: [],
    };
    const backup = createBackupSource(state, emit, { handle });
    const sync = createSyncSource(state, emit);

    return {
        ...backup,
        ...sync,
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        snapshot() {
            return state;
        },
        start() {
            sync.start();
            backup.start();
        },
        stop() {
            sync.stop();
            backup.stop();
        },
    };
}
