# 鉴权与安全

Luker 提供了多层次的访问控制和安全机制，从简单的密码保护到 OAuth 社交登录，再到存储配额管理，满足从个人使用到团队共享的各种部署场景。

## Basic Auth 模式

最简单的访问保护方式。启用后，访问 Luker 时需要输入用户名和密码：

```yaml
basicAuthMode: true
basicAuthUser:
  username: user
  password: password
```

适用于单用户场景，例如你在服务器上部署了 Luker 并希望防止他人访问。

::: tip
Basic Auth 是 HTTP 层面的认证，浏览器会弹出原生的登录对话框。如果你需要更友好的登录界面和多用户支持，请使用多用户账户系统。
:::

## 多用户账户系统

启用多用户模式后，每个用户拥有独立的数据目录和登录凭据：

```yaml
enableUserAccounts: true
```

### 创建和管理用户

启用多用户模式后，管理员可以在前端管理面板中创建、编辑和删除用户账户。每个用户的数据（角色卡、聊天记录、预设等）存储在独立的子目录中，互不干扰。

### 默认用户

系统内置了一个名为 `default-user` 的默认用户。如果你从单用户模式切换到多用户模式，之前的数据会归属于这个默认用户。

### 密码重置

如果忘记了用户密码，可以通过命令行工具重置：

```bash
# 重置用户密码
node recover.js <用户名> <新密码>

# 例如重置 default-user 的密码
node recover.js default-user myNewPassword

# 不提供密码则清空密码
node recover.js default-user
```

::: tip
此命令需要在 Luker 项目根目录下执行，服务无需处于运行状态。
:::

### 网页端密码恢复

除了命令行工具，Luker 还支持通过网页端发起密码恢复流程。用户在登录页面点击「忘记密码」后，系统会生成一个恢复码并**打印在服务端控制台**中。管理员将恢复码告知用户，用户即可在网页上完成密码重置。

::: warning
恢复码仅在服务端控制台输出，请确保只有受信任的管理员能够查看控制台日志。
:::

### 隐蔽登录模式

```yaml
enableDiscreetLogin: true
```

启用后，登录页面不会显示明显的 Luker 标识，适用于需要低调部署的场景。

## GitHub OAuth 登录

Luker 支持通过 GitHub 账号登录。用户点击登录后会被重定向到 GitHub 授权页面，授权完成后自动创建或关联本地用户账户。

配置方式：在管理面板（Admin Panel）中配置 GitHub OAuth App 凭据，包括 `clientId` 和 `clientSecret`。OAuth 相关设置存储在 `admin-settings.json` 中，而非 `config.yaml`。

你需要先在 GitHub 上创建一个 OAuth App，将回调地址设置为 `https://your-domain/api/users/oauth/callback/github`。

## Discord OAuth 登录

Luker 同样支持 Discord OAuth 登录，并提供更细粒度的访问控制——可以校验用户是否为指定 Discord 服务器的成员，以及是否拥有特定身份组（Role）。

同样在管理面板中配置 Discord OAuth 凭据（`clientId`、`clientSecret`），并可设置 `allowedGuildIds` 和 `requiredRoleIds` 来限制访问权限。回调地址为 `https://your-domain/api/users/oauth/callback/discord`。

这对于社区共享的 Luker 实例特别有用——只有你 Discord 服务器中的特定成员才能登录使用。

::: tip
如果不需要 OAuth 登录，无需在管理面板中启用 OAuth。Luker 仍然支持上述的 Basic Auth 和多用户账户认证方式。
:::

## 存储配额管理

在多用户部署中，管理员可以为每个用户设置存储空间配额，防止个别用户占用过多磁盘空间：

- **配额上限** — 用户可使用的最大存储空间

当用户的存储使用量超过配额时，相关的文件上传和保存操作会被拒绝，直到用户清理数据或管理员调整配额。

管理员可以在前端管理面板中为每个用户单独设置配额。

## 白名单

Luker 默认启用 IP 白名单模式，仅允许本机访问：

```yaml
whitelistMode: true
whitelist:
  - ::1
  - 127.0.0.1
```

如需局域网访问，将对应 IP 加入 `whitelist` 列表，或关闭 `whitelistMode`。

此外，Luker 还支持主机白名单（`hostWhitelist`），可以限制允许访问的主机地址，并支持自动扫描局域网主机。

## 安全最佳实践

如果你需要将 Luker 暴露到公网，请务必做好以下安全防护：

1. **使用反向代理 + HTTPS** — 通过 Nginx、Caddy 等反向代理提供 HTTPS 加密，防止数据在传输过程中被窃听
2. **启用登录机制** — 开启 Basic Auth 或多用户账户系统，防止未授权访问
3. **配置白名单** — 如果只需要特定 IP 访问，保持白名单模式开启
4. **保护配置文件** — `config.yaml` 中包含 OAuth 密钥等敏感信息，请勿提交到公开仓库
5. **定期更新** — 及时更新 Luker 以获取最新的安全修复

::: warning
不要在没有任何认证机制的情况下将 Luker 暴露到公网。即使是内网部署，也建议至少启用 Basic Auth 保护。
:::

## 相关页面

- [基础配置](/zh-CN/guide/configuration) — 完整的配置项说明
- [认证与配额](/zh-CN/improvements/auth-and-quota) — 认证系统的技术细节
