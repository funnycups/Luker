# 遠端存取

[區域網路存取](/zh-TW/guide/lan-access) 涵蓋同一網路內的裝置。若要從該網路之外存取 Luker，例如透過行動數據、他人的網路或公司筆電，需要一個公網可達位址，並在 Luker 前面放置一個解密 HTTPS、轉發請求的反向代理或隧道。

本指南涵蓋以下情境：

- **反向代理** —— 適用於執行 Luker 的機器擁有公網 IP 與網域的情境。
- **隧道** —— 適用於沒有公網 IP 的情境。

## 開始之前

- **監聽網路。** 在 `config.yaml` 中設定 `listen: true`，讓 Luker 接受來自代理或隧道的連線。監聽設定見[區域網路存取](/zh-TW/guide/lan-access)。
- **要求身分驗證。** 啟用基本認證或多使用者帳戶系統。暴露在公網且沒有身分驗證的 Luker 會被掃描並濫用。參見[驗證與安全](/zh-TW/guide/authentication)。
- **確定外部如何存取。** 有公網 IP 與網域時使用路徑 A，否則使用路徑 B。

::: warning
絕不把路由器連接埠直接轉發到 Luker。這會暴露未經 TLS 加密的原始 HTTP 服務，且 Luker 無法區分合法請求與攻擊請求。使用下面任一路徑。
:::

## 路徑 A：反向代理

適用於執行 Luker 的機器透過公網 IP 與網域可從網際網路存取的情境。反向代理在 443 連接埠接收 HTTPS，並轉發到同一機器上 Luker 的明文 HTTP 連接埠。

任何網頁伺服器上的設定方式一致：把每個路徑轉發到 Luker 的連接埠，原樣轉發原始請求標頭，並允許 WebSocket 升級。Luker 透過持久的 WebSocket 連線傳送生成請求，丟棄升級的代理會停用這條傳輸方式。

### nginx

```nginx
# 原樣轉發 Upgrade 請求標頭，讓 WebSocket 連線抵達 Luker。
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

`proxy_http_version 1.1` 與 `Upgrade`、`Connection` 請求標頭負責承載 WebSocket 連線。`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto` 告訴 Luker 真實用戶端與原始協定。

### Apache

啟用 `mod_proxy`、`mod_proxy_http`、`mod_proxy_wstunnel`、`mod_rewrite`、`mod_headers`、`mod_ssl`，然後：

```apache
<VirtualHost *:443>
    ServerName luker.example.com

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/luker.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/luker.example.com/privkey.pem

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"

    # 把 WebSocket 升級送往 ws://，其餘請求送往 http://。
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://127.0.0.1:8000/$1" [P,L]

    ProxyPass        / http://127.0.0.1:8000/
    ProxyPassReverse / http://127.0.0.1:8000/
</VirtualHost>
```

`mod_proxy_wstunnel` 與 `RewriteCond` 條件負責承載 WebSocket 連線。`ProxyPreserveHost` 與 `X-Forwarded-Proto` 請求標頭告訴 Luker 原始主機與協定。

### 讓 Luker 指向代理

設定 `listen: true`，然後按下面的 [Luker 設定](#luker-設定) 放行代理。

## 路徑 B：隧道

適用於沒有公網 IP 或網域的情況。隧道從你的機器向一個公網可達的中繼建立對外連線，中繼再把請求轉發回 Luker。路由器上不需要開放任何連接埠。

完成此事的工具不少，按願意投入的設定量選擇一個：

- **Tailscale** —— 私有 VPN。只有加入你的 tailnet 的裝置才能存取 Luker，完全不對外暴露，是個人裝置數量不多時最安全也最省事的選擇。
- **Cloudflare Tunnel** —— `cloudflared` 讓 Luker 取得一個由 Cloudflare 託管的網域下的主機名稱。適合已經在 Cloudflare 上管理網域的使用者。
- **ngrok** —— 一條命令即可取得臨時公網 URL。適合快速測試，免費版的 URL 每次執行都會變化。
- **frp** —— 自建中繼。需要一台有公網 IP 的獨立伺服器，但對中繼擁有完全控制。

每個工具都有自己的設定步驟，按其文件把隧道指向 Luker 的位址 `http://127.0.0.1:8000`，然後套用下面的 [Luker 設定](#luker-設定)。

::: tip
替你解密 HTTPS 的隧道，例如 Cloudflare Tunnel，仍然需要轉發 WebSocket 升級。Cloudflare 預設會轉發。
:::

## Luker 設定

無論代理或隧道是否執行在同一台機器上，以下設定都適用。

### 監聽

```yaml
listen: true
```

### 存取控制

在代理或隧道後面，每個請求都從代理的位址到達 Luker，因此 IP 白名單不再能區分用戶端。關閉白名單，改用身分驗證保護 Luker：

```yaml
whitelistMode: false
basicAuthMode: true
basicAuthUser:
  username: user
  password: password
```

多使用者帳戶系統的用法相同，參見[驗證與安全](/zh-TW/guide/authentication)。由於 `whitelistMode` 已關閉，Luker 要求存在一層身分驗證，否則啟動時會結束。

Luker 預設讀取 `X-Forwarded-For` 與 `X-Real-IP`，並且在 `enableForwardedWhitelist: true` 時會把這兩個轉發位址拿去比對白名單。關閉白名單可以完全避開這項衝突。

### 速率限制與主機標頭

```yaml
rateLimiting:
  preferRealIpHeader: true

hostWhitelist:
  enabled: true
  hosts:
    - luker.example.com
```

`preferRealIpHeader` 讓速率限制器按真實用戶端位址而非代理位址統計請求。`hostWhitelist` 限制 Luker 回應哪些主機名稱，從而阻斷針對公網可達部署的 DNS 重綁定攻擊，把對外提供 Luker 服務的網域加進去。

### 代理後面產生正確的 URL

Luker 會根據 `X-Forwarded-Proto` 與 `X-Forwarded-Host` 建構部分絕對 URL，包括 OAuth 回呼連結與區域網路同步配對連結。上面的 nginx 與 Apache 範例都已設定，因此登入與同步連結指向你的公網位址，而不是內部位址。

## 安全

- **使用 HTTPS。** 在代理或隧道處解密 HTTPS。Luker 自帶的 `ssl` 設定可用於直接提供 HTTPS，但反向代理是更常見的選擇。
- **要求身分驗證。** 按上面的方式啟用基本認證或使用者帳戶。絕不在沒有其中任一項的情況下暴露 Luker。
- **設定主機白名單。** 它能在公網部署上封堵主機標頭偽造。
- **不要連接埠轉發。** 隧道，或部署在已有公網 IP 的機器上的反向代理，已經足夠，直接連接埠轉發不行。
- **保持 Luker 更新。** 定期更新以取得最新的安全修正。

## 相關頁面

- [區域網路存取](/zh-TW/guide/lan-access) —— 讓同一網路內的裝置存取 Luker
- [驗證與安全](/zh-TW/guide/authentication) —— 基本認證、帳戶與白名單
- [基礎設定](/zh-TW/guide/configuration) —— 完整設定參考
- [WebSocket 代理](/zh-TW/improvements/ws-proxy) —— 為什麼必須轉發 WebSocket 升級
- [區域網路同步](/zh-TW/improvements/lan-sync) —— 在兩套 Luker 之間同步資料
