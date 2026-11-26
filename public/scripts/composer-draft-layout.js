const WRAPPED_ATTRIBUTE = 'data-composer-draft-wrap';
const PIXEL_LENGTH = /^(?:\d+(?:\.\d*)?|\.\d+)px$/i;
let activeLayout;

function getCompactWidth(row) {
    const style = getComputedStyle(row);
    const padding = style.getPropertyValue('--composer-compact-padding-x').trim();
    if (padding !== '0' && !PIXEL_LENGTH.test(padding)) return null;
    if (style.display !== 'grid' && style.display !== 'inline-grid') return null;

    // Use the compact middle track even when the textarea spans all three.
    const tracks = style.gridTemplateColumns.trim().split(/\s+/);
    if (tracks.length !== 3 || !tracks.every(track => PIXEL_LENGTH.test(track))) return null;
    return Math.max(0, Number.parseFloat(tracks[1]) - 2 * Number.parseFloat(padding));
}

export function refreshComposerDraftLayout() {
    activeLayout?.schedule();
}

export function applyComposerDraftLayout() {
    const form = document.getElementById('send_form');
    const row = form?.querySelector('#nonQRFormItems');
    const input = row?.querySelector('#send_textarea');
    if (!row || !input || getCompactWidth(row) === null) {
        activeLayout?.detach();
        activeLayout = undefined;
        return;
    }
    if (activeLayout?.form === form && activeLayout.row === row && activeLayout.input === input) {
        refreshComposerDraftLayout();
        return;
    }
    activeLayout?.detach();

    const measure = document.createElement('canvas').getContext('2d');
    let frame = 0;
    function update() {
        frame = 0;
        const text = input.value;
        const width = text ? getCompactWidth(row) : null;
        if (width === null || text.includes('\n')) {
            form.toggleAttribute(WRAPPED_ATTRIBUTE, width !== null);
            return;
        }

        if (measure) {
            const { fontStyle, fontWeight, fontSize, fontFamily, letterSpacing } = getComputedStyle(input);
            measure.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
            if ('letterSpacing' in measure) {
                measure.letterSpacing = letterSpacing === 'normal' ? '0px' : letterSpacing;
            }
        }
        form.toggleAttribute(WRAPPED_ATTRIBUTE, Boolean(measure && measure.measureText(text).width > width));
    }

    function schedule() {
        if (!frame) frame = requestAnimationFrame(update);
    }

    const observer = new ResizeObserver(schedule);
    observer.observe(row);
    for (const control of row.querySelectorAll('#leftSendForm, #rightSendForm')) observer.observe(control);
    input.addEventListener('input', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    activeLayout = {
        form, row, input, schedule,
        detach() {
            observer.disconnect();
            cancelAnimationFrame(frame);
            input.removeEventListener('input', schedule);
            document.fonts?.removeEventListener('loadingdone', schedule);
            form.removeAttribute(WRAPPED_ATTRIBUTE);
        },
    };
    schedule();
}
