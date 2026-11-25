import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../frontend.js';

const input = JSON.parse(process.env.BROWSER_LIFECYCLE_INPUT);
const modes = input.mode === 'frontend-retry' ? ['retry'] : input.mode === 'frontend-failure' ? ['failure'] : input.mode === 'frontend-cancel' ? ['cancel'] : ['write', 'observe'];

for (const mode of modes) test(`selected frontend ${mode}`, async ({ frontendApplication, page }, info) => {
    await page.goto('/');
    await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);
    await expect(page.locator('#send_textarea')).toBeVisible();
    const settings = JSON.parse(fs.readFileSync(path.join(frontendApplication.dataRoot, 'default-user/settings.json'), 'utf8'));
    const receipt = { ...frontendApplication, frontendDebugLogging: settings.power_user.frontend_debug_logging, workerIndex: info.workerIndex, runtime: { version: process.version, execPath: process.execPath } };
    fs.writeFileSync(path.join(input.root, `frontend-${mode}-${info.workerIndex}-${info.retry}.json`), JSON.stringify(receipt));
    const marker = path.join(frontendApplication.dataRoot, 'project-state.json');
    if (mode === 'write' || mode === 'retry' && info.retry === 0) fs.writeFileSync(marker, JSON.stringify({ pid: frontendApplication.pid, text: 'native frontend 世界🌍' }));
    if (input.mode === 'frontend-shared' && mode === 'observe' || mode === 'retry' && info.retry > 0) expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ pid: frontendApplication.pid, text: 'native frontend 世界🌍' });
    if (mode === 'retry' && info.retry === 0) throw new Error('actual frontend worker retry with retained project state');
    if (mode === 'failure') throw new Error('actual frontend failure with project-owned state');
    if (mode === 'cancel') { console.log('FRONTEND_LIFECYCLE_READY'); await new Promise(() => {}); }
});
