# Authentication and Security

Luker provides multi-layered access control and security mechanisms, from simple password protection to OAuth social login and storage quota management, covering deployment scenarios ranging from personal use to team sharing.

## Basic Auth Mode

The simplest form of access protection. When enabled, accessing Luker requires a username and password:

```yaml
basicAuthMode: true
basicAuthUser:
  username: user
  password: password
```

Suitable for single-user scenarios, such as when you've deployed Luker on a server and want to prevent others from accessing it.

::: tip
Basic Auth is HTTP-level authentication — the browser will display a native login dialog. If you need a friendlier login interface with multi-user support, use the multi-user account system instead.
:::

## Multi-User Account System

With multi-user mode enabled, each user gets an independent data directory and login credentials:

```yaml
enableUserAccounts: true
```

### Creating and Managing Users

Once multi-user mode is enabled, administrators can create, edit, and delete user accounts from the frontend admin panel. Each user's data (character cards, chat logs, presets, etc.) is stored in a separate subdirectory, fully isolated from other users.

### Default User

The system includes a built-in default user named `default-user`. If you switch from single-user mode to multi-user mode, your existing data will belong to this default user.

### Password Reset

If you forget a user's password, you can reset it via the command-line tool:

```bash
# Reset user password
node recover.js <username> <new-password>

# Example: reset default-user's password
node recover.js default-user myNewPassword

# Omit password to clear it
node recover.js default-user
```

::: tip
This command must be run from the Luker project root directory. The server does not need to be running.
:::

### Web-Based Password Recovery

In addition to the command-line tool, Luker supports initiating password recovery from the web interface. When a user clicks "Forgot Password" on the login page, the system generates a recovery code and **prints it to the server console**. The administrator provides the recovery code to the user, who can then complete the password reset on the web page.

::: warning
The recovery code is only output to the server console. Make sure only trusted administrators have access to the console logs.
:::

### Discreet Login Mode

```yaml
enableDiscreetLogin: true
```

When enabled, the login page won't display obvious Luker branding — useful for low-profile deployments.

## GitHub OAuth Login

Luker supports logging in with a GitHub account. Users are redirected to GitHub's authorization page, and upon completion, a local user account is automatically created or linked.

Configuration: Set up GitHub OAuth App credentials (`clientId` and `clientSecret`) in the Admin Panel. OAuth settings are persisted via `node-persist` in the `data/_storage` directory, not in `config.yaml`.

You'll need to create an OAuth App on GitHub first, setting the callback URL to `https://your-domain/api/users/oauth/callback/github`.

## Discord OAuth Login

Luker also supports Discord OAuth login with finer-grained access control — it can verify whether a user is a member of a specific Discord server and whether they hold specific roles.

Discord OAuth credentials (`clientId`, `clientSecret`) are also configured in the Admin Panel. You can set `allowedGuildIds` and `requiredRoleIds` to restrict access. The callback URL is `https://your-domain/api/users/oauth/callback/discord`.

This is particularly useful for community-shared Luker instances — only specific members of your Discord server can log in and use it.

::: tip
If you don't need OAuth login, there's no need to enable it in the Admin Panel. Luker still supports Basic Auth and multi-user account authentication as described above.
:::

## Storage Quota Management

In multi-user deployments, administrators can set storage quotas for each user to prevent individual users from consuming excessive disk space:

- **Quota limit** — The maximum storage space a user can use

When a user's storage usage exceeds the quota, file upload and save operations will be rejected until the user cleans up data or the administrator adjusts the quota.

Administrators can set quotas individually for each user in the frontend admin panel.

## Whitelist

Luker enables IP whitelist mode by default, allowing only local access:

```yaml
whitelistMode: true
whitelist:
  - ::1
  - 127.0.0.1
```

To allow LAN access, add the corresponding IPs to the `whitelist` list, or disable `whitelistMode`.

Luker also supports a host whitelist (`hostWhitelist`) that can restrict allowed host addresses and supports automatic LAN host scanning.

## Security Best Practices

If you need to expose Luker to the public internet, make sure to implement the following security measures:

1. **Use a Reverse Proxy + HTTPS** — Use a reverse proxy like Nginx or Caddy to provide HTTPS encryption, preventing data from being intercepted in transit
2. **Enable Authentication** — Turn on Basic Auth or the multi-user account system to prevent unauthorized access
3. **Configure Whitelists** — If only specific IPs need access, keep whitelist mode enabled
4. **Protect Configuration Files** — `config.yaml` contains sensitive information such as OAuth secrets; never commit it to public repositories
5. **Keep Updated** — Update Luker regularly to get the latest security fixes

::: warning
Never expose Luker to the public internet without any authentication mechanism. Even for internal network deployments, it's recommended to enable at least Basic Auth protection.
:::

## Related Pages

- [Configuration](/guide/configuration) — Complete configuration reference
- [Authentication and Quotas](/improvements/auth-and-quota) — Technical details of the authentication system
