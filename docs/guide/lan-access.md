# LAN Access

Luker runs as a web server. By default it accepts connections only from the machine it runs on, so a phone, tablet, or second computer on the same network cannot reach it. This guide turns on access from other devices on your local network.

Typical reasons to do this:

- Keep Luker running on a computer and use it from a phone or tablet.
- Reach one Luker install from several devices on a home network.
- Use Luker on iPhone or iPad through a self-signed app or a browser.

If your goal is to sync data between two Luker installs instead, see [LAN Sync](/improvements/lan-sync). That is a separate feature.

## Why the default setup fails

Two settings block LAN access:

- `listen: false` — Luker binds only to the loopback address, so other devices cannot open a connection at all.
- `whitelistMode: true` — Luker rejects every address that is not in the `whitelist` list.

With the shipped defaults, a device on your network either gets a connection error or, once listening is enabled, an HTTP `403 Forbidden` page. The server console also logs `Blocked connection from <ip>`.

To allow LAN access, change both the listening setting and the whitelist.

## Step 1: Enable listening

Open `config.yaml` in the Luker root directory and set:

```yaml
listen: true
```

Leave `listenAddress` and `protocol` as shipped:

```yaml
listenAddress:
  ipv4: 0.0.0.0
  ipv6: "[::]"
protocol:
  ipv4: true
  ipv6: false
```

On startup the console prints `Luker is listening on IPv4: 0.0.0.0:8000` instead of the loopback address. Restart the server after editing the file.

## Step 2: Allow your devices

### Option A: Add your network to the whitelist

Keep `whitelistMode: true` and add the subnet your devices use:

```yaml
whitelistMode: true
whitelist:
  - ::1
  - 127.0.0.1
  - 192.168.0.0/16
```

Individual addresses, CIDR ranges, and wildcards such as `192.168.1.*` all work. Keep `127.0.0.1` and `::1` in the list so the host machine can still connect. If you do not know your subnet, add all three private ranges at once:

```yaml
whitelist:
  - ::1
  - 127.0.0.1
  - 10.0.0.0/8
  - 172.16.0.0/12
  - 192.168.0.0/16
```

### Option B: Turn off the whitelist

Set `whitelistMode: false` to accept any address. Luker treats this as insecure and requires another protection layer, or it exits at startup:

- Enable Basic Auth — see [Authentication](/guide/authentication)
- Enable user accounts and set a password for every admin user
- Set `securityOverride: true`, which is for debugging only

## Find the host address

On the machine running Luker, read its LAN address:

```bash
# Windows
ipconfig

# macOS
ipconfig getifaddr en0

# Linux
hostname -I
```

Look for the IPv4 address in a private range, such as `192.168.1.23`.

## Connect from another device

On the other device, open a browser and enter the host address and port:

```
http://192.168.1.23:8000
```

Use `http://`, not `https://`. The address must be the host's LAN address, not `localhost`.

## Docker

The Docker compose file in [Getting Started](/guide/getting-started) binds the port to `127.0.0.1:8000`, which blocks LAN access before Luker sees the request. Change the port mapping to publish on all interfaces, and set `listen: true` and the whitelist in the mounted `config.yaml`:

```yaml
ports:
  - 0.0.0.0:8000:8000
```

## Security

A LAN is not automatically trusted, especially on shared or public Wi-Fi. Before opening Luker to other devices:

- Turn on Basic Auth or the multi-user account system.
- Keep the whitelist narrow when only a few devices need access.
- Do not create port-forwarding rules on your router. To reach Luker from outside your network, use a VPN or a tunneling service.

## iOS

iPhone and iPad can install Luker as a self-signed app and run it locally, or use the browser to reach Luker on another device. See [iOS](/guide/ios) for both paths.

## Troubleshooting

- **403 Forbidden page** — the device's address is not in the whitelist. Add it, or widen the subnet.
- **Connection times out or is refused, and nothing appears in the console** — the server is not reachable. Check that `listen` is `true` and that the host firewall allows the port:
  - Windows: allow Node.js through the firewall and set the network profile to Private. On Windows 11, enable the Private Network profile.
  - Linux: `sudo ufw allow 8000`
  - macOS: allow incoming connections for the Node process in System Settings.
- **Only the host machine can connect** — the address used on the other device is still `localhost`. Use the host's LAN address.

## Related pages

- [Configuration](/guide/configuration) — complete config reference
- [Authentication & Security](/guide/authentication) — Basic Auth, accounts, whitelist
- [LAN Sync](/improvements/lan-sync) — keep two Luker installs in sync
