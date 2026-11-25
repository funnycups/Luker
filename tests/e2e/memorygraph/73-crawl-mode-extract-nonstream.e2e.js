// tests/e2e/memorygraph/73-crawl-mode-extract-nonstream.e2e.js
//
// #73 — #67's crawl extraction flow with the preset's streaming off, so
// every crawl and extraction request takes the non-streaming transport.
// Flow and assertions live in ./_crawl-extract-scenario.js.

import { defineCrawlExtractScenario } from './_crawl-extract-scenario.js';

defineCrawlExtractScenario({
    title: '#73 — crawl extraction over non-streaming transport',
    scenarioId: 'crawl-extract-nonstream',
    stream: false,
});
