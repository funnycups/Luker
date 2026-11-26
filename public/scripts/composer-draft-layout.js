const WRAPPED_ATTRIBUTE = 'data-composer-draft-wrap';
const LAYOUT_ATTRIBUTE = 'data-composer-draft-layout';
const PIXEL_LENGTH = /^(?:\d+(?:\.\d*)?|\.\d+)px$/i;
let activeLayout;

function parsePx(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function getHorizontalInset(inputStyle) {
    if (inputStyle.boxSizing !== 'border-box') {
        return 0;
    }
    return parsePx(inputStyle.paddingLeft)
        + parsePx(inputStyle.paddingRight)
        + parsePx(inputStyle.borderLeftWidth)
        + parsePx(inputStyle.borderRightWidth);
}

function getCompactLayout(row, input, insetX) {
    const style = getComputedStyle(row);
    if (style.display === 'grid' || style.display === 'inline-grid') {
        // Use the compact middle track even when the textarea spans all three.
        const tracks = style.gridTemplateColumns.trim().split(/\s+/);
        if (tracks.length !== 3 || !tracks.every(track => PIXEL_LENGTH.test(track))) {
            return null;
        }
        return {
            mode: 'grid',
            width: Math.max(0, Number.parseFloat(tracks[1]) - insetX),
        };
    }

    if (style.display === 'flex' || style.display === 'inline-flex') {
        if (style.flexDirection !== 'row' && style.flexDirection !== 'row-reverse') {
            return null;
        }
        const rowRect = row.getBoundingClientRect();
        if (rowRect.width <= 0) {
            return null;
        }
        const rowInnerWidth = rowRect.width
            - parsePx(style.paddingLeft)
            - parsePx(style.paddingRight)
            - parsePx(style.borderLeftWidth)
            - parsePx(style.borderRightWidth);
        const colGap = parsePx(style.columnGap);
        let siblingsWidth = 0;
        let siblingCount = 0;
        for (const child of row.children) {
            if (child === input) continue;
            const childStyle = getComputedStyle(child);
            if (childStyle.display === 'none' || childStyle.position === 'absolute' || childStyle.position === 'fixed') {
                continue;
            }
            siblingsWidth += child.getBoundingClientRect().width;
            siblingCount += 1;
        }
        return {
            mode: 'flex',
            width: Math.max(0, rowInnerWidth - siblingsWidth - siblingCount * colGap - insetX),
        };
    }

    return null;
}

export function refreshComposerDraftLayout() {
    activeLayout?.refresh();
}

export function applyComposerDraftLayout(enabled, { onWrapChange = null } = {}) {
    if (!enabled) {
        activeLayout?.detach();
        activeLayout = undefined;
        return;
    }

    const form = document.getElementById('send_form');
    const row = form?.querySelector('#nonQRFormItems');
    const input = row?.querySelector('#send_textarea');
    if (!row || !input) {
        activeLayout?.detach();
        activeLayout = undefined;
        return;
    }

    if (activeLayout?.form === form && activeLayout.row === row && activeLayout.input === input) {
        activeLayout.setOnWrapChange(onWrapChange);
        activeLayout.refresh();
        return;
    }
    activeLayout?.detach();

    const measure = document.createElement('canvas').getContext('2d');
    let frame = 0;
    let collapsedInsetX = null;
    let wrapCallback = onWrapChange;

    function setWrapped(wrapped, mode) {
        const wasWrapped = form.hasAttribute(WRAPPED_ATTRIBUTE);
        form.toggleAttribute(WRAPPED_ATTRIBUTE, wrapped);
        if (wrapped && mode === 'flex') {
            form.setAttribute(LAYOUT_ATTRIBUTE, 'flex');
        } else {
            form.removeAttribute(LAYOUT_ATTRIBUTE);
        }
        if (wasWrapped !== wrapped) {
            wrapCallback?.(wrapped);
        }
    }

    function update() {
        frame = 0;
        const text = input.value;
        if (!text) {
            setWrapped(false, null);
            collapsedInsetX = getHorizontalInset(getComputedStyle(input));
            return;
        }

        const inputStyle = getComputedStyle(input);
        if (!form.hasAttribute(WRAPPED_ATTRIBUTE)) {
            collapsedInsetX = getHorizontalInset(inputStyle);
        }
        const insetX = collapsedInsetX ?? getHorizontalInset(inputStyle);
        const layout = getCompactLayout(row, input, insetX);
        if (!layout) {
            setWrapped(false, null);
            return;
        }
        if (text.includes('\n')) {
            setWrapped(true, layout.mode);
            return;
        }

        if (measure) {
            const { fontStyle, fontWeight, fontSize, fontFamily, letterSpacing, wordSpacing } = inputStyle;
            measure.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
            if ('letterSpacing' in measure) {
                measure.letterSpacing = letterSpacing === 'normal' ? '0px' : letterSpacing;
            }
            if ('wordSpacing' in measure) {
                measure.wordSpacing = wordSpacing === 'normal' ? '0px' : wordSpacing;
            }
        }
        const tabSize = Number.parseInt(inputStyle.tabSize, 10) || 8;
        const measuredText = text.includes('\t') ? text.replace(/\t/g, ' '.repeat(tabSize)) : text;
        const shouldWrap = Boolean(measure && measure.measureText(measuredText).width > layout.width);
        setWrapped(shouldWrap, shouldWrap ? layout.mode : null);
    }

    function schedule() {
        if (!frame) frame = requestAnimationFrame(update);
    }

    function refresh() {
        collapsedInsetX = null;
        schedule();
    }

    const observer = new ResizeObserver(schedule);
    observer.observe(row);
    for (const control of row.querySelectorAll('#leftSendForm, #rightSendForm')) {
        observer.observe(control);
    }
    input.addEventListener('input', schedule);
    document.fonts?.addEventListener('loadingdone', refresh);

    activeLayout = {
        form,
        row,
        input,
        schedule,
        refresh,
        setOnWrapChange(nextCallback) {
            wrapCallback = nextCallback;
        },
        detach() {
            observer.disconnect();
            cancelAnimationFrame(frame);
            input.removeEventListener('input', schedule);
            document.fonts?.removeEventListener('loadingdone', refresh);
            const wasWrapped = form.hasAttribute(WRAPPED_ATTRIBUTE);
            form.removeAttribute(WRAPPED_ATTRIBUTE);
            form.removeAttribute(LAYOUT_ATTRIBUTE);
            if (wasWrapped) {
                wrapCallback?.(false);
            }
        },
    };
    schedule();
}
