# 服务端插件

服务端插件是运行在 Luker 服务端进程内的 Node.js 模块。前端扩展运行在浏览器，服务端插件则可以读写服务端文件系统、使用 Node.js 模块、代理外部 API 请求。插件路由挂载在 `/api/plugins/{plugin-id}/` 下。

::: warning
服务端插件没有沙箱隔离。插件与服务端进程拥有相同权限，请仅安装可信来源的插件。
:::

## 启用服务端插件

服务端插件默认关闭，在 `config.yaml` 中开启：

```yaml
enableServerPlugins: true
```

修改后重启 Luker。

## 打开服务端插件标签页

该标签页位于管理员面板，仅管理员可见。

1. 打开**用户设置**。
2. 选择**管理员面板**。
3. 选择**服务端插件**标签页。

![管理员面板中的服务端插件标签页](/images/server-plugins/01-server-plugins-tab.png)

标签页列出已安装的插件，显示其目录、版本、包元数据与 Git 远端。

## 从 Git 地址安装

将仓库地址粘贴到 **Git 仓库地址**输入框，然后选择**安装**。

![已填入 Git 仓库地址](/images/server-plugins/02-repo-url-entered.png)

Luker 会将仓库克隆到插件目录并加入列表。新安装的插件需重启后端才会加载。

## 安装依赖

插件声明 npm 依赖时，Luker 会在安装后检查，并提示安装缺失的依赖。

![提示安装缺失依赖](/images/server-plugins/03-dependency-prompt.png)

选择**安装依赖**进行安装。桌面端优先执行系统 `npm`，`npm` 不可用时回退到内置安装器；Android 端使用内置安装器，无需终端。选择**取消**则保持未安装状态，插件行会显示缺失数量与**安装依赖**按钮。

![显示缺失依赖与安装按钮的插件行](/images/server-plugins/04-dependencies-missing.png)

仅当插件声明了尚未安装的依赖时，插件行才会显示**安装依赖**按钮。依赖就绪后，插件行显示**依赖已安装**并隐藏该按钮。未声明依赖的插件不显示依赖状态与按钮。

![安装依赖后的插件行](/images/server-plugins/05-dependencies-installed.png)

## 重启后端

插件在启动时加载。安装或更新插件后，重启 Luker 才会加载。控制台会记录加载的插件：

```
[Plugin Loader] Loaded plugin: My Plugin (my-plugin)
```

## 验证插件路由

服务端插件路由挂载在 `/api/plugins/{plugin-id}/` 下。请求插件的某个路由即可确认其已加载。对于 id 为 `hello-world`、提供 `GET /hello` 路由的插件：

```bash
curl http://localhost:8000/api/plugins/hello-world/hello
```

返回 JSON 即表示插件正在运行。

## 手动安装

也可以将插件文件或目录直接放入插件目录，默认位于项目根目录的 `plugins/`，然后重启 Luker。为手动放置的插件安装依赖时，可在服务端插件标签页使用其**安装依赖**按钮，或在桌面端于插件目录内执行 `npm install`。

## 故障排查

### 依赖缺失

插件因依赖缺失而加载失败时，在服务端插件标签页从对应插件行安装依赖，然后重启 Luker。

### 原生模块

部分 npm 包在安装时编译原生代码。Android 端的安装不执行构建脚本，因此需要编译原生代码的包无法在 Android 端安装。请先在桌面端安装此类包，再将插件目录复制到设备。

### Git 不可用

系统 Git 不可用时，Luker 使用内置实现克隆 HTTP(S) 地址；SSH 地址需要系统 Git。克隆 SSH 地址失败时，安装 Git 后重新安装该插件。

## 相关页面

- [服务端插件开发](/zh-CN/development/server-plugin) — 为 Luker 构建服务端插件
- [基础配置](/zh-CN/guide/configuration) — 配置参考
