export function logEngineError(engineKind, op, handle, err, meta = {}) {
    const code = err?.code ?? err?.name ?? 'UnknownError';
    const message = err?.message ?? String(err);
    const line = `[storage:${engineKind}] op=${op} handle=${handle ?? '-'} err=${code}: ${message}`;
    const metaIsEmpty = !meta || Object.keys(meta).length === 0;
    if (metaIsEmpty) {
        console.error(line);
    } else {
        console.error(line, meta);
    }
}
