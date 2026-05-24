/**
 * iteration-library/ui — umbrella for shared popup UI components.
 *
 * All four existing iter-library-consuming popups (CPA, MG schema, Orch,
 * CEA character-iteration) and the unified CEA editor (M2) render their
 * conversation surface through these helpers. Plugins customize via the
 * `toolDisplay` and `fieldLabels` opts; visuals (CSS classes prefixed
 * `luker_lib_*`) live in `styles.css` and are loaded once via
 * ensureUiStylesheetInjected().
 */
export * as toolcall from './toolcall.js';
export * as message from './message.js';
export * as diff from './diff.js';
export * as apply from './apply.js';

export { ensureUiStylesheetInjected } from './styles.js';
