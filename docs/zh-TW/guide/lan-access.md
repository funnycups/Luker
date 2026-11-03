# 區域網路存取

Luker 以 Web 服務的形式執行，預設僅接受本機連線，同一網路中的手機、平板或另一台電腦無法存取。開啟區域網路存取後，這些裝置即可透過瀏覽器使用同一套 Luker 資料。

常見用途：

- 電腦執行服務，手機或平板隨時使用
- 家中多台裝置共享同一套角色卡與聊天記錄
- 在 iPhone 或 iPad 上使用 Luker，可安裝自簽名應用或透過瀏覽器存取

如果目標是在兩台 Luker 之間同步資料，請見[區域網路同步](/zh-TW/improvements/lan-sync)，那是另一項功能。

## 預設設定為何無法存取

以下設定會阻止區域網路存取：

- `listen: false` —— Luker 僅綁定回環地址，其他裝置根本無法建立連線。
- `whitelistMode: true` —— Luker 拒絕所有不在 `whitelist` 列表中的地址。

在預設設定下，區域網路裝置要麼連線失敗，要麼在開啟監聽後收到 HTTP `403 Forbidden` 頁面，伺服器端主控台同時輸出 `Blocked connection from <ip>`。

要允許區域網路存取，需要同時修改監聽設定與白名單。

## 開啟監聽

開啟 Luker 根目錄下的 `config.yaml`，設定：

```yaml
listen: true
```

`listenAddress` 與 `protocol` 保持預設即可：

```yaml
listenAddress:
  ipv4: 0.0.0.0
  ipv6: "[::]"
protocol:
  ipv4: true
  ipv6: false
```

啟動後，主控台會輸出 `Luker is listening on IPv4: 0.0.0.0:8000`，而不再是回環地址。修改檔案後需重新啟動服務。

## 允許區域網路裝置存取

### 方式一：將區域網路加入白名單

保持 `whitelistMode: true`，把裝置所在的網段加入列表：

```yaml
whitelistMode: true
whitelist:
  - ::1
  - 127.0.0.1
  - 192.168.0.0/16
```

支援單一地址、CIDR 網段以及 `192.168.1.*` 這類萬用字元。請保留 `127.0.0.1` 與 `::1`，否則本機也無法存取。若不確定網段，可一次加入全部私有位址範圍：

```yaml
whitelist:
  - ::1
  - 127.0.0.1
  - 10.0.0.0/8
  - 172.16.0.0/12
  - 192.168.0.0/16
```

### 方式二：關閉白名單

將 `whitelistMode` 設為 `false` 後，Luker 會接受任意地址。此設定被視為不安全，Luker 要求至少還有一層防護，否則在啟動時結束：

- 啟用 Basic Auth，見[驗證與安全](/zh-TW/guide/authentication)
- 啟用多使用者帳號，並為每個管理員使用者設定密碼
- 設定 `securityOverride: true`，僅用於除錯

## 查詢主機地址

在執行 Luker 的機器上查詢其區域網路地址：

```bash
# Windows
ipconfig

# macOS
ipconfig getifaddr en0

# Linux
hostname -I
```

找到形如 `192.168.1.23` 的私有網段 IPv4 地址。

## 從另一台裝置存取

在另一台裝置上開啟瀏覽器，輸入主機地址與連接埠：

```
http://192.168.1.23:8000
```

使用 `http://`，不要用 `https://`。地址必須是主機的區域網路地址，而非 `localhost`。

## Docker

[快速開始](/zh-TW/guide/getting-started)中的 Docker compose 檔案將連接埠綁定到 `127.0.0.1:8000`，請求在到達 Luker 之前就會被攔截。將連接埠對應改為在所有網路介面上發布，並在掛載的 `config.yaml` 中設定 `listen: true` 與白名單：

```yaml
ports:
  - 0.0.0.0:8000:8000
```

## 安全

區域網路並不天然可信，公用 Wi-Fi 尤其如此。向其他裝置開放 Luker 之前：

- 啟用 Basic Auth 或多使用者帳號系統。
- 只有少數裝置需要存取時，保持白名單範圍盡量窄。
- 不要在路由器上設定連接埠轉送。若需從區域網路外存取 Luker，請改用 VPN 或隧道服務。

## iOS

iPhone 與 iPad 可安裝自簽名應用在本機執行，也可透過瀏覽器存取另一台裝置上的 Luker。兩種方式見 [iOS](/zh-TW/guide/ios)。

## 疑難排解

- **出現 403 Forbidden 頁面** —— 裝置地址不在白名單中，將其加入或放寬網段。
- **連線逾時或被拒絕，且主控台沒有任何輸出** —— 服務不可達。檢查 `listen` 是否為 `true`，以及主機防火牆是否允許該連接埠：
  - Windows：在防火牆中允許 Node.js，並將網路設定檔設為「私人」。
  - Linux：`sudo ufw allow 8000`
  - macOS：在「系統設定」中允許 Node 行程的傳入連線。
- **只有主機能連線** —— 另一台裝置使用的仍是 `localhost`，請改用主機的區域網路地址。

## 相關頁面

- [基礎設定](/zh-TW/guide/configuration) —— 完整的設定項說明
- [驗證與安全](/zh-TW/guide/authentication) —— Basic Auth、帳號與白名單
- [區域網路同步](/zh-TW/improvements/lan-sync) —— 在兩台 Luker 之間同步資料
