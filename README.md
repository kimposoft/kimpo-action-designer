# kimpo-action-designer

Kimpo 官方「动作设计器」插件的源码。插件 ID：`com.kimposoft.actiondesigner`。

它是一个纯前端插件，挂在宿主模板设计器的 `action-designer` surface 上：设计者在模板设计时为表单与字段上的事件编排动作流程——在画布上拖放动作节点、配置节点参数与触发条件、用表达式绑定取值，保存后由宿主动作引擎在填报时执行。

- 内置节点配置面板：数据动作（取数 / 新增 / 修改 / 删除 / 明细排序）、表单操作与联动表单、提示语、切换分页、打印等；其他插件声明的动作走通用参数表单，或由提供方插件的 `action-config` surface 提供配置面板；
- 条件与取值表达式复用 [`@kimposoft/expression-editor`](https://www.npmjs.com/package/@kimposoft/expression-editor)；
- 设计器窗口外壳使用 [`@kimposoft/ui-kit`](https://www.npmjs.com/package/@kimposoft/ui-kit) 的 `KDialog`，窗口尺寸经宿主按用户记忆。

插件不直接请求宿主 API：动作目录、模板 / 字段目录、表达式语法检查与保存检查等能力全部经宿主注入的交互会话（`platform.interactiveSession`）与 `domain:action-designer` 能力提供；动作的深层结构校验由宿主保存时完成。

## 依赖

- Node.js 18+ 与 npm
- Kimpo 插件 SDK 前端包 [`@kimposoft/plugin-sdk`](https://www.npmjs.com/package/@kimposoft/plugin-sdk) `1.1.0-tp.20`
- 前端共享包：`@kimposoft/expression-editor` `1.1.0-tp.2`（打进 bundle）、`@kimposoft/ui-kit` `1.1.0-tp.2`（见下文「运行期依赖」）
- 打包与预检：`zip`，以及 SDK 的签名 / 预检工具 `kimpo-plugin-sign`（Go 工具；没有 Go 时可跳过预检）

以上 Kimpo 包均为预览版（见 `frontend/package.json`）。

## 运行期依赖（宿主提供）

前端 UMD 产物把下面三个依赖外部化，不打进 bundle，运行时由 Kimpo 宿主以全局变量注入：

| 包 | 全局变量 |
|---|---|
| `vue` | `Vue` |
| `naive-ui` | `naive` |
| `@kimposoft/ui-kit` | `KimpoUi` |

`frontend/package.json` 里把它们列为 devDependencies / peerDependencies，只用于本地类型检查、单测与构建；脱离 Kimpo 宿主单独加载 `plugin.umd.js` 不能运行。

## 从源码构建 .kpp

```sh
# 可选：先装好预检工具（不装时 build.sh 会用 go run 临时编译，需要 Go ≥ 1.23）
GOWORK=off go install github.com/kimposoft/kimpo-plugin-sdk/cmd/kimpo-plugin-sign@v1.1.0-tp.20

bash build.sh
```

`build.sh` 依次执行 `npm ci` → `npm test`（vitest）→ `vite build`（单个 UMD 文件 `frontend/dist/plugin.umd.js`，样式内联）→ 组装 `.kpp` → `kimpo-plugin-sign lint`，产物在 `release/<插件ID>-<版本>.kpp`。前端开发时也可以在 `frontend/` 下直接用 `npm test`、`npm run typecheck`、`npm run build`。

包内结构：`manifest.json`、`frontend/plugin.umd.js`、`frontend/locales/`。

## 关于签名与插件 ID

- `com.kimposoft.*` / `com.kimpo.*` 是 Kimposoft 保留命名空间。**官方签名的安装包只由 Kimposoft 发布**，本仓库不含任何签名私钥。
- 用本仓库源码自行构建的包没有官方签名，宿主会按官方命名空间拦截安装；`kimpo-plugin-sign lint` 也会报 `reserved_plugin_namespace` 错误。
- 如需安装自己构建的版本，请把 `manifest.json` 的 `plugin_id`、`i18n.namespace` 改成你自己的插件 ID（如 `com.example.actiondesigner`），并按需修改 `capabilities.frontend.global_name` 与 `frontend/vite.config.ts` 里的 UMD 全局名（两者必须一致），以第三方插件身份安装；第三方前端一律在宿主沙箱框架（iframe）里运行，动作设计器 surface 依赖的部分宿主能力可能只对官方插件开放（以 lint 提示为准）。签名用你自己的密钥（`KIMPO_PLUGIN_SIGNING_KEY_FILE=<私钥文件> bash build.sh`），流程见 SDK 文档 `docs/third-party/`。

## 许可证

[Apache License 2.0](LICENSE)，Copyright 2026 金宝量行（无锡）软件有限公司，附加声明见 [NOTICE](NOTICE)。Kimpo 名称与 logo 图形是金宝量行（无锡）软件有限公司的商标标识，Apache-2.0 不授予商标使用权。
