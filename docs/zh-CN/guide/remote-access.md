# 远程访问

[局域网访问](/zh-CN/guide/lan-access) 覆盖同一网络内的设备。要从该网络之外访问 Luker，例如通过移动数据、他人的网络或公司笔记本，需要一个公网可达地址，并在 Luker 前面放置一个解密 HTTPS、转发请求的反向代理或隧道。

本指南覆盖以下场景：

- **反向代理** —— 适用于运行 Luker 的机器拥有公网 IP 和域名的场景。
- **隧道** —— 适用于没有公网 IP 的场景。

## 开始之前

- **监听网络。** 在 `config.yaml` 中设置 `listen: true`，让 Luker 接受来自代理或隧道的连接。监听设置见[局域网访问](/zh-CN/guide/lan-access)。
- **要求身份验证。** 启用基本认证或多用户账户系统。暴露在公网且没有身份验证的 Luker 会被扫描并滥用。参见[鉴权与安全](/zh-CN/guide/authentication)。
- **确定外部如何访问。** 有公网 IP 和域名时使用路径 A，否则使用路径 B。

::: warning
绝不把路由器端口直接转发到 Luker。这会暴露未经 TLS 加密的原始 HTTP 服务，且 Luker 无法区分合法请求与攻击请求。使用下面任一路径。
:::

## 路径 A：反向代理

适用于运行 Luker 的机器通过公网 IP 和域名可从互联网访问的场景。反向代理在 443 端口接收 HTTPS，并转发到同一机器上 Luker 的明文 HTTP 端口。

任何 Web 服务器上的配置方式一致：把每个路径转发到 Luker 的端口，透传原始请求头，并允许 WebSocket 升级。Luker 通过持久的 WebSocket 连接发送生成请求，丢弃升级的代理会禁用这条传输方式。

### nginx

```nginx
# 透传 Upgrade 请求头，让 WebSocket 连接抵达 Luker。
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

`proxy_http_version 1.1` 与 `Upgrade`、`Connection` 请求头负责承载 WebSocket 连接。`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto` 告诉 Luker 真实客户端和原始协议。

### Apache

启用 `mod_proxy`、`mod_proxy_http`、`mod_proxy_wstunnel`、`mod_rewrite`、`mod_headers`、`mod_ssl`，然后：

```apache
<VirtualHost *:443>
    ServerName luker.example.com

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/luker.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/luker.example.com/privkey.pem

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"

    # 把 WebSocket 升级发往 ws://，其余请求发往 http://。
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://127.0.0.1:8000/$1" [P,L]

    ProxyPass        / http://127.0.0.1:8000/
    ProxyPassReverse / http://127.0.0.1:8000/
</VirtualHost>
```

`mod_proxy_wstunnel` 与 `RewriteCond` 条件负责承载 WebSocket 连接。`ProxyPreserveHost` 和 `X-Forwarded-Proto` 请求头告诉 Luker 原始主机和协议。

### 让 Luker 指向代理

设置 `listen: true`，然后按下面的 [Luker 设置](#luker-设置) 放行代理。

## 路径 B：隧道

适用于没有公网 IP 或域名的情况。隧道从你的机器向一个公网可达的中继建立出站连接，中继再把请求转发回 Luker。路由器上不需要开放任何端口。

完成此事的工具不少，按愿意投入的配置量选择一个：

- **Tailscale** —— 私有 VPN。只有加入你的 tailnet 的设备才能访问 Luker，完全不对外暴露，是个人设备数量不多时最安全也最省事的选择。
- **Cloudflare Tunnel** —— `cloudflared` 让 Luker 获得一个由 Cloudflare 托管的域名下的主机名。适合已经在 Cloudflare 上管理域名的用户。
- **ngrok** —— 一条命令即可获得临时公网 URL。适合快速测试，免费版的 URL 每次运行都会变化。
- **frp** —— 自建中继。需要一台有公网 IP 的独立服务器，但对中继拥有完全控制。

每个工具都有自己的配置步骤，按其文档把隧道指向 Luker 的地址 `http://127.0.0.1:8000`，然后应用下面的 [Luker 设置](#luker-设置)。

::: tip
替你解密 HTTPS 的隧道，例如 Cloudflare Tunnel，仍然需要转发 WebSocket 升级。Cloudflare 默认会转发。
:::

## Luker 设置

无论代理或隧道是否运行在同一台机器上，以下设置都适用。

### 监听

```yaml
listen: true
```

### 访问控制

在代理或隧道后面，每个请求都从代理的地址到达 Luker，因此 IP 白名单不再能区分客户端。关闭白名单，改用身份验证保护 Luker：

```yaml
whitelistMode: false
basicAuthMode: true
basicAuthUser:
  username: user
  password: password
```

多用户账户系统的用法相同，参见[鉴权与安全](/zh-CN/guide/authentication)。由于 `whitelistMode` 已关闭，Luker 要求存在一层身份验证，否则启动时会退出。

Luker 默认读取 `X-Forwarded-For` 和 `X-Real-IP`，并且在 `enableForwardedWhitelist: true` 时会把这两个转发地址拿去比对白名单。关闭白名单可以完全避开这一冲突。

### 限流与主机头

```yaml
rateLimiting:
  preferRealIpHeader: true

hostWhitelist:
  enabled: true
  hosts:
    - luker.example.com
```

`preferRealIpHeader` 让限流器按真实客户端地址而非代理地址统计请求。`hostWhitelist` 限制 Luker 响应哪些主机名，从而阻断针对公网可达部署的 DNS 重绑定攻击，把对外提供 Luker 服务的域名加进去。

### 代理后面生成正确的 URL

Luker 会根据 `X-Forwarded-Proto` 和 `X-Forwarded-Host` 构造部分绝对 URL，包括 OAuth 回调链接与局域网同步配对链接。上面的 nginx 与 Apache 示例都已设置，因此登录和同步链接指向你的公网地址，而不是内部地址。

## 安全

- **使用 HTTPS。** 在代理或隧道处解密 HTTPS。Luker 自带的 `ssl` 设置可用于直接提供 HTTPS，但反向代理是更常见的选择。
- **要求身份验证。** 按上面的方式启用基本认证或用户账户。绝不在没有其中任一项的情况下暴露 Luker。
- **设置主机白名单。** 它能在公网部署上封堵主机头伪造。
- **不要端口转发。** 隧道，或部署在已有公网 IP 的机器上的反向代理，已经足够，直接端口转发不行。
- **保持 Luker 更新。** 定期更新以获得最新的安全修复。

## 相关页面

- [局域网访问](/zh-CN/guide/lan-access) —— 让同一网络内的设备访问 Luker
- [鉴权与安全](/zh-CN/guide/authentication) —— 基本认证、账户与白名单
- [基础配置](/zh-CN/guide/configuration) —— 完整配置参考
- [WebSocket 代理](/zh-CN/improvements/ws-proxy) —— 为什么必须透传 WebSocket 升级
- [局域网同步](/zh-CN/improvements/lan-sync) —— 在两套 Luker 之间同步数据
