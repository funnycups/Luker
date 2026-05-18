# 认证与配额

Luker 内置了多用户认证和配额管理系统，适用于团队共享实例或公开部署的场景。管理员可以通过 OAuth 登录、存储配额和日志系统全面管控用户的访问和资源消耗。

## 认证系统

### 自助注册

登录页面可以展示「创建账户」表单，供访客直接注册账户。该功能默认关闭，由管理员面板切换（保存在 `admin-settings.json` 的 `accountRegistration` 配置段中）：

```json
{
  "accountRegistration": {
    "enabled": false
  }
}
```

通过此方式创建的账户始终为非管理员，创建后立即启用，并继承默认存储配额。功能关闭时，注册接口无论请求内容如何都会返回 HTTP 403，因此表单无法被绕过启用。

### GitHub OAuth 登录

Luker 支持通过 GitHub OAuth 进行用户认证。用户点击登录后，会被重定向到 GitHub 授权页面，授权完成后自动创建或关联本地用户账户。

配置方式：在前端管理员面板中配置 GitHub OAuth App 的凭据（存储在 `admin-settings.json` 的 `oauth` 配置段中）：

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

### Discord OAuth 登录

Luker 同样支持 Discord OAuth 登录，并提供更细粒度的访问控制——可以校验用户是否为指定 Discord 服务器的成员，以及是否拥有特定身份组（Role）。

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

OAuth 回调地址由系统根据当前请求自动生成（格式为 `{protocol}://{host}/api/users/oauth/callback/{provider}`），无需手动配置。

::: tip
如果不需要 OAuth 登录，无需配置 `oauth` 段。Luker 仍然支持 SillyTavern 原有的用户认证方式。OAuth 配置推荐在前端管理员面板中进行。
:::

## 用户配额管理

### 存储配额（Storage Quota）

管理员可以为每个用户设置存储空间配额，控制文件存储的资源消耗：

- **配额上限** — 用户可使用的最大存储空间

::: tip Token 用量统计
请求检查器追踪的 Token 用量是独立的统计功能，与存储配额管理是两个独立的系统。详见[请求检查器](/zh-CN/improvements/request-inspector)。
:::

当用户的存储使用量超过配额上限时，系统会阻止进一步的数据写入（返回 413 状态码）。管理员可以在前端管理面板中为用户设置和调整配额。

## 日志系统

Luker 实现了服务端日志捕获系统，供管理员远程查看服务器运行状态。

Luker 的日志系统覆盖后端和前端，帮助管理员远程排查问题。详见[日志系统](/zh-CN/features/logging)。

## 配置参考

以下是 `admin-settings.json` 中与 OAuth 相关的配置项（通过管理员面板设置）：

| 配置路径 | 类型 | 默认值 | 用途 |
|---------|------|--------|------|
| `accountRegistration.enabled` | boolean | `false` | 是否在登录页展示自助注册表单 |
| `oauth.github.enabled` | boolean | `false` | 是否启用 GitHub OAuth |
| `oauth.github.clientId` | string | — | GitHub OAuth 客户端 ID |
| `oauth.github.clientSecret` | string | — | GitHub OAuth 客户端密钥 |
| `oauth.github.allowAutoCreate` | boolean | `false` | 是否允许自动创建用户 |
| `oauth.discord.enabled` | boolean | `false` | 是否启用 Discord OAuth |
| `oauth.discord.clientId` | string | — | Discord OAuth 客户端 ID |
| `oauth.discord.clientSecret` | string | — | Discord OAuth 客户端密钥 |
| `oauth.discord.allowAutoCreate` | boolean | `false` | 是否允许自动创建用户 |
| `oauth.discord.requireGuildMembership` | boolean | `false` | 是否要求服务器成员身份 |
| `oauth.discord.allowedGuildIds` | string[] | `[]` | 允许的 Discord 服务器 ID 列表 |
| `oauth.discord.requiredRoleIds` | string[] | `[]` | 要求的身份组 ID 列表 |

> [!WARNING]
> OAuth 密钥属于敏感信息。`admin-settings.json` 存储在服务器数据目录中，请确保该目录的访问权限受到保护。推荐通过管理员面板进行配置。
