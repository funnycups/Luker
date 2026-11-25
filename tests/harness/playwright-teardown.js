import { finishNativeDispatch } from './playwright-runtime.js';

export default async function teardown() { finishNativeDispatch(); }
