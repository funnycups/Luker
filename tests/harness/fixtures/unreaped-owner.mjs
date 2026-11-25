import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRun } from '../resources/run.js';

const [mode, projectRoot] = process.argv.slice(2);

if (mode === 'holder') {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'owner', projectRoot], {
        stdio: [3, 'pipe', 'inherit'],
    });
    const exited = once(child, 'close');
    const [receipt] = await once(child.stdout, 'data');
    fs.writeSync(1, receipt);
    // Keep the real parent's event loop outside waitpid until the test releases it.
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    await exited;
} else {
    const run = await createRun({
        projectRoot,
        profile: 'unit',
        source: 'unreaped native owner',
        command: [process.execPath, ...process.argv.slice(1)],
    });
    const scope = await run.scope({ kind: 'case', label: 'unreaped owner data' });
    const data = await scope.directory('scenario');
    fs.writeSync(1, JSON.stringify({ runId: run.runId, registryPath: run.registryPath, data: data.path, owner: run.registry.owner }) + '\n');
    await once(process.stdin, 'data');
    process.exit(0);
}
