# 犇马 · SuperWagie

犇马（SuperWagie）是一个面向办公场景的桌面客户端：打开就是工作台，写下要做的事，或者直接开始一个会话。它基于 [OpenChamber](https://github.com/openchamber/openchamber) 定制，用 OpenCode 作为智能体内核。

## 工作台

首屏是工作台，而不是聊天窗口：

- 左侧写下要做的事，回车或点「开始」就会带着这句话开一个会话；「创建待办」会直接把标题写进任务文件。
- 右侧是日历（周视图 / 月视图，点日期看当天任务）、今日 / 逾期 / 未排期 / 本周完成，以及最近的会话。
- 任意会话顶部都有「工作台 ›」面包屑，点一下回到首页。

## 任务用 Markdown 保存

任务是普通的 Markdown 文件，可以直接读、直接改，也可以放进版本库：

- 全局任务：`~/.config/openchamber/tasks.md`
- 项目任务：项目根目录的 `任务.md`

每条任务是一行 Markdown，行尾用 `<!-- sw {...} -->` 记录状态、来源、截止日期等元数据。工作台会检测文件在别处被修改的情况，避免覆盖手改内容。

## 其它

- 中文优先，界面里的 OpenCode 统一显示为「内核」。
- 配色跟随应用主题：浅色、深色和强调色都会实时同步到工作台。
- 会话里的消息可以「存为任务」。
- 应用包名 `com.quukk.superwagie`，深链 `lingxi://`。
- 关闭了上游自动更新，避免被 OpenChamber 的安装包替换。

## 内置技能

首次启动时，应用会把下面这些技能装进 OpenCode 的技能目录（`~/.config/opencode/skills`）；同名技能已经存在（包括 `~/.claude/skills`、`~/.agents/skills` 里的）就跳过，不覆盖：

- **SuperPPT**，连同 `ai-image-to-ppt`、`image-to-editable-pptx`
- **SuperWriter**，连同 `WPSComposer`、`grilling` / `grill-me` / `grill-with-docs` / `to-spec` / `domain-modeling`、`obsidian-excalidraw`
- **SuperVideo**，连同它固定版本的渲染引擎

技能来源、许可证与已知缺失的许可证记录在 `packages/web/server/builtin-skills/NOTICE.md`。

## 运行

### 环境

- Node.js >= 24.14.0
- Bun 1.4.3

```bash
bun install
```

### 桌面端开发

```bash
bun run electron:dev
```

### 打包

```bash
bun run extensions:build
bun run electron:build
```

macOS 产物在 `packages/electron/dist/`，安装包名为 `SuperWagie-<版本>-mac-arm64.dmg`。

### Web 端

```bash
bun run dev
```

## 目录

```
packages/ui         共享界面、状态与运行时契约
packages/electron   桌面壳与原生能力
packages/web        本地服务、OpenCode 生命周期与 CLI
packages/extensions 内置扩展（workbench 工作台在这里）
packages/sdk        第三方面板的扩展 SDK
```

## 与 OpenChamber 的关系

这是一个 OpenChamber 的定制分支，保留了上游的 MIT 许可证与版权声明。为了减少和上游合并时的冲突，内部标识（`@openchamber/*` 包名、`openchamber` CLI、`~/.config/openchamber`、`openchamber-ui://` 协议）没有改名，只有用户可见的品牌、窗口标题、菜单和安装包换成了犇马 / SuperWagie。

上游仓库保留为 `upstream`：

```bash
git fetch upstream
git merge upstream/main
```

## 已知限制

- 目前只验证了 macOS arm64 打包；Windows 需要在 Windows 机器或 CI 上出包。
- macOS 包使用 ad-hoc 签名，未做 Apple 公证，首次打开可能需要右键「打开」。
- 自更新关闭，升级需要手动安装新版本。

## 许可证

本项目以 [Apache License 2.0](LICENSE) 发布。

它包含来自 OpenChamber 的 MIT 代码，原始版权与许可文本保留在
[LICENSE-MIT-OPENCHAMBER](LICENSE-MIT-OPENCHAMBER)；第三方组件（如内置的 WeKnora Lite）
遵循各自协议，见 [NOTICE](NOTICE)。
