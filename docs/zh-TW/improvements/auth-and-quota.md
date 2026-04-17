# 認證與配額

Luker 內建了多使用者認證和配額管理系統，適用於團隊共享實例或公開部署的場景。管理員可以透過 OAuth 登入、儲存配額和日誌系統全面管控使用者的存取和資源消耗。

## 認證系統

### GitHub OAuth 登入

Luker 支援透過 GitHub OAuth 進行使用者認證。使用者點擊登入後，會被重新導向到 GitHub 授權頁面，授權完成後自動建立或關聯本地使用者帳戶。

配置方式：在前端管理員面板中配置 GitHub OAuth App 的憑證（儲存在 `admin-settings.json` 的 `oauth` 配置段中）：

```json
{
  "oauth": {
    "github": {
      "enabled": true,
      "clientId": "your-github-client-id",
      "clientSecret": "your-github-client-secret",
      "allowAutoCreate": false
    }
  }
}
```

### Discord OAuth 登入

Luker 同樣支援 Discord OAuth 登入，並提供更細粒度的存取控制——可以校驗使用者是否為指定 Discord 伺服器的成員，以及是否擁有特定身分組（Role）。

```json
{
  "oauth": {
    "discord": {
      "enabled": true,
      "clientId": "your-discord-client-id",
      "clientSecret": "your-discord-client-secret",
      "allowAutoCreate": false,
      "requireGuildMembership": false,
      "allowedGuildIds": [],
      "requiredRoleIds": []
    }
  }
}
```

OAuth 回呼位址由系統根據當前請求自動產生（格式為 `{protocol}://{host}/api/users/oauth/callback/{provider}`），無需手動配置。

::: tip
如果不需要 OAuth 登入，無需配置 `oauth` 段。Luker 仍然支援 SillyTavern 原有的使用者認證方式。OAuth 配置建議在前端管理員面板中進行。
:::

## 使用者配額管理

### 儲存配額（Storage Quota）

管理員可以為每個使用者設定儲存空間配額，控制檔案儲存的資源消耗：

- **配額上限** — 使用者可使用的最大儲存空間

::: tip Token 用量統計
請求檢查器追蹤的 Token 用量是獨立的統計功能，與儲存配額管理是兩個獨立的系統。詳見[請求檢查器](/zh-TW/improvements/request-inspector)。
:::

當使用者的儲存使用量超過配額上限時，系統會阻止進一步的資料寫入（回傳 413 狀態碼）。管理員可以在前端管理面板中為使用者設定和調整配額。

## 日誌系統

Luker 實現了伺服端日誌擷取系統，供管理員遠端查看伺服器運行狀態。

Luker 的日誌系統涵蓋後端和前端，幫助管理員遠端排查問題。詳見[日誌系統](/zh-TW/features/logging)。

## 配置參考

以下是 `admin-settings.json` 中與 OAuth 相關的配置項（透過管理員面板設定）：

| 配置路徑 | 類型 | 預設值 | 用途 |
|---------|------|--------|------|
| `oauth.github.enabled` | boolean | `false` | 是否啟用 GitHub OAuth |
| `oauth.github.clientId` | string | — | GitHub OAuth 用戶端 ID |
| `oauth.github.clientSecret` | string | — | GitHub OAuth 用戶端密鑰 |
| `oauth.github.allowAutoCreate` | boolean | `false` | 是否允許自動建立使用者 |
| `oauth.discord.enabled` | boolean | `false` | 是否啟用 Discord OAuth |
| `oauth.discord.clientId` | string | — | Discord OAuth 用戶端 ID |
| `oauth.discord.clientSecret` | string | — | Discord OAuth 用戶端密鑰 |
| `oauth.discord.allowAutoCreate` | boolean | `false` | 是否允許自動建立使用者 |
| `oauth.discord.requireGuildMembership` | boolean | `false` | 是否要求伺服器成員身分 |
| `oauth.discord.allowedGuildIds` | string[] | `[]` | 允許的 Discord 伺服器 ID 列表 |
| `oauth.discord.requiredRoleIds` | string[] | `[]` | 要求的身分組 ID 列表 |

> [!WARNING]
> OAuth 密鑰屬於敏感資訊。`admin-settings.json` 儲存在伺服器資料目錄中，請確保該目錄的存取權限受到保護。建議透過管理員面板進行配置。
