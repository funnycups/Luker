import { setupRuntime } from './playwright-runtime.js';

export default async function setup(config) { await setupRuntime(config); }
