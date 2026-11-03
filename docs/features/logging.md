# Logging

Luker records logs from the server and from the browser. Open **User Settings** → **Logs** to read them.

## Server logs

On startup, Luker collects the server's console output into a fixed-size in-memory buffer, dropping the oldest entries when it fills. Each entry carries a timestamp and level.

In the log manager, switch the source to **Server** to filter by time or entry count, search, copy or clear. Server logs are visible to administrators.

The buffer lives in memory and clears on restart. To keep the records, redirect the console output to a file.

## Browser logs

The browser side collects console output as well, including unhandled errors and Promise rejections.

Only `error` entries reach the browser console by default. **Diagnostics → Frontend debug logs** sends every level there. The switch controls what the browser console shows; the log manager always records every level.

## Exporting

**Diagnostics → Export Debug Logs** downloads a JSON bundle containing browser logs, performance marks, device and viewport information, server logs and Request Inspector records. Attach the bundle to a bug report.

::: warning
Logs and Request Inspector records can contain API keys and other sensitive content. Review them before sharing.
:::

## Where to look

- **API connection failures** — server logs carry the error; check the address and key.
- **Interrupted generation** — browser logs, or the [Request Inspector](/improvements/request-inspector) for the request lifecycle.
- **Extension errors** — browser logs capture runtime errors from extensions.

## Related pages

- [User Settings Additions](/features/user-settings-additions) — where the Logs, Diagnostics and Export Debug Logs controls are located
- [Basic Configuration](/guide/configuration) — log-related configuration
- [Auth and Quotas](/improvements/auth-and-quota) — authentication, permissions and storage quotas
