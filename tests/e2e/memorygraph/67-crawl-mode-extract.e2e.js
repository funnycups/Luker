// tests/e2e/memorygraph/67-crawl-mode-extract.e2e.js
//
// #67 — crawl extraction mode explores before extracting, with the preset's
// streaming on. Flow and assertions live in ./_crawl-extract-scenario.js;
// #73 runs the same scenario with streaming off.

import { defineCrawlExtractScenario } from './_crawl-extract-scenario.js';

defineCrawlExtractScenario({
    title: '#67 — crawl extraction mode explores before extracting',
    scenarioId: 'crawl-extract',
    stream: true,
});
