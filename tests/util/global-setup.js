import { fileURLToPath } from 'node:url';
import { recoverBeforeRun } from '../harness/startup.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

export default async function globalSetup(_globalConfig, projectConfig) {
    const profile = projectConfig.displayName?.name ?? process.env.LUKER_TEST_PROFILE ?? 'unit';
    const projectRoot = projectConfig.testEnvironmentOptions.resourceProjectRoot ?? repository;
    await recoverBeforeRun({ projectRoot, profiles: [profile] });
}
