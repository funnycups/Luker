/**
 * CardApp Loader - handles CSS scoping, JS loading, container management.
 */

const CONTAINER_ID = 'card-app-container';
const SCOPED_STYLE_ID = 'card-app-scoped-style';
const CONTAINER_SELECTOR = `#${CONTAINER_ID}`;

/**
 * Elements to hide when CardApp is active.
 */
const ELEMENTS_TO_HIDE = ['#chat', '#form_sheld', '#qr--bar'];

/**
 * Scope CSS selectors to the CardApp container.
 * Rewrites selectors so they only apply within #card-app-container.
 * @param {string} css - Raw CSS string
 * @returns {string} Scoped CSS string
 */
export function scopeCSS(css) {
    // Remove comments
    let cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');

    const result = [];
    let i = 0;

    while (i < cleaned.length) {
        // Skip whitespace
        while (i < cleaned.length && /\s/.test(cleaned[i])) {
            result.push(cleaned[i]);
            i++;
        }

        if (i >= cleaned.length) break;

        // Handle @-rules
        if (cleaned[i] === '@') {
            const atRuleMatch = cleaned.slice(i).match(/^@(\w[\w-]*)/);
            if (atRuleMatch) {
                const ruleName = atRuleMatch[1].toLowerCase();

                if (ruleName === 'media' || ruleName === 'supports' || ruleName === 'container' || ruleName === 'layer') {
                    // Conditional @-rules: copy the @-rule header, then recurse into the block
                    const headerEnd = cleaned.indexOf('{', i);
                    if (headerEnd === -1) break;
                    result.push(cleaned.slice(i, headerEnd + 1));
                    i = headerEnd + 1;

                    // Find matching closing brace and scope the inner content
                    const innerEnd = findMatchingBrace(cleaned, headerEnd);
                    if (innerEnd === -1) break;
                    const innerCSS = cleaned.slice(i, innerEnd);
                    result.push(scopeCSS(innerCSS));
                    result.push('}');
                    i = innerEnd + 1;
                    continue;
                } else if (ruleName === 'keyframes' || ruleName === '-webkit-keyframes') {
                    // Keyframes: pass through unchanged
                    const braceStart = cleaned.indexOf('{', i);
                    if (braceStart === -1) break;
                    const braceEnd = findMatchingBrace(cleaned, braceStart);
                    if (braceEnd === -1) break;
                    result.push(cleaned.slice(i, braceEnd + 1));
                    i = braceEnd + 1;
                    continue;
                } else if (ruleName === 'font-face' || ruleName === 'import' || ruleName === 'charset') {
                    // Global @-rules: pass through unchanged
                    const end = cleaned.indexOf(';', i);
                    const braceStart = cleaned.indexOf('{', i);
                    if (braceStart !== -1 && (end === -1 || braceStart < end)) {
                        const braceEnd = findMatchingBrace(cleaned, braceStart);
                        if (braceEnd === -1) break;
                        result.push(cleaned.slice(i, braceEnd + 1));
                        i = braceEnd + 1;
                    } else if (end !== -1) {
                        result.push(cleaned.slice(i, end + 1));
                        i = end + 1;
                    } else {
                        break;
                    }
                    continue;
                }
            }
        }

        // Regular rule: find selector(s) and scope them
        const braceStart = cleaned.indexOf('{', i);
        if (braceStart === -1) break;

        const selectorText = cleaned.slice(i, braceStart).trim();
        const braceEnd = findMatchingBrace(cleaned, braceStart);
        if (braceEnd === -1) break;

        const body = cleaned.slice(braceStart, braceEnd + 1);

        // Scope each selector
        const scopedSelectors = selectorText.split(',').map(sel => {
            sel = sel.trim();
            if (!sel) return sel;

            // Replace body/html/:root with container selector
            if (/^(body|html|:root)$/i.test(sel)) {
                return CONTAINER_SELECTOR;
            }
            // If selector starts with body/html/:root, replace that part
            if (/^(body|html|:root)\s/i.test(sel)) {
                return sel.replace(/^(body|html|:root)/i, CONTAINER_SELECTOR);
            }
            // Universal selector alone
            if (sel === '*') {
                return `${CONTAINER_SELECTOR} *`;
            }
            // Already scoped
            if (sel.startsWith(CONTAINER_SELECTOR)) {
                return sel;
            }
            // Normal selector: prefix with container
            return `${CONTAINER_SELECTOR} ${sel}`;
        }).join(', ');

        result.push(scopedSelectors + ' ' + body);
        i = braceEnd + 1;
    }

    return result.join('');
}

/**
 * Find the matching closing brace for an opening brace.
 * @param {string} str - The string to search
 * @param {number} openPos - Position of the opening brace
 * @returns {number} Position of the matching closing brace, or -1
 */
function findMatchingBrace(str, openPos) {
    let depth = 1;
    for (let i = openPos + 1; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * Create the CardApp container and hide default chat UI.
 * @returns {HTMLElement} The container element
 */
export function createContainer() {
    // Hide default chat elements
    for (const selector of ELEMENTS_TO_HIDE) {
        const el = document.querySelector(selector);
        if (el) {
            el.dataset.cardAppHidden = 'true';
            el.style.display = 'none';
        }
    }

    // Create container
    const container = document.createElement('div');
    container.id = CONTAINER_ID;

    // Insert into #sheld, before #form_sheld
    const sheld = document.getElementById('sheld');
    const formSheld = document.getElementById('form_sheld');
    if (sheld && formSheld) {
        sheld.insertBefore(container, formSheld);
    } else if (sheld) {
        sheld.appendChild(container);
    } else {
        document.body.appendChild(container);
    }

    // Add a floating menu button so users can still access Luker's options menu
    const menuBtn = document.createElement('button');
    menuBtn.id = 'card-app-menu-btn';
    menuBtn.innerHTML = '☰';
    menuBtn.title = 'Menu';
    menuBtn.addEventListener('click', () => {
        const optionsBtn = document.getElementById('options_button');
        if (optionsBtn) optionsBtn.click();
    });
    container.appendChild(menuBtn);

    return container;
}

/**
 * Remove the CardApp container and restore default chat UI.
 */
export function destroyContainer() {
    // Remove container
    const container = document.getElementById(CONTAINER_ID);
    if (container) {
        container.remove();
    }

    // Remove scoped styles
    const style = document.getElementById(SCOPED_STYLE_ID);
    if (style) {
        style.remove();
    }

    // Restore hidden elements
    const hiddenElements = document.querySelectorAll('[data-card-app-hidden]');
    for (const el of hiddenElements) {
        el.style.display = '';
        delete el.dataset.cardAppHidden;
    }
}

/**
 * Inject scoped CSS into the page.
 * @param {string} css - Raw CSS from the CardApp
 */
export function injectScopedCSS(css) {
    const scoped = scopeCSS(css);
    const style = document.createElement('style');
    style.id = SCOPED_STYLE_ID;
    style.textContent = scoped;
    document.head.appendChild(style);
}

/**
 * Load the CardApp entry JS module.
 * @param {string} charId - Character ID
 * @param {string} entry - Entry file name (e.g. 'index.js')
 * @returns {Promise<{init?: Function}>} The loaded module
 */
export async function loadEntryModule(charId, entry) {
    const url = `/api/card-app/${encodeURIComponent(charId)}/${entry}`;
    // Add cache buster to force reload on each activation
    const module = await import(`${url}?t=${Date.now()}`);
    return module;
}

/**
 * Show error UI in the container.
 * @param {HTMLElement} container - The container element
 * @param {Error|string} error - The error
 * @param {Function} onExit - Callback when user clicks exit
 */
export function showError(container, error, onExit) {
    const errorMsg = error instanceof Error ? error.stack || error.message : String(error);
    container.innerHTML = `
        <div id="card-app-error">
            <h3>CardApp Error</h3>
            <div class="card-app-error-message">${escapeHtml(errorMsg)}</div>
            <button class="card-app-exit-btn">Exit CardApp</button>
        </div>
    `;
    container.querySelector('.card-app-exit-btn')?.addEventListener('click', onExit);
}

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
