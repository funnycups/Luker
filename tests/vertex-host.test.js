import { describe, expect, test } from '@jest/globals';

import { getVertexApiHost } from '../src/endpoints/vertex-host.js';

describe('Vertex AI API host resolution', () => {
    test('global and empty locations use the global host', () => {
        expect(getVertexApiHost('global')).toBe('https://aiplatform.googleapis.com');
        expect(getVertexApiHost('')).toBe('https://aiplatform.googleapis.com');
        expect(getVertexApiHost(undefined)).toBe('https://aiplatform.googleapis.com');
    });

    test('us and eu multi-regions use their rep hosts', () => {
        // https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations
        expect(getVertexApiHost('us')).toBe('https://aiplatform.us.rep.googleapis.com');
        expect(getVertexApiHost('eu')).toBe('https://aiplatform.eu.rep.googleapis.com');
    });

    test('single regions use the location-prefixed host', () => {
        expect(getVertexApiHost('us-central1')).toBe('https://us-central1-aiplatform.googleapis.com');
        expect(getVertexApiHost('europe-west2')).toBe('https://europe-west2-aiplatform.googleapis.com');
        expect(getVertexApiHost('asia-northeast1')).toBe('https://asia-northeast1-aiplatform.googleapis.com');
    });

    test('trims surrounding whitespace', () => {
        expect(getVertexApiHost(' eu ')).toBe('https://aiplatform.eu.rep.googleapis.com');
        expect(getVertexApiHost(' us-central1 ')).toBe('https://us-central1-aiplatform.googleapis.com');
    });
});
