# Auth and Quotas

Luker supports multi-user authentication, storage quotas and logging for shared or public instances. This page is for instance administrators and covers how each control works and where to configure it.

## Authentication

### Self-registration

The login page can show a **Create account** form so visitors can register themselves. It is off by default and enabled in the admin panel.

Self-registered accounts are always non-admin, become active immediately, and inherit the default storage quota. When registration is off, the registration entry point rejects every request, so the form cannot be bypassed.

### GitHub login

After choosing GitHub login, a user is redirected to the authorization page; on return, Luker creates or links a local account. Create a GitHub OAuth app and enter its client ID and secret in the admin panel.

Automatic account creation is optional. With it off, only an existing local account can sign in through GitHub.

### Discord login

Discord login supports finer access control: require membership in a specific server, or a specific role. Enter the client ID and secret in the admin panel.

Luker derives the OAuth callback address from the current host, so it does not need to be entered by hand.

Without OAuth, the original SillyTavern username and password login remains available. OAuth credentials are sensitive; configure them through the admin panel and restrict access to the server data directory.

## Storage quotas

An administrator can set a storage limit per user:

- The quota covers files that user uploads and saves.
- Once the limit is reached, new writes are rejected while existing data stays intact.
- Administrators can change the quota at any time; the new limit applies immediately.

Quotas and token accounting are separate. Token usage is recorded by the [Request Inspector](/improvements/request-inspector) and does not count against storage.

## Logs

Server logs record startup, requests and errors. Administrators can view them in the log panel and export them for troubleshooting. Logging covers both browser and server, as described in [Logging](/features/logging).

Logs and request records can contain API keys and other sensitive data. Review them before sharing.

## Related pages

- [Authentication and security](/guide/authentication) — access control for deployers
- [Configuration](/guide/configuration) — listen address, HTTPS and accounts
- [Logging](/features/logging) — viewing and exporting logs
- [Request Inspector](/improvements/request-inspector) — token usage records
