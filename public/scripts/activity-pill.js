/** Shared placement and activation ownership for compact activity buttons. */
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
    element.append(label, meta, progress);
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
