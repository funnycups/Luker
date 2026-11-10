# Configuration

Luker's configuration file is `config.yaml` in the project root directory. On first launch, if the file doesn't exist, Luker will copy a default configuration from `default/config.yaml`.

## Core Settings

### Data Directory

```yaml
dataRoot: ./data
```

The root directory for all user data (character cards, chat logs, presets, world info, etc.). In multi-user mode, each user's data is stored in a `<dataRoot>/<username>/` subdirectory.

### Port Settings

```yaml
port: 8000
```

The port the server listens on. To allow LAN access, also set `listen` to `true`:

```yaml
listen: true
listenAddress:
  ipv4: 0.0.0.0
  ipv6: "[::]"
protocol:
  ipv4: true
  ipv6: false
```

### SSL/TLS

```yaml
ssl:
  enabled: false
  certPath: "./certs/cert.pem"
  keyPath: "./certs/privkey.pem"
  keyPassphrase: ""
```

To enable HTTPS, set `enabled` to `true` and provide the certificate and private key paths. If the private key is password-protected, fill in `keyPassphrase`.

### Proxy Settings

SillyTavern supports forwarding outbound requests (such as API calls) through HTTP, HTTPS, or SOCKS proxies, and Luker inherits this feature:

```yaml
requestProxy:
  enabled: false
  url: socks5://username:password@example.com:1080
  bypass:
    - localhost
    - 127.0.0.1
```

- `url`: Proxy server address, supporting `http://`, `https://`, `socks://`, `socks4://`, `socks4a://`, `socks5://`, `socks5h://`, and `pac+*://` protocols
- `bypass`: List of addresses that bypass the proxy

### CORS Proxy

```yaml
enableCorsProxy: false
```

When enabled, Luker provides a CORS proxy endpoint for frontend cross-origin request forwarding.

## Authentication and Multi-User

### Basic Authentication

```yaml
basicAuthMode: false
basicAuthUser:
  username: user
  password: password
```

When enabled, accessing Luker requires a username and password. Suitable for single-user scenarios.

### Multi-User Mode

```yaml
enableUserAccounts: true
enableDiscreetLogin: false
perUserBasicAuth: false
```

- `enableUserAccounts`: Enables the multi-user account system, giving each user an independent data directory
- `enableDiscreetLogin`: Hides the account list on the login page; users enter their handle manually
- `perUserBasicAuth`: Enables independent HTTP Basic authentication for each user

The multi-user system also provides self-service registration, GitHub OAuth and Discord OAuth. Configure them in the admin panel under "Auth & Limits"; see [Authentication and Security](/guide/authentication).

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

### SSO (Single Sign-On)

```yaml
sso:
  autheliaAuth: false
  authentikAuth: false
```

Luker supports single sign-on through reverse proxy authentication solutions like Authelia or Authentik. For detailed configuration, see [Authentication and Security](/guide/authentication).

### Host Whitelist

```yaml
hostWhitelist:
  enabled: false
  scan: true
  hosts: []
```

Restricts which host addresses are allowed to access the server. When `scan` is enabled, it logs warnings about requests from untrusted hosts not in the whitelist, without blocking them (unless `enabled` is also set to `true`).

## Security Settings

### IP Whitelist

```yaml
whitelistMode: true
enableForwardedWhitelist: true
whitelist:
  - ::1
  - 127.0.0.1
whitelistDockerHosts: true
```

Whitelist mode is enabled by default, allowing only local access. To allow LAN access, add the corresponding IPs to the `whitelist` list, or disable `whitelistMode`.

::: warning Disabling the whitelist can cause the process to exit
If you set `whitelistMode: false`, Luker requires another protection layer. Otherwise it will detect an insecure setup at startup and terminate the process (in Docker, this manifests as the container restarting in a loop). To expose the server safely, do at least one of the following:

- Enable `basicAuthMode` and configure `basicAuthUser` — see [Authentication](/guide/authentication)
- Enable multi-user mode (`enableUserAccounts: true`) **and** set a password for every admin user via `node recover.js default-user <password>` — see [Authentication › Password Reset](/guide/authentication#password-reset). Both are required: enabling accounts alone still fails the check while admin users have no password, and setting a password alone still fails while accounts are disabled.
- Set `securityOverride: true` (debugging only — **never** use this on a public network)
:::

### Session and CSRF

```yaml
sessionTimeout: -1
disableCsrfProtection: false
securityOverride: false
```

- `sessionTimeout`: Session timeout in seconds; `-1` means no timeout
- `disableCsrfProtection`: Disables CSRF protection (not recommended)
- `securityOverride`: Security override switch (for debugging only)

### Sync Private Addresses {#sync-private-addresses}

```yaml
sync:
  allowPrivateAddressesForUsers: false
```

By default, non-admin accounts on multi-user installations cannot make outbound LAN or S3 sync connections to private, loopback or link-local destinations. Administrators and single-user mode with user accounts disabled are exempt.

Setting `allowPrivateAddressesForUsers: true` permits those users to reach private destinations through sync. Enable it only for users who should have access to the server's private network. It does not enable LAN listening or replace firewall, whitelist or authentication settings.

See [Sync](/improvements/sync), [LAN setup](/improvements/lan-sync) and [S3 setup](/improvements/s3-sync).

## Backup and Storage

```yaml
backups:
  common:
    numberOfBackups: 50
  chat:
    enabled: true
    checkIntegrity: true
    maxTotalBackups: -1
    throttleInterval: 10000
  allowFullDataBackup: true
```

- `checkIntegrity`: Enables chat file integrity checks to prevent concurrent write conflicts
- `throttleInterval`: Backup throttle interval in milliseconds to avoid excessive backups
- `maxTotalBackups`: Maximum number of chat backups; `-1` means unlimited

## Storage Backend

```yaml
storage:
  mode: fs
  mysql:
    url: mysql://user:pass@host:3306/luker
    poolSize: 10
  postgres:
    url: postgresql://user:pass@host:5432/luker
    poolSize: 10
```

Luker can persist user data through one of several backends. The `mode` key chooses which one; the matching sub-block is only consulted when its mode is selected.

- `fs` (default): one file per chat / preset / world / etc. under `<dataRoot>/<handle>/`. Recommended for single-user installs and the easiest backend to inspect by hand.
- `sqlite`: one self-contained `luker-storage.sqlite` file per user under `<dataRoot>/<handle>/`. Suits installs that want a single transactional file without operating a separate database service.
- `mysql`: one shared MySQL 8.0+ database. Suitable for multi-user deployments that already run MySQL.
- `postgres`: one shared PostgreSQL 14+ database; same shape as MySQL but using PostgreSQL.

Switching backends requires running the migration tool first. In the admin panel's Storage Backend tab, pick the target backend; Luker migrates every user, then switches the storage engine and writes `mode` to `config.yaml`. Data is read-only during the migration. If one user fails, that user's snapshot stays under `<dataRoot>/_storage-migrations/` and re-running resumes the migration.

The command-line script accepts any source and target pair; pass the connection string for the engines involved, for example `node scripts/storage-migrate.js --from fs --to mysql --mysql-url <url>`.

The desktop app supports only the `fs`, `mysql`, and `postgres` backends.

In Termux, run `npm run storage:install-sqlite` before enabling the `sqlite` backend.

## Other Settings

```yaml
logging:
  enableAccessLog: true
  minLogLevel: 0

rateLimiting:
  preferRealIpHeader: false

thumbnails:
  enabled: true
  format: jpg
  quality: 95

requestInspector:
  ttlMs: 7200000
  cleanupIntervalMs: 300000
  byteBudgetBytes: 268435456

disableUpdateCheck: false
generationAckGraceMs: 15000
```

- `logging`: Log configuration; `minLogLevel` controls the minimum log level
- `rateLimiting`: Rate limiting; `preferRealIpHeader` uses the real IP behind a reverse proxy
- `thumbnails`: Thumbnail generation configuration
- `requestInspector`: In-memory request record retention; see [Request Inspector](/improvements/request-inspector#record-retention)
- `disableUpdateCheck`: Skips the startup and client update check for installs whose version is managed elsewhere, such as Nix or a system package manager
- `generationAckGraceMs`: Grace period in milliseconds before a completed generation is persisted when the client has not acknowledged it yet; minimum 1000

## Plugin and Extension Paths

```yaml
serverPluginsPath: ./plugins
globalExtensionsPath: ./public/scripts/extensions/third-party
```

- `serverPluginsPath`: Server-side plugin directory
- `globalExtensionsPath`: Global frontend extension directory (where third-party extensions are installed)
