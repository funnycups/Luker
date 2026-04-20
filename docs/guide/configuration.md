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
- `enableDiscreetLogin`: Enables discreet login mode
- `perUserBasicAuth`: Enables independent HTTP Basic authentication for each user

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

Luker supports single sign-on through reverse proxy authentication solutions like Authelia or Authentik. For detailed configuration, see [Authentication and Quotas](/improvements/auth-and-quota).

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

### Session and CSRF

```yaml
sessionTimeout: -1
disableCsrfProtection: false
securityOverride: false
```

- `sessionTimeout`: Session timeout in seconds; `-1` means no timeout
- `disableCsrfProtection`: Disables CSRF protection (not recommended)
- `securityOverride`: Security override switch (for debugging only)

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
```

- `logging`: Log configuration; `minLogLevel` controls the minimum log level
- `rateLimiting`: Rate limiting; `preferRealIpHeader` uses the real IP behind a reverse proxy
- `thumbnails`: Thumbnail generation configuration

## Plugin and Extension Paths

```yaml
serverPluginsPath: ./plugins
globalExtensionsPath: ./public/scripts/extensions/third-party
```

- `serverPluginsPath`: Server-side plugin directory
- `globalExtensionsPath`: Global frontend extension directory (where third-party extensions are installed)
