# 局域网访问

Luker 以 Web 服务的形式运行，默认仅接受本机连接，同一网络中的手机、平板或另一台电脑无法访问。开启局域网访问后，这些设备即可通过浏览器使用同一套 Luker 数据。

常见用途：

- 电脑运行服务，手机或平板随时使用
- 家中多台设备共享同一套角色卡与聊天记录
- 在 iPhone 或 iPad 上使用 Luker，可安装自签名应用或通过浏览器访问

如果目标是在两台 Luker 之间同步数据，请见[局域网同步](/zh-CN/improvements/lan-sync)，那是另一项功能。

## 默认配置为何无法访问

以下设置会阻止局域网访问：

- `listen: false` —— Luker 仅绑定回环地址，其他设备根本无法建立连接。
- `whitelistMode: true` —— Luker 拒绝所有不在 `whitelist` 列表中的地址。

在默认配置下，局域网设备要么连接失败，要么在开启监听后收到 HTTP `403 Forbidden` 页面，服务端控制台同时打印 `Blocked connection from <ip>`。

要允许局域网访问，需要同时修改监听设置与白名单。

## 开启监听

打开 Luker 根目录下的 `config.yaml`，设置：

```yaml
listen: true
```

`listenAddress` 与 `protocol` 保持默认即可：

```yaml
listenAddress:
  ipv4: 0.0.0.0
  ipv6: "[::]"
protocol:
  ipv4: true
  ipv6: false
```

启动后，控制台会打印 `Luker is listening on IPv4: 0.0.0.0:8000`，而不再是回环地址。修改文件后需重启服务。

## 允许局域网设备访问

### 方式一：将局域网加入白名单

保持 `whitelistMode: true`，把设备所在的网段加入列表：

```yaml
whitelistMode: true
whitelist:
  - ::1
  - 127.0.0.1
  - 192.168.0.0/16
```

支持单个地址、CIDR 网段以及 `192.168.1.*` 这类通配符。请保留 `127.0.0.1` 与 `::1`，否则本机也无法访问。若不确定网段，可一次加入全部私有地址范围：

```yaml
whitelist:
  - ::1
  - 127.0.0.1
  - 10.0.0.0/8
  - 172.16.0.0/12
  - 192.168.0.0/16
```

### 方式二：关闭白名单

将 `whitelistMode` 设为 `false` 后，Luker 会接受任意地址。此配置被视为不安全，Luker 要求至少还有一层防护，否则在启动时退出：

- 启用 Basic Auth，见[鉴权与安全](/zh-CN/guide/authentication)
- 启用多用户账户，并为每个管理员用户设置密码
- 设置 `securityOverride: true`，仅用于调试

## 查询主机地址

在运行 Luker 的机器上查询其局域网地址：

```bash
# Windows
ipconfig

# macOS
ipconfig getifaddr en0

# Linux
hostname -I
```

找到形如 `192.168.1.23` 的私有网段 IPv4 地址。

## 从另一台设备访问

在另一台设备上打开浏览器，输入主机地址与端口：

```
http://192.168.1.23:8000
```

使用 `http://`，不要用 `https://`。地址必须是主机的局域网地址，而非 `localhost`。

## Docker

[快速开始](/zh-CN/guide/getting-started)中的 Docker compose 文件将端口绑定到 `127.0.0.1:8000`，请求在到达 Luker 之前就会被拦截。将端口映射改为在所有网卡上发布，并在挂载的 `config.yaml` 中设置 `listen: true` 与白名单：

```yaml
ports:
  - 0.0.0.0:8000:8000
```

## 安全

局域网并不天然可信，公共 Wi-Fi 尤其如此。向其他设备开放 Luker 之前：

- 启用 Basic Auth 或多用户账户系统。
- 只有少数设备需要访问时，保持白名单范围尽量窄。
- 不要在路由器上配置端口转发。若需从局域网外访问 Luker，请改用 VPN 或隧道服务。

## iOS

iPhone 与 iPad 可安装自签名应用在本机运行，也可通过浏览器访问另一台设备上的 Luker。两种方式见 [iOS](/zh-CN/guide/ios)。

## 排查

- **出现 403 Forbidden 页面** —— 设备地址不在白名单中，将其加入或放宽网段。
- **连接超时或被拒绝，且控制台没有任何输出** —— 服务不可达。检查 `listen` 是否为 `true`，以及主机防火墙是否放行该端口：
  - Windows：在防火墙中放行 Node.js，并将网络配置文件设为「专用」。
  - Linux：`sudo ufw allow 8000`
  - macOS：在「系统设置」中允许 Node 进程的传入连接。
- **只有主机能连接** —— 另一台设备使用的仍是 `localhost`，请改用主机的局域网地址。

## 相关页面

- [基础配置](/zh-CN/guide/configuration) —— 完整的配置项说明
- [鉴权与安全](/zh-CN/guide/authentication) —— Basic Auth、账户与白名单
- [局域网同步](/zh-CN/improvements/lan-sync) —— 在两台 Luker 之间同步数据
