// Backwards-compat shim. The iteration-studio tool-calling helper was moved
// to public/scripts/lib/iter-tool-calling.js so the shell no longer imports
// from extensions/orchestrator/. See SP-5
// (docs/superpowers/specs/2026-05-22-iter-shell-contract-surgery.md).
export * from '../../lib/iter-tool-calling.js';
