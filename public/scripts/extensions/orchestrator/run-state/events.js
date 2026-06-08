// public/scripts/extensions/orchestrator/run-state/events.js
/**
 * Event type constants emitted by the RunStateStore.
 * Listeners subscribe to a single 'event' channel and discriminate on `type`.
 */

export const RUN_STARTED = 'run_started';
export const ROUND_APPENDED = 'round_appended';
export const SECTION_ENSURED = 'section_ensured';
export const SECTION_APPENDED = 'section_appended';
export const SECTION_STATUS = 'section_status';
export const ROUND_STATUS = 'round_status';
export const RUN_META = 'run_meta';
export const RUN_FINISHED = 'run_finished';
export const RUN_CLEARED = 'run_cleared';

export const ALL_EVENT_TYPES = Object.freeze([
    RUN_STARTED, ROUND_APPENDED, SECTION_ENSURED, SECTION_APPENDED,
    SECTION_STATUS, ROUND_STATUS, RUN_META, RUN_FINISHED, RUN_CLEARED,
]);
