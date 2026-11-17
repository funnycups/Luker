import { IS_MOBILE_RUNTIME } from './runtime-capabilities.js';

/**
 * @param {{ enabled: boolean, url: string | URL, browser?: string }} options
 * @returns {Promise<{ launched: boolean, skippedMobile: boolean }>}
 */
export async function maybeLaunchBrowser({ enabled, url, browser = 'default' }) {
    if (!enabled) {
        return { launched: false, skippedMobile: false };
    }

    if (IS_MOBILE_RUNTIME) {
        console.log('Skipping automatic browser launch on mobile runtime.');
        return { launched: false, skippedMobile: true };
    }

    try {
        const openModule = await import('open');
        const { default: open, apps } = openModule;

        const validBrowsers = {
            firefox: apps.firefox,
            chrome: apps.chrome,
            edge: apps.edge,
            brave: apps.brave,
        };

        const appName = validBrowsers[String(browser ?? '').trim().toLowerCase()];
        const openOptions = appName ? { app: { name: appName } } : {};

        console.log(`Launching in a browser: ${browser}...`);
        const subprocess = await open(String(url), openOptions);
        subprocess?.on?.('error', (error) => {
            console.error('Failed to launch the browser. Open the URL manually.', error);
        });
        return { launched: true, skippedMobile: false };
    } catch (error) {
        console.error('Failed to launch the browser. Open the URL manually.', error);
        return { launched: false, skippedMobile: false };
    }
}
