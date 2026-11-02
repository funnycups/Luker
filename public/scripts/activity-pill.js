/** Shared placement and activation ownership for compact activity buttons. */
// Stroke icons per state, drawn in the pill's tone color.
const ICONS = {
    loading: '<path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4"/>',
    attention: '<path d="M12 4 2.5 20h19zM12 10v4M12 17h.01"/>',
    error: '<path d="M6 6l12 12M18 6 6 18"/>',
    unknown: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
    done: '<path d="m5 12 5 5 9-10"/>',
};
let host = null;
let stylesheet = null;
const owners = new Set();

function updateHost() {
    host.hidden = ![...owners].some(element => !element.hidden);
}

export function createActivityPill({ id, className = '', onOpen, onError }) {
    if (!host) {
        stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = '/css/activity-pill.css';
        document.head.appendChild(stylesheet);
        host = document.createElement('div');
        host.className = 'activity-pill-host';
        host.hidden = true;
        document.body.appendChild(host);
    }
    const element = document.createElement('button');
    element.type = 'button';
    element.id = id;
    element.className = `activity-pill ${className}`.trim();
    element.hidden = true;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'activity-pill-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'activity-pill-label';
    // Secondary detail such as elapsed time; decorative, the label carries the meaning.
    const meta = document.createElement('span');
    meta.className = 'activity-pill-meta';
    meta.setAttribute('aria-hidden', 'true');
    meta.hidden = true;
    const progress = document.createElement('span');
    progress.className = 'activity-pill-progress';
    progress.setAttribute('role', 'progressbar');
    progress.hidden = true;
    element.append(icon, label, meta, progress);
    host.appendChild(element);
    owners.add(element);

    let activating = false;
    let destroyed = false;
    function activate() {
        if (activating || destroyed) return;
        activating = true;
        // Attach rejection observation in the same turn as activation, and
        // retain ownership until the caller's actual surface closes.
        Promise.resolve().then(() => {
            if (!destroyed) return onOpen();
        }).catch(onError).finally(() => { activating = false; });
    }
    element.addEventListener('click', activate);

    function update({ visible, text, tone, loading, detail = '' }) {
        if (destroyed) return;
        element.hidden = !visible;
        label.textContent = text;
        meta.textContent = detail;
        meta.hidden = !detail;
        element.title = text;
        element.setAttribute('aria-label', text);
        element.dataset.tone = tone;
        const iconName = loading ? 'loading' : ICONS[tone] ? tone : 'done';
        if (icon.dataset.name !== iconName) {
            icon.dataset.name = iconName;
            icon.innerHTML = ICONS[iconName];
        }
        icon.classList.toggle('activity-pill-spin', Boolean(loading));
        progress.hidden = !loading;
        progress.setAttribute('aria-label', text);
        updateHost();
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        element.removeEventListener('click', activate);
        element.remove();
        owners.delete(element);
        if (owners.size) updateHost();
        else {
            host.remove();
            stylesheet.remove();
            host = null;
            stylesheet = null;
        }
    }
    return { element, update, destroy };
}
