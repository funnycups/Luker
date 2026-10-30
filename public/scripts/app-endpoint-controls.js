const APP_BRIDGES = [
    { name: 'LukerAndroid', kind: 'android' },
    { name: 'LukerHarmony', kind: 'harmony' },
    { name: 'LukerIOS', kind: 'ios' },
    { name: 'LukerDesktop', kind: 'desktop' },
];

/**
 * Finds the native app bridge exposed on the window object.
 * @param {Window|object} win Window-like object to inspect.
 * @returns {{ kind: string, bridge: object } | null} Detected bridge, or null when running in a plain browser.
 */
export function detectAppBridge(win = window) {
    for (const { name, kind } of APP_BRIDGES) {
        const bridge = win[name];
        if (bridge) {
            return { kind, bridge };
        }
    }
    return null;
}

/**
 * Shows the app-only refresh and endpoint entries in the user settings drawer.
 * @param {{ win?: Window|object, doc?: Document }} options Window and document to operate on.
 * @returns {{ kind: string, bridge: object } | null} Detected bridge, or null when running in a plain browser.
 */
export function initAppEndpointControls({ win = window, doc = document } = {}) {
    const detected = detectAppBridge(win);
    if (!detected) {
        return null;
    }

    const { kind, bridge } = detected;

    const reloadButton = doc.getElementById('app_reload_button');
    if (reloadButton) {
        reloadButton.style.display = '';
        reloadButton.addEventListener('click', () => {
            if (typeof bridge.reloadWebView === 'function') {
                bridge.reloadWebView();
            } else {
                win.location.reload();
            }
        });
    }

    if (kind !== 'desktop' && typeof bridge.openEndpointSettings === 'function') {
        const endpointButton = doc.getElementById('app_endpoint_button');
        if (endpointButton) {
            endpointButton.style.display = '';
            endpointButton.addEventListener('click', () => {
                bridge.openEndpointSettings();
            });
        }
    }

    return detected;
}
