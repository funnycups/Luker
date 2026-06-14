// jest stub for dialog-polyfill: it touches window.CustomEvent at module
// load time, which throws in node env. Tests don't exercise it.
const dialogPolyfill = {
    forceRegisterDialog: () => {},
    registerDialog: () => {},
};
export default dialogPolyfill;
