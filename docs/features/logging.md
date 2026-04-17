# Logging System

Luker has a built-in comprehensive log capture and management system covering both the backend server and the frontend browser. When you encounter issues that need troubleshooting, the logging system helps you quickly identify the cause.

The logging system is a standalone feature module that does not depend on other Luker features (such as Memory Graph, CardApp, etc.) and works out of the box.

## Backend Logs

Luker's backend logging system automatically intercepts all console output from the server and stores logs in memory for viewing.

### How It Works

- **Auto-interception**: On server startup, Luker automatically intercepts `console.log`, `console.warn`, `console.error`, and other outputs
- **Ring buffer**: Logs are stored in a fixed-size memory buffer. When the buffer is full, the oldest logs are automatically discarded, ensuring memory usage stays bounded
- **Timestamps and levels**: Each log entry records a precise timestamp and log level (info, warn, error), making it easy to filter by time and severity

### Viewing and Management

Administrators can remotely view server logs through the frontend admin panel without needing to log into the server to check the console. The log buffer can also be cleared with one click.

::: tip
Backend logs are only kept in memory and are cleared on server restart. If you need persistent log records, it is recommended to redirect Luker's console output to a file.
:::

## Frontend Log Manager

Luker also includes a built-in log manager on the browser side for capturing various runtime information from the frontend.

### Console Interception

The frontend log manager intercepts six levels of browser console output — `console.trace`, `console.debug`, `console.log`, `console.info`, `console.warn`, `console.error` — and writes them to an in-memory buffer (up to 3000 entries).

### Fetch Request Logs

In addition to console output, the frontend log manager automatically records API request information sent by the browser, including:

- Request method and path
- Response status code and latency
- Error messages for failed or aborted requests

This information is processed with **smart summarization** — only key fields (such as model name, message count, etc.) are extracted. Full request content is not recorded, balancing debugging value with privacy protection.

### Global Error Capture

The frontend log manager also automatically captures unhandled errors and Promise rejection events in the browser, ensuring these easily overlooked exceptions are also recorded.

### Log Visibility

By default, only `error`-level logs are displayed in the browser console. If you need more detailed debug information, you can enable debug mode, which outputs all log levels to the browser console.

Regardless of whether debug mode is enabled, all log levels are written to the in-memory buffer and can be exported for viewing at any time.

## Use Cases

### Debugging Issues

When Luker exhibits abnormal behavior, the logging system is the most direct troubleshooting tool:

- **API connection failures** — Check error messages in the backend logs to confirm whether the API address and key are correct
- **Generation interruptions** — Check Fetch request records in the frontend logs to understand whether requests timed out or were rejected
- **Extension errors** — Frontend logs capture runtime errors from extensions, helping locate the problematic extension

### Error Reporting

If you need to report an issue to developers, you can export a frontend log snapshot that contains complete contextual information before and after the issue occurred — much more helpful for issue diagnosis than screenshots alone.

::: warning
Logs may contain partial API request information. When sharing logs, please check whether they contain sensitive content (such as API keys). The frontend log manager already sanitizes sensitive fields (e.g., CSRF tokens are recorded as "present" rather than their actual values), but it is still recommended to review before sharing.
:::

## Related Pages

- [Basic Configuration](/guide/configuration) — Log-related configuration options
