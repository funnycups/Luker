module.exports = {
    root: true,
    extends: [
        'eslint:recommended',
    ],
    env: {
        es2021: true,
        node: true,
        browser: true,
        jquery: true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
    },
    overrides: [
        {
            // Jest-run files: the unit suite (`jest.config.json` testMatch
            // `**/*.test.js`) plus its shared setup. `frontend/` and
            // `skills-ui/playwright/` are excluded here because Playwright
            // owns those runners — see the override below.
            files: [
                '**/*.test.js',
                'jest.setup.js',
            ],
            excludedFiles: [
                'frontend/**',
                'skills-ui/playwright/**',
            ],
            plugins: [
                'jest',
            ],
            extends: [
                'plugin:jest/recommended',
            ],
            env: {
                'jest/globals': true,
            },
            rules: {
                // The storage / sync parity suites branch on the
                // `describe.each` parameter (engine mode, platform) inside
                // test bodies. That branch is constant for the whole suite,
                // so the rule's "hidden assertion" hazard does not apply;
                // keep it visible as a warning instead of rewriting every
                // parameterized suite.
                'jest/no-conditional-expect': 'warn',

                // `platformSpecific` / `posixTest` are local wrappers around
                // `test` in the permission-sensitive suites. Register them so
                // expects inside them count as being inside a test block.
                'jest/no-standalone-expect': ['error', {
                    additionalTestBlockFunctions: ['platformSpecific', 'posixTest'],
                }],
            },
        },
        {
            // Playwright-run files: the black-box e2e suite, the frontend +
            // skills-ui integration projects, and the shared `_lib` helpers
            // they call. Specs run in a real browser context and routinely
            // call `page.evaluate(() => window.X)` / `document.X`, hence the
            // `browser` env inherited from the base config.
            files: [
                'e2e/**/*.e2e.js',
                'e2e/_lib/**/*.js',
                'frontend/**/*.e2e.js',
                'frontend/**/*.test.js',
                'skills-ui/playwright/**/*.spec.js',
                'skills-ui/playwright/helpers.js',
                'sample.e2e.js',
            ],
            plugins: [
                'playwright',
            ],
            extends: [
                'plugin:playwright/recommended',
            ],
        },
        {
            // Auto-derived export-name tables (generated from the real
            // module export surface) — plain string arrays, not hand-written
            // code. Keep the generator's two-space / double-quote shape out
            // of the repo formatting rules.
            files: [
                'bookmarks/_mocks/script-exports.js',
                'bookmarks/_mocks/group-chats-exports.js',
            ],
            rules: {
                'indent': ['error', 2],
                'quotes': ['error', 'double'],
            },
        },
    ],
    ignorePatterns: [
        '*.min.js',
        'node_modules/**/*',
    ],
    globals: {
        Luker: 'readonly',
        SillyTavern: 'readonly',
    },
    rules: {
        'no-unused-vars': ['error', { args: 'none' }],
        'no-control-regex': 'off',
        'no-constant-condition': ['error', { checkLoops: false }],
        'require-yield': 'off',
        'quotes': ['error', 'single'],
        'semi': ['error', 'always'],
        'indent': ['error', 4, { SwitchCase: 1, FunctionDeclaration: { parameters: 'first' } }],
        'comma-dangle': ['error', 'always-multiline'],
        'eol-last': ['error', 'always'],
        'no-trailing-spaces': 'error',
        'object-curly-spacing': ['error', 'always'],
        'space-infix-ops': 'error',
        'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
        'no-cond-assign': 'error',

        // These rules should eventually be enabled.
        'no-async-promise-executor': 'off',
        'no-inner-declarations': 'off',
    },
    settings: {
        jest: {
            version: 29,
        },
    },
};
