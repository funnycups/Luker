// Backwards-compat shim. The iteration-studio tool-calling helper lives in
// public/scripts/lib/iter-tool-calling.js so the shell no longer imports from
// extensions/orchestrator/.
export * from '../../lib/iter-tool-calling.js';
