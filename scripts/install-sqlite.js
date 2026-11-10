#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { spawnSync } from 'node:child_process';

const env = { ...process.env };

// Node's Android build config references android_ndk_path in common.gypi.
// node-gyp does not define it, so supply an empty value before invoking gyp.
if (process.platform === 'android') {
    const define = "android_ndk_path=''";
    env.GYP_DEFINES = env.GYP_DEFINES ? `${env.GYP_DEFINES} ${define}` : define;
    console.log('Android detected: setting GYP_DEFINES for node-gyp');
}

const result = spawnSync('npm', ['rebuild', 'better-sqlite3', '--ignore-scripts=false'], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
});

if (result.error) {
    console.error(result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 1);
