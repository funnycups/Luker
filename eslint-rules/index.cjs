// eslint-plugin-luker — registry of Luker-internal ESLint rules.
const noRawFsInEndpoint = require('./no-raw-fs-in-endpoint.cjs');

module.exports = {
    rules: {
        'no-raw-fs-in-endpoint': noRawFsInEndpoint,
    },
};
