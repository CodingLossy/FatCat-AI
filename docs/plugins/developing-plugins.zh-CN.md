# 开发 FatCat-AI 插件

_English version: [developing-plugins.md](developing-plugins.md)。_

插件是一个目录(或通过市场发布的 `.tgz` 包),里面有 `plugin.json` 清单和一个通过 stdio 说 MCP 的 JavaScript 入口。
服务器把它作为独立进程启动,向它询问工具,并把清单里声明过的工具注册成 `plugin.<id>.<tool>`;每次调用仍然走正常的审批流程。
设计在 [ADR 0040](../adr/0040-plugins-and-market.md),本页讲实际怎么做。

## 1. 最小的插件

```
my-plugin/
  plugin.json
  server.mjs      # 一个文件:把依赖打包进去
```

```json
{
  "manifestVersion": 1,
  "id": "hello",
  "version": "0.1.0",
  "name": { "en": "Hello" },
  "description": { "en": "Greets people" },
  "author": "You",
  "license": "Apache-2.0",
  "engines": { "fatcat": ">=1.1.0" },
  "entry": { "type": "mcp-stdio", "main": "server.mjs" },
  "permissions": { "tools": [{ "name": "hello", "risk": "read" }] }
}
```

```js
import { definePlugin } from '@fatcat-ai/plugin-sdk';

const plugin = definePlugin({ name: 'hello', version: '0.1.0' });
plugin.registerTool({
  name: 'hello',
  description: 'Greet someone by name.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  handler: (args) => `Hello, ${String(args.name)}!`,
});
await plugin.run();
```

带设置、经服务器代发的网络请求、知识地图条目和任务模板的完整示例在
[`examples/plugins/hello`](../../examples/plugins/hello)。也可以把已有的 JavaScript MCP 服务器打包成插件:把它打成单个
`.mjs` 文件,在 `permissions.tools` 里列出它的工具名,`entry.main` 指向它即可;这种情况下不需要 SDK,因为协议就是普通的 MCP。

## 2. 权限是声明出来的,不是运行时申请的

清单的 `permissions` 就是全部契约。用户安装前能看到全部内容,没写在里面的一律不能用:

| 字段                 | 含义                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `tools[]`            | 工具名与声明的级别:`read`、`write`、`external`(不允许 `dangerous`)。`sendsData: true` 表示工具会把用户的数据发到外部。  |
| `net[]`              | 插件可以经服务器(`ctx.fetch`)访问的域名;`*.com` 这类过宽的写法会被拒绝。                                                |
| `secrets[]`          | 密钥名(大写下划线,不能以 `FATCAT_AI_` 或改名前的旧前缀 `AIP_` 开头);用户把每个密钥绑定到 `env:名字` 引用,值不会被保存。 |
| `items.categories[]` | 插件提供的知识地图条目类别。                                                                                            |

插件提供了但没声明的工具不会被注册。工具实际的级别是声明的级别加两条下限:只要插件声明了任何 `net` 域名,`read` 工具就被提到 `write`;带 `sendsData: true` 的工具一律是 `external`,不能预授权。单有 `net` 权限不会让工具变成 `external`。

## 3. SDK 提供什么

- `registerTool({ name, description, inputSchema, handler })`:`handler(args, ctx)` 返回字符串或 `ToolResult`,可以是异步的。
- `ctx.fetch(url)`:由服务器代发的 HTTPS 请求,只能访问 `permissions.net` 里的域名,并受服务器的地址检查约束(不能访问私网地址、重定向会重新检查、有大小与时间限制)。
  平台能做到时,插件进程本身没有直接联网的能力,所以请用 `ctx.fetch`,不要用全局 `fetch`。
- `ctx.settings`:清单里 `settings` 声明的值(JSON Schema 的一个小子集:string、number、boolean);表单由服务器渲染,改了设置会重启插件。
- `ctx.secret(name)`:用户绑定给插件的密钥。
- `ctx.log(...)`:写入服务器日志,密钥值会被打码。
- `registerItemProvider({ type, roots, children, open })` 与 `ctx.items.upsert(...)`:向知识地图添加条目。
- 进程每 30 秒发一次带内存读数的心跳。

## 4. 沙箱做什么、不做什么

服务器用 Node 的权限模型加一个预加载脚本启动插件:它读不到服务器的数据目录、其他插件的数据和主密钥;不继承服务器的环境变量;
子进程、worker、原始套接字等内置模块被拦截。**这些保护在各平台上做到什么程度不同**,安装页会如实显示当前平台的程度(强制、多层防护、自报、不保证)。
尤其是直接联网:只有在有操作系统层隔离的平台上才由系统拦截;没有的平台上,本地目录里的插件根本不能声明 `net`,只有经过审核的市场插件可以。
安装页没有标为「强制」的事,不要指望沙箱兜底。

插件自己的数据放在服务器提供的目录里(`ctx.dataDir`,即 `plugin-data/<id>/`)。它不在服务器的常规备份里,但每次升级前服务器会复制一份。如果这个目录超过 500 MiB,服务器不复制:升级会被拒绝(`plugin_backup_too_large`),直到用户确认「不备份直接升级」(`skipDataBackup`);这样升级后如果失败,数据无法恢复。大缓存请放在别处,或者保持很小。

## 5. 本地安装与测试

1. 在网页里打开「插件」,填你的目录的绝对路径,点「检查」,看权限和保护程度表,勾选同意并安装。「检查」只复制并检查包,不会运行你的代码。
2. 绑定密钥(`env:名字`)、保存设置、启用插件。
3. 让助手使用这个工具。调用时会请求审批,除非用户已预授权。

本地安装会显示为「未经市场审核」「未签名」。命令行里对应 `fatcat-ai plugins install <目录>`、`plugins market`、`plugins install --market <市场 id> <插件 id>` 和 `plugins rollback <id>`。

## 6. 版本、升级与回退

使用语义化版本。安装已装插件的更高版本时,对话框会列出权限变化:新工具、级别升高、新增 `sendsData`、新域名、新密钥和新类别都需要用户同意。
服务器会备份 `plugin-data/<id>/`(超过 500 MiB 的例外见第 4 节),启动新版本,检查握手和 `tools/list` 正常且**你声明的每个工具都在**;不通过就恢复旧版本和数据。
用户也可以在插件页回退到上一个版本,所以请让插件的数据格式向后兼容一个版本,这样回退后仍能工作。

`engines.fatcat` 是你支持的服务器版本范围(`>=1.1.0` 或 `>=1.1.0 <2.0.0`)。服务器之后升级到范围之外时,插件会被标为不兼容、不启动,直到你发布兼容的版本。

## 7. 发布到市场

官方市场是公开仓库里的一份签名的 `index.json`。包是根目录有 `plugin.json` 的 `.tgz`(不能有符号链接、硬链接、`..`、盘符或 Windows 保留名;大小与文件数有上限)。
索引按版本列出下载地址、大小、sha256、权限与 `engines`;客户端会验证签名、校验和,以及包内 `plugin.json` 与索引条目一致。
先过维护者的 CI 检查与审核,再离线签名。

打包方法:把入口打成单个文件(例如 esbuild 的 `--bundle --platform=node --format=esm`),放在 `plugin.json` 旁边,运行
`node scripts/plugins/pack-plugin.mjs <目录>`。输出可复现(同一个目录永远得到同样的字节),并用与索引 CI 相同的读取器和静态扫描自检,
最后打印大小、sha256 和 `index.json` 里这个版本的条目草稿。静态扫描只查加载被拒绝内置模块的写法(`import`、`import()`、`require`、`createRequire`、
`getBuiltinModule`)、`process.binding`、`process.dlopen`、`eval` 和 `new Function`;运行时拼出来的名字它看不到,那部分由第 4 节的沙箱负责。
索引工具见 [`scripts/plugins/README.md`](../../scripts/plugins/README.md)。签名与校验和只说明包就是审核时的那个,不保证它无害。

## 8. 许可

插件使用作者自选的许可证。SDK(`@fatcat-ai/plugin-sdk`)为 Apache-2.0。当前版本只支持免费插件(`licensing.model` 为 `free`)。
