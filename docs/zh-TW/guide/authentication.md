# 驗證與安全

Luker 提供了多層次的存取控制和安全機制，從簡單的密碼保護到 OAuth 社交登入，再到儲存配額管理，滿足從個人使用到團隊共享的各種部署場景。

## Basic Auth 模式

最簡單的存取保護方式。啟用後，存取 Luker 時需要輸入使用者名稱和密碼：

```yaml
basicAuthMode: true
basicAuthUser:
  username: user
  password: password
```

適用於單一使用者場景，例如你在伺服器上部署了 Luker 並希望防止他人存取。

::: tip
Basic Auth 是 HTTP 層面的認證，瀏覽器會彈出原生的登入對話框。如果你需要更友善的登入介面和多使用者支援，請使用多使用者帳號系統。
:::

## 多使用者帳號系統

啟用多使用者模式後，每個使用者擁有獨立的資料目錄和登入憑據：

```yaml
enableUserAccounts: true
```

### 建立和管理使用者

啟用多使用者模式後，管理員可以在前端管理面板中建立、編輯和刪除使用者帳號。每個使用者的資料（角色卡、聊天記錄、預設等）儲存在獨立的子目錄中，互不干擾。

### 預設使用者

系統內建了一個名為 `default-user` 的預設使用者。如果你從單一使用者模式切換到多使用者模式，之前的資料會歸屬於這個預設使用者。

### 密碼重設

如果忘記了使用者密碼，可以透過命令列工具重設：

```bash
# 重設使用者密碼
node recover.js <使用者名稱> <新密碼>

# 例如重設 default-user 的密碼
node recover.js default-user myNewPassword

# 不提供密碼則清空密碼
node recover.js default-user
```

::: tip
此命令需要在 Luker 專案根目錄下執行，服務無需處於執行狀態。
:::

### 網頁端密碼復原

除了命令列工具，Luker 還支援透過網頁端發起密碼復原流程。使用者在登入頁面點擊「忘記密碼」後，系統會產生一個復原碼並**輸出在伺服器端主控台**中。管理員將復原碼告知使用者，使用者即可在網頁上完成密碼重設。

::: warning
復原碼僅在伺服器端主控台輸出，請確保只有受信任的管理員能夠檢視主控台日誌。
:::

### 隱蔽登入模式

```yaml
enableDiscreetLogin: true
```

啟用後，登入頁面不會顯示明顯的 Luker 標識，適用於需要低調部署的場景。

## 自助註冊

登入頁面可以選擇性地展示「建立帳號」表單，讓訪客無需管理員介入即可自行註冊帳號。此功能**預設關閉**，可在管理面板「認證與限額 → 帳號註冊」中切換開關。

透過自助註冊建立的新帳號：

- 預設為非管理員角色
- 建立後立即可用（無需電子郵件驗證或審核流程）
- 繼承管理面板中設定的預設儲存配額

只有在啟用該功能後，登入頁面才會出現「還沒有帳號？建立一個」入口；功能關閉時，直接呼叫註冊介面同樣會被拒絕。

::: warning
自助註冊適用於可信任網路或邀請制部署。若 Luker 暴露在公網，建議改用 OAuth 或由管理員手動建立帳號，以便核驗新使用者身分。
:::

## GitHub OAuth 登入

Luker 支援透過 GitHub 帳號登入。使用者點擊登入後會被重新導向到 GitHub 授權頁面，授權完成後自動建立或關聯本機使用者帳號。

設定方式：在管理面板（Admin Panel）中設定 GitHub OAuth App 憑據，包括 `clientId` 和 `clientSecret`。OAuth 相關設定透過 `node-persist` 持久化儲存在 `data/_storage` 目錄中，而非 `config.yaml`。

你需要先在 GitHub 上建立一個 OAuth App，將回呼地址設定為 `https://your-domain/api/users/oauth/callback/github`。

## Discord OAuth 登入

Luker 同樣支援 Discord OAuth 登入，並提供更細緻的存取控制——可以校驗使用者是否為指定 Discord 伺服器的成員，以及是否擁有特定身分組（Role）。

同樣在管理面板中設定 Discord OAuth 憑據（`clientId`、`clientSecret`），並可設定 `allowedGuildIds` 和 `requiredRoleIds` 來限制存取權限。回呼地址為 `https://your-domain/api/users/oauth/callback/discord`。

這對於社群共享的 Luker 實例特別有用——只有你 Discord 伺服器中的特定成員才能登入使用。

::: tip
如果不需要 OAuth 登入，無需在管理面板中啟用 OAuth。Luker 仍然支援上述的 Basic Auth 和多使用者帳號認證方式。
:::

## 儲存配額管理

在多使用者部署中，管理員可以為每個使用者設定儲存空間配額，防止個別使用者佔用過多磁碟空間：

- **配額上限** — 使用者可使用的最大儲存空間

當使用者的儲存使用量超過配額時，相關的檔案上傳和儲存操作會被拒絕，直到使用者清理資料或管理員調整配額。

管理員可以在前端管理面板中為每個使用者單獨設定配額。

## 白名單

Luker 預設啟用 IP 白名單模式，且 `listen` 預設為 `false`（僅監聽本機回環地址），區域網路無法直接存取。如需區域網路存取，需要同時做兩件事：

1. **開啟監聽** — 將 `listen` 設為 `true`，使 Luker 監聽所有網路介面：

```yaml
listen: true
```

2. **設定白名單** — 將對應 IP 加入 `whitelist` 列表，或關閉 `whitelistMode`：

```yaml
whitelistMode: true
whitelist:
- ::1
- 127.0.0.1
- 192.168.1.0/24  # 你的區域網路網段
```

此外，Luker 還支援主機白名單（`hostWhitelist`），可以限制允許存取的主機地址，並支援自動掃描區域網路主機。

## 安全最佳實務

如果你需要將 Luker 暴露到公網，請務必做好以下安全防護：

1. **使用反向代理 + HTTPS** — 透過 Nginx、Caddy 等反向代理提供 HTTPS 加密，防止資料在傳輸過程中被竊聽
2. **啟用登入機制** — 開啟 Basic Auth 或多使用者帳號系統，防止未授權存取
3. **設定白名單** — 如果只需要特定 IP 存取，保持白名單模式開啟
4. **保護設定檔** — `config.yaml` 中包含 OAuth 金鑰等敏感資訊，請勿提交到公開儲存庫
5. **定期更新** — 及時更新 Luker 以取得最新的安全修復

::: warning
不要在沒有任何認證機制的情況下將 Luker 暴露到公網。即使是內網部署，也建議至少啟用 Basic Auth 保護。
:::

## 相關頁面

- [基礎設定](/zh-TW/guide/configuration) — 完整的設定項說明
- [認證與配額](/zh-TW/improvements/auth-and-quota) — 認證系統的技術細節
