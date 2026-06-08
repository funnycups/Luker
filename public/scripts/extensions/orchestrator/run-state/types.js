// public/scripts/extensions/orchestrator/run-state/types.js
/**
 * @typedef {'director'|'loop'|'agenda'|'spec'} RunMode
 * @typedef {'running'|'committed'|'aborted'|'error'} RunStatus
 * @typedef {'running'|'done'|'failed'} StepStatus
 * @typedef {'reasoning'|'text'|'tool_call'|'tool_result'|'sub_agent'|'note'|'messages_dump'} SectionKind
 */

/**
 * @typedef {Object} TokensSpent
 * @property {number} prompt
 * @property {number} completion
 * @property {number} total
 */

/**
 * @typedef {Object} Section
 * @property {string} id
 * @property {SectionKind} kind
 * @property {string} title
 * @property {StepStatus} status
 * @property {string} body
 * @property {Object|null} meta
 */

/**
 * @typedef {Object} Round
 * @property {string} id
 * @property {string} label
 * @property {StepStatus} status
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {Section[]} sections
 */

/**
 * @typedef {Object} RunState
 * @property {string} runId
 * @property {RunMode} mode
 * @property {RunStatus} status
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {string|null} chatKey
 * @property {Round[]} rounds
 * @property {string|null} finalText
 * @property {string|null} error
 * @property {TokensSpent|null} tokensSpent
 * @property {number|null} cost
 * @property {(() => void)|null} abortFn
 */

export {};
