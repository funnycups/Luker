import fs from 'node:fs';
import path from 'node:path';
import getPublicLibConfig from '../../webpack.config.js';

// Pre-built bundles shipped by the packager (Android APK, etc.) skip the
// in-process Webpack compile entirely. The directory must contain the three
// entry bundles listed below; any missing file falls back to the normal
// compile path so a partial bundle ship never silently serves a stale lib.
const PREBUILT_BUNDLE_FILES = ['lib.core.bundle.js', 'lib.optional.bundle.js', 'codemirror.bundle.js'];

// Resolved once at module load: LUKER_PREBUILT_BUNDLES_DIR is set by the
// packager before server.js is imported and never changes at runtime. Caching
// avoids 4 fs.existsSync syscalls per bundle request on slow Android flash.
const prebuiltBundleDir = (() => {
    const raw = process.env.LUKER_PREBUILT_BUNDLES_DIR;
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (!fs.existsSync(trimmed)) return null;
    const allPresent = PREBUILT_BUNDLE_FILES.every((name) => fs.existsSync(path.join(trimmed, name)));
    return allPresent ? trimmed : null;
})();

export default function getWebpackServeMiddleware() {
    /**
     * A very spartan recreation of webpack-dev-middleware.
     * @param {import('express').Request} req Request object.
     * @param {import('express').Response} res Response object.
     * @param {import('express').NextFunction} next Next function.
     * @type {import('express').RequestHandler}
     */
    function devMiddleware(req, res, next) {
        const parsedPath = path.parse(req.path);
        const requestedFile = parsedPath.base;

        if (req.method === 'GET' && parsedPath.dir === '/' && PREBUILT_BUNDLE_FILES.includes(requestedFile)) {
            if (prebuiltBundleDir) {
                return res.sendFile(requestedFile, { root: prebuiltBundleDir });
            }
        }

        const publicLibConfig = getPublicLibConfig();
        const outputPath = publicLibConfig.output?.path;
        const outputFiles = new Set(Object.keys(publicLibConfig.entry || {}).map((entryName) => `${entryName}.js`));
        const requestedPath = outputPath && requestedFile
            ? path.join(outputPath, requestedFile)
            : null;

        if (req.method === 'GET' && parsedPath.dir === '/' && outputFiles.has(requestedFile) && requestedPath && fs.existsSync(requestedPath)) {
            return res.sendFile(requestedFile, { root: outputPath });
        }

        next();
    }

    /**
     * Wait until Webpack is done compiling.
     * @param {object} param Parameters.
     * @param {boolean} [param.forceDist=false] Whether to force the use the /dist folder.
     * @param {boolean} [param.pruneCache=false] Whether to prune old cache directories before compiling.
     * @returns {Promise<void>}
     */
    devMiddleware.runWebpackCompiler = async ({ forceDist = false, pruneCache = false } = {}) => {
        if (prebuiltBundleDir) {
            console.log();
            console.log(`Using pre-built frontend bundles from ${prebuiltBundleDir}`);
            return;
        }

        console.log();
        console.log('Compiling frontend libraries...');

        // Webpack pulls in ~7 MB of code at parse time. Defer to here so Node
        // startup on platforms that always run pre-built bundles (e.g. the
        // Android APK) never pays for it. Pair with webpack.config.js reading
        // webpack's version from its package.json instead of importing webpack.
        const { default: webpack } = await import('webpack');
        const publicLibConfig = getPublicLibConfig({ forceDist, pruneCache });
        const compiler = webpack(publicLibConfig);

        return new Promise((resolve) => {
            compiler.run((_error, stats) => {
                const output = stats?.toString(publicLibConfig.stats);
                if (output) {
                    console.log(output);
                    console.log();
                }
                compiler.close(() => {
                    resolve();
                });
            });
        });
    };

    return devMiddleware;
}
