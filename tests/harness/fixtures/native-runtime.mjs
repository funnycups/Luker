import assert from 'node:assert/strict';
import fs from 'node:fs';

export function nativeSource(source, receipt) {
    return `import { writeFileSync as writeNativeRuntimeReceipt } from 'node:fs';
writeNativeRuntimeReceipt(${JSON.stringify(receipt)}, JSON.stringify({ version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch }));
${source}`;
}

export function nativeRuntime(receipt) {
    const runtime = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.deepEqual(runtime, { version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch });
    return runtime;
}
