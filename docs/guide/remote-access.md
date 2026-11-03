# Remote Access

[LAN Access](/guide/lan-access) covers devices on the same network. To reach Luker from outside that network — mobile data, a friend's connection, a laptop at work — you need a reachable address on the public internet, and a reverse proxy or a tunnel in front of Luker that terminates HTTPS and forwards requests to it.

This guide covers both routes:

- **Reverse proxy** — for when the machine running Luker has a public IP and a domain name.
- **Tunnel** — for when it does not.

## Before you start

- **Listen on the network.** Set `listen: true` in `config.yaml` so Luker accepts connections from the proxy or tunnel. See [LAN Access](/guide/lan-access) for the listening settings.
- **Require authentication.** Enable Basic Auth or the multi-user account system. An internet-facing Luker without authentication will be found and abused. See [Authentication & Security](/guide/authentication).
- **Decide how the outside reaches you.** A public IP with a domain leads to Path A; everything else leads to Path B.

::: warning
Never forward a router port straight to Luker. That exposes the raw HTTP server without TLS, and Luker cannot tell a legitimate request from an attacker's. Use one of the two paths below.
:::

## Path A: Reverse proxy

Use this when the machine running Luker is reachable from the internet through a public IP and a domain name. The reverse proxy accepts HTTPS on port 443 and forwards to Luker's plain-HTTP port on the same machine.

Any web server is configured the same way: forward every path to Luker's port, pass the original request headers through, and allow the WebSocket upgrade. Luker routes generation requests through a persistent WebSocket connection, so a proxy that drops the upgrade disables that transport.

### nginx

```nginx
# Pass the Upgrade header through so WebSocket connections reach Luker.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name luker.example.com;

    ssl_certificate     /etc/letsencrypt/live/luker.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/luker.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`proxy_http_version 1.1` and the two `Upgrade` / `Connection` lines are what carry WebSocket connections. `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto` tell Luker the real client and the original scheme.

### Apache

Enable `mod_proxy`, `mod_proxy_http`, `mod_proxy_wstunnel`, `mod_rewrite`, `mod_headers`, and `mod_ssl`, then:

```apache
<VirtualHost *:443>
    ServerName luker.example.com

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/luker.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/luker.example.com/privkey.pem

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"

    # Send WebSocket upgrades to Luker over ws://, everything else over http://.
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://127.0.0.1:8000/$1" [P,L]

    ProxyPass        / http://127.0.0.1:8000/
    ProxyPassReverse / http://127.0.0.1:8000/
</VirtualHost>
```

`mod_proxy_wstunnel` and the two `RewriteCond` lines are what carry WebSocket connections. `ProxyPreserveHost` and the `X-Forwarded-Proto` header tell Luker the original host and scheme.

### Point Luker at the proxy

Set `listen: true`, then let the proxy through as described in [Luker settings](#luker-settings) below.

## Path B: Tunnel

Use this when you do not have a public IP or a domain. A tunnel opens an outbound connection from your machine to a relay that is reachable from the internet, and the relay forwards requests back to Luker. Nothing needs to be opened on your router.

Several tools do this. Pick one based on how much setup you want:

- **Tailscale** — a private VPN. Only devices you add to your tailnet can reach Luker. No public exposure at all, which makes it the safest option and the easiest for a handful of personal devices.
- **Cloudflare Tunnel** — `cloudflared` gives Luker a hostname on a Cloudflare-managed domain. Suits users who already run a domain on Cloudflare.
- **ngrok** — a single command for a temporary public URL. Convenient for a quick test; the URL changes between runs on the free plan.
- **frp** — a self-hosted relay. Requires a separate server with a public IP, but keeps full control of the relay.

Each tool has its own setup steps; follow its documentation to point the tunnel at Luker's address, `http://127.0.0.1:8000`. Then apply the [Luker settings](#luker-settings) below.

::: tip
A tunnel that terminates HTTPS for you, such as Cloudflare Tunnel, still needs the WebSocket upgrade forwarded. Cloudflare does this by default.
:::

## Luker settings

These apply whether the proxy or tunnel runs on the same machine or elsewhere.

### Listening

```yaml
listen: true
```

### Access control

Behind a proxy or tunnel, every request reaches Luker from the proxy's address, so the IP whitelist no longer distinguishes clients. Turn it off and protect Luker with authentication instead:

```yaml
whitelistMode: false
basicAuthMode: true
basicAuthUser:
  username: user
  password: password
```

The multi-user account system works the same way; see [Authentication & Security](/guide/authentication). Because `whitelistMode` is off, Luker requires an authentication layer or it exits at startup.

Luker reads `X-Forwarded-For` and `X-Real-IP` by default (`forwardedHeaders`), and with `enableForwardedWhitelist: true` it would check those forwarded addresses against the whitelist. Leaving the whitelist off avoids that conflict entirely.

### Rate limiting and host header

```yaml
rateLimiting:
  preferRealIpHeader: true

hostWhitelist:
  enabled: true
  hosts:
    - luker.example.com
```

`preferRealIpHeader` makes the rate limiter count requests by the real client address instead of the proxy's. `hostWhitelist` restricts which host names Luker answers to, which blocks DNS-rebinding attacks against a publicly reachable install; add the domain you serve Luker on.

### Correct URLs behind a proxy

Luker builds some absolute URLs — OAuth callback links, LAN Sync pairing links — from `X-Forwarded-Proto` and `X-Forwarded-Host`. Both nginx and Apache examples above set these, so logins and sync links point at your public address rather than the internal one.

## Security

- **Use HTTPS.** Terminate TLS at the proxy or tunnel. Luker's own `ssl` settings exist for serving HTTPS directly, but a reverse proxy is the usual choice.
- **Require authentication.** Basic Auth or user accounts, as above. Never expose Luker without one.
- **Set the host whitelist.** It closes host-header spoofing on a public install.
- **Do not port-forward.** A tunnel or a reverse proxy on a machine that already has a public IP is enough; a raw port forward is not.
- **Keep Luker updated.** Update regularly for the latest security fixes.

## Related pages

- [LAN Access](/guide/lan-access) — reach Luker from devices on the same network
- [Authentication & Security](/guide/authentication) — Basic Auth, accounts, and whitelists
- [Configuration](/guide/configuration) — complete config reference
- [WebSocket Proxy](/improvements/ws-proxy) — why the WebSocket upgrade must pass through
- [LAN Sync](/improvements/lan-sync) — keep two Luker installs in sync
