// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from '@jest/globals';
import { appendGenerationEvent } from '../src/endpoints/backends/luker-generation.js';

describe('generation event retention', () => {
    test.each([false, true])('private=%s retains events according to its lifecycle', isPrivate => {
        const job = {
            id: 'event-retention',
            events: [],
            lastSeq: 0,
            text: '',
            requestMeta: { api: 'custom' },
            ...(isPrivate ? { transientSessionId: 'owned-attempt' } : {}),
        };
        // Cross the existing ordinary recovery limit of 8000 envelopes.
        for (let sequence = 1; sequence <= 8001; sequence++) {
            appendGenerationEvent(job, { kind: 'chunk', data: `event-${sequence}` });
        }
        expect(job.lastSeq).toBe(8001);
        expect(job.events).toHaveLength(isPrivate ? 8001 : 8000);
        expect(job.events[0]).toMatchObject({ seq: isPrivate ? 1 : 2 });
        expect(job.events.at(-1)).toMatchObject({ seq: 8001, data: { kind: 'chunk', data: 'event-8001' } });
    });
});
