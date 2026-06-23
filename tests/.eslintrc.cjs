module.exports = {
    root: true,
    plugins: [
        'jest',
        'playwright',
    ],
    extends: [
        'eslint:recommended',
        'plugin:jest/recommended',
        'plugin:playwright/recommended',
    ],
    env: {
        es6: true,
        node: true,
        'jest/globals': true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
    },
    overrides: [
        {
            // Playwright-driven e2e specs run inside a real browser context
            // and routinely call `page.evaluate(() => window.X)` — so they
            // need the `browser` env globals to lint cleanly. Matches both
            // the legacy `*.e2e.js` files, the skills-UI smoke `*.spec.js`
            // files added in Plan 2 Unit 8, and the `_lib/*.js` Playwright
            // helpers (page.js, sync.js) that wrap `page.evaluate(() =>
            // document.X)` for spec callers.
            files: [
                '**/*.e2e.js',
                '**/skills-ui/playwright/**/*.spec.js',
                '**/skills-ui/playwright/helpers.js',
                'e2e/_lib/*.js',
            ],
            env: {
                browser: true,
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
