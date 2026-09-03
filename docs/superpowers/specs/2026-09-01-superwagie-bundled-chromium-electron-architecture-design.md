# SuperWagie Electron、Rust Product Core 与隔离执行架构设计

> 状态：已确认架构基线；采用方案 B“分层模块化核心”；受影响 Gate 证据按 `solution-b-v1` 重新准入  
> 日期：2026-09-01  
> 决策：Electron + 随基础安装包分发的 Chromium 是唯一桌面壳；Rust Product Core 是唯一业务、数据与策略权威；高风险和长任务由隔离 Worker 执行

## 1. 决策背景

SuperWagie 的 Markdown、Excalidraw、draw.io、HTML Review 与视频渲染都依赖现代浏览器能力。视频又要求固定 Chromium 身份和确定性渲染，因此继续使用 Tauri/System WebView，再额外携带 Headless Chromium，会形成 WKWebView、WebView2 与 Chromium 三套兼容链。

本架构保留 Electron + bundled Chromium 的单壳方向，同时修正此前两个问题：

1. Electron Main 运行 Node.js 并拥有桌面系统 API，技术上属于客户端可信计算基，不能被描述成真正不可信；它应被约束为**可信但非业务权威的 Shell Controller**。
2. Rust 权威不等于把 Workspace、Workflow、WPS、FFmpeg、扩展、安装和视频全部塞进一个进程；应采用**一个 Rust Product Core + 多个隔离执行 Worker**，缩小故障域和权限域。

最终原则：

> Electron 负责桌面承载，Rust Core 负责事实与策略，Worker 负责有副作用执行，Renderer 只负责交互和呈现。

## 2. 目标与非目标

### 2.1 目标

- 一套 Chromium/Blink/V8/Web API 基线覆盖受维护的现代 macOS 与 Windows 11；
- Ubuntu/Linux 只是未来 best-effort 打包目标，不参与架构选型和 V1 准入；不为它增加另一桌面壳、System WebView fallback 或 Runtime 分叉；
- 安装结束后，V1 内置能力的可再分发依赖闭包已经完备，不在首次使用时补装；
- Rust Product Core 保持 Workspace、Workflow、Artifact、权限、计费上下文和恢复语义的唯一权威；
- Electron Main 不保存领域数据、不决定权限、不直接执行能力；
- WPS、FFmpeg、App Server、Capability、用户扩展和 Installer 分进程运行；
- 交互 Surface、被动 Preview 与后台 Render 使用不同生命周期和权限模型；
- 用户 Skill/MCP 继续通过 Public Capability Facade 调用与官方能力同语义的系统能力；
- 浏览器存储、Renderer 状态和缓存可以丢弃重建，不形成第二套产品真相。

### 2.2 非目标

- 不引入后台常驻 daemon；V1 关闭客户端时在安全 Checkpoint 停止，稍后恢复；
- 不把 Electron Main、Preload 或 Electron Node 作为业务后端或用户 Skill Runtime；
- 不把每个 Markdown 标签页拆成独立浏览器 Profile；
- 不用 Chromium 重排 DOCX/PPTX；Office 视觉事实仍来自 WPS/Office；
- 不允许用户 HTML、Markdown、图表或远程页面在应用 Shell 中执行活动代码；
- 不维护 Tauri/Electron 双壳，不提供旧系统兼容分支；
- 不为了“Rust-first”重写成熟 Web 编辑器或专业 Office 协议。

## 3. 信任模型

| 单元 | 技术信任级别 | 可以拥有 | 不可以拥有 |
|---|---|---|---|
| Electron Main / Shell Controller | 客户端 TCB，最小职责 | 窗口、菜单、通知、Deep Link、Surface 生命周期、窄 IPC | Workspace/Workflow/账本真相、任意能力执行、凭证明文 |
| Rust Product Core | 唯一业务、数据与策略权威 | 领域状态、权限决定、资源 Handle、Journal、Receipt、服务客户端 | 在主进程内直接运行不可信扩展或专业宿主 |
| App UI Renderer | 沙箱化 UI 客户端 | 已授权 Query 结果、UI 临时状态 | 自报身份/授权/计费、真实路径、任意 Node/Electron API |
| Diagram/Preview Renderer | 沙箱化不可信内容域 | 有限 Document/Artifact Handle、结构化事件 | App Shell DOM、Workspace 路径、任意网络、凭证 |
| Render Worker Host | 受控 Chromium 执行器 | 单个 Render Job 的输入 Handle 与帧输出 | UI Session、登录状态、Workspace 任意读取 |
| Built-in/Host/Extension Worker | 按类型隔离 | Execution Manifest 允许的最小资源 | 扩大权限、读取其他 Worker 状态、直接结算 Credits |

“Electron Main 不拥有业务权威”是架构约束，不是假称它没有 Node 或系统能力。Main 必须进入代码签名、安全审计、CVE 响应和攻击测试；Renderer 的安全边界才由 Chromium sandbox、context isolation 和窄 Preload 共同提供。

## 4. 总体进程拓扑

```text
SuperWagie Desktop Process Tree
│
├── Electron Main — Shell Controller
│   ├── App UI Renderer（每窗口一个）
│   ├── Diagram Editor Surface（按需）
│   └── Artifact Preview Surface（按需）
│
├── Rust Product Core
│   ├── UI Query Gateway
│   ├── Project / Workspace / Markdown / Task
│   ├── Agent Session Adapter
│   ├── Durable Workflow / Effect Journal
│   ├── Capability / Policy Router
│   ├── Artifact / Review / Continuity
│   ├── Runtime / Extension Registry
│   └── Platform / Connector Service Clients
│
├── Fixed Codex App Server Worker
├── Built-in Capability Worker(s)
├── User Extension / MCP Worker(s)
├── Installer Worker（仅显式安装事务）
├── WPS / Office Host Worker
├── FFmpeg / Media Worker
├── AgentWiki Connector Worker
└── Electron Render Worker Host
    └── render_worker Job Surface（video / diagram / browser review）
```

所有 Worker 都由 Rust Product Core 通过固定绝对路径、清空后的环境、Execution Manifest 和一次性启动凭证监管。Worker 不直接互相调用；跨域协作通过 Core 的 Artifact、Effect 和 Capability Contract 完成。

## 5. 启动、退出与故障所有权

### 5.1 标准启动

V1 不增加自定义 Native Launcher：

1. 操作系统启动签名的 Electron 应用；
2. Electron Main 验证当前签名 Runtime Image 和 Runtime Manifest；
3. Main 以固定绝对路径启动 Rust Product Core，创建私有 pipe/socket 并完成相互身份握手；
4. Rust Core 打开或迁移自己的数据存储，完成安装完整性检查；
5. 握手通过后 Main 才创建 App UI Renderer；
6. Rust Core 按需启动 App Server 和其他 Worker。

Main 不从 PATH 查找 Rust、App Server、FFmpeg、Python、Node、WPS 或扩展 Worker。外部宿主只能由 Runtime Resolver 返回经过验证的绝对身份。

### 5.2 退出语义

- 用户正常退出：停止接收新副作用，完成原子步骤，写 Checkpoint，结算可信 Receipt，关闭 Worker；
- UI Renderer 崩溃：Main 重建 UI，UI 从 Query Snapshot + Event Cursor 恢复；Core 与进行中的安全任务不丢失；
- Electron Main 崩溃：当前桌面实例结束，Rust Core 通过 parent-death/heartbeat 进入安全停机；下次启动从 Journal 恢复；
- Rust Core 崩溃：UI 进入 `disconnected`，Main 最多执行一次受控重启；恢复失败时保持只读 UI 和明确修复入口；
- 单个 Worker 崩溃：只影响其 Job/Capability，按 Effect Journal 进入 retry、reconcile 或 recoverable_failed；
- V1 不承诺关闭客户端后继续在后台执行。若未来引入后台执行，必须作为独立产品范围设计服务安装、升级、退出和权限模型。

## 6. 浏览器 Surface 模型

Surface 按风险和生命周期划分，而不是给每种功能都建立独立持久 Profile。

| Surface | 承载内容 | 运行位置 | Session/存储 | 权限 |
|---|---|---|---|---|
| `app_ui` | Workbench、Tasks、Workspace Shell、Agent Panel、CodeMirror Markdown | App UI Renderer | 应用级受控 Session；业务状态不进 Web Storage | 类型化 Query/Command、有限剪贴板/拖放意图 |
| `diagram_editor` | Excalidraw、draw.io | 独立 WebContentsView | 内存 Session；关闭即清理 | Document Handle、结构化编辑/保存/导出 |
| `artifact_preview` | HTML、PDF.js、Office authoritative pages、图片/媒体预览 | 独立 WebContentsView | revision-scoped 内存 Session | 只读 Resource Handle、批注/导航事件 |
| `render_worker` | 视频帧、Diagram headless render、HTML browser review | 独立 Electron Render Worker Host | Job 级 ephemeral Session | 只读输入 Handle、帧/截图/报告输出 |

系统浏览器登录、支付、AgentWiki OAuth 和企业 SSO 是 `external_route`，不是 Chromium Surface。授权码通过 Deep Link 返回 Rust Core，Renderer 不持有 Refresh Token 或登录 Cookie。

### 6.1 Markdown 特例

CodeMirror 是产品核心、签名、固定版本的编辑组件，放在 `app_ui` 中，以减少三栏布局、Tab、IME、焦点、剪贴板和无障碍跨 WebContents 协调。安全要求：

- Markdown 原文是唯一真相；
- 原始 HTML 和未知插件语法无损保存但不得直接执行；
- Live Preview 只生成经过白名单和 Trusted Types 约束的 DOM；
- 完整 Reading View 可以使用同 Renderer 的安全渲染树；需要执行用户 HTML 的预览必须进入 `artifact_preview`；
- 图片、附件和 Embed 只通过 Resource Handle 加载，不使用 `file://` 或真实路径。

### 6.2 Surface 生命周期

- WebContentsView 必须登记在 Surface Registry，并在 Tab/Window 关闭时显式销毁；
- 不使用 `<webview>`；第三方编辑器与高风险预览优先使用 WebContentsView；
- 每个 Session 单独注册所需自定义协议、CSP、权限拒绝、导航和窗口策略；
- 浏览器 localStorage、IndexedDB、Cache Storage、service worker 和 history 不保存领域数据；
- 跨 Project 隔离依靠 Rust Project Context、Handle audience 和独立 Surface identity，不建立无限增长的永久 Project Profile；
- Render Worker 不与 UI、Editor 或 Preview 共享 Cookie、Cache、service worker、GPU 任务状态和网络权限。

## 7. Shell 与 Rust Core 的职责边界

### 7.1 Electron Main — Shell Controller

允许：

- 应用生命周期、窗口、菜单、托盘、通知、Deep Link 和系统主题；
- 创建、定位、关闭并回收 WebContents/Surface；
- 校验 Renderer sender/frame/origin 后转发有限 Intent；
- 承载签名 `superwagie-app://` 与 `superwagie-resource://` 协议；
- 调用 OS 文件/目录选择器，将结果立即交给 Rust Core 建立授权 Grant；
- 允许签名 Preload 以 `webUtils.getPathForFile` 把用户原生拖入的 `File` 转成受限 drag intent；Main 只校验 sender 并立即交给 Rust Core 建立/拒绝 Grant，不读取文件内容；
- 显示更新状态和受控重启入口；
- 收集不含用户内容的 Renderer 崩溃与资源指标。

禁止：

- 直接读写 Workspace 内容或业务 SQLite；
- 在 Main 中执行 WPS、FFmpeg、用户扩展、App Server 或任意 Workflow；
- 持有 Provider Key、支付信息、Refresh Token、WPS 凭证或扩展 Secret；
- 向 Renderer 暴露通用 `fs`、`child_process`、`shell`、`http`、`net`、`ipcRenderer` 或任意方法调用；
- 根据 Renderer 自报的 user、grant、wallet 或 extension identity 直接执行命令。

### 7.2 Rust Product Core

Rust Core 负责：

- Project、Workspace Grant、文件身份、事务、CAS、冲突和恢复；
- Task、Markdown Index、Workbench Projection 和 UI Query；
- Agent Task Thread、App Server Adapter、上下文构造和 Session Credits 投影；
- Durable Workflow、Effect Journal、Checkpoint、Lease、Human Gate 与幂等；
- Artifact、Preview Revision、Review Annotation、Continuity 与 Safe Memory；
- Capability Registry、权限、风险、计费和 Worker 路由；
- Secret Vault handle、Platform Service Client、Connector 和 Extension Network Broker；
- Runtime Image、扩展环境、安装完整性、版本兼容与回滚决定。

Rust Core 不在自身进程内动态加载用户扩展、Office SDK、FFmpeg 插件或未审计 native addon。

## 8. 命令、查询与资源协议

### 8.1 两段式可信命令

Renderer、Agent 和扩展提交的是调用意图，不能自报可信上下文：

```text
ClientIntent
├── protocol_version
├── request_id
├── command_type
├── resource_refs
├── requested_permissions
├── expected_revision?
├── payload
├── issued_at
└── deadline_at?

Trusted Gateway 根据已认证通道注入：
├── actor_context
├── caller_identity / surface_identity
├── project / workspace context
├── effective grants
├── billing binding / reservation
└── gate_context（Workflow / Risk / Install 分类回执）与 audit context

→ AuthorizedCommand
→ Domain Handler / Capability Router
```

调用者可以请求权限或在具体 payload 中提出成本上限，但不能提交“已经拥有的 grant”，也不能选择 wallet、Reservation 或签发 Billing Context。Gateway 必须从进程身份、Surface Registry、Extension Registry、Project Binding 和服务端投影重新派生可信字段。

### 8.2 UI Query 与订阅

UI 使用独立于 Public Capability Facade 的 Product UI API：

- `query.execute(query_id, params)` 返回 `snapshot_revision + payload`；
- `subscription.open(query_id, params, after_cursor?)` 返回初始 Snapshot 和 Event Cursor；
- 同一 subscription 内事件有序；发现 cursor gap 或 projection version 变化时返回 `resync_required`；
- UI 只能重新读取 Snapshot，不能猜测缺失事件；
- Renderer 重启、窗口恢复和 Core 重连都使用同一协议；
- UI Query API 不向用户 Skill/MCP 公开内部 Projection、Private Workflow 或其他 Project。

### 8.3 Resource Handle

Renderer 和 Worker 不取得真实路径，统一使用不可伪造的 Resource Handle：

```text
ResourceHandle
├── handle_id
├── resource_type / resource_id / revision
├── audience（surface/worker/capability identity）
├── allowed_operations（read/range_read/write_staging/render）
├── media_type / size_limit / range_limit
├── project / owner scope
├── issued_at / expires_at
├── one_shot?
└── auth_tag（Rust Core 签发的 MAC 或数字签名）
```

- Handle 由 Rust Core 签发并只对指定 audience 有效；
- `auth_tag` 必须是由 Rust Core 专用密钥保护的 MAC 或数字签名，不得用可由调用方重算的纯内容哈希代替；
- `superwagie-resource://<handle>` 由每个 Session 的协议处理器转成受限流；
- 支持 Range、取消、backpressure 和最大字节数；
- Handle 失效、Surface 重启、Project 切换或 revision 改变后不得继续读取；
- `ArtifactRef` 是业务引用，`ResourceHandle` 是短期传输授权，两者不能混用。

## 9. Durable Workflow 与隔离执行

业务阶段和外部副作用分层：

```text
Workflow Run（用户业务阶段）
→ Effect Intent（类型化副作用）
→ Policy / Permission / Billing / Human Gate
→ prepare + journal
→ Worker execute
→ receipt / execution_unknown
→ validate + artifact promote
→ settle / compensate
→ Workflow transition
```

所有 WPS、Managed AI、Official Publisher、Connector、FFmpeg、Render、用户扩展和安装动作复用 Effect Journal 的 request ID、deadline、receipt、reconcile 与 compensation 原语，但保留各自类型化 Payload 和状态约束。Task Item、Agent Thread、Workflow Run、Job 和 Effect 不共用状态枚举或业务 ID。

Worker 执行规则：

- 直接参数数组启动，不经过 shell 拼接；
- 只挂载声明的逻辑目录或 Handle；
- 环境白名单、资源上限、子进程与网络策略由 Execution Manifest 固定；
- Worker 输出先进入 staging/quarantine，经验证后才能提升为 Artifact；
- `execution_unknown` 必须 reconcile，不能直接重放；
- Worker 崩溃不清理 Durable Workflow、Journal、Receipt 或已验证 Artifact。

## 10. 本地数据与远端真相

| 数据平面 | 权威内容 | 生命周期 |
|---|---|---|
| Workspace | Markdown、任务语义、Diagram 原文件、Office/HTML/媒体 Artifact | 用户所有；卸载不删 |
| Operational Store | Workflow event、Checkpoint、Lease、Journal、Receipt、Task/Run link、同步 base | 不可随索引清理；Schema 迁移与备份 |
| Derived Index Store | 文档、链接、任务、全文检索、Workbench/Task projection | 可删除重建 |
| Personal Data Store | Profile、Safe Memory、同意与引用审计 | 按 user namespace；使用 OS 绑定密钥加密 |
| Secret Vault | Refresh Token、Connector Token、Secret handle | OS Keychain/Credential Manager；Renderer 不可见 |
| Signed Runtime Image | Electron、Rust、App Server、内置静态资源和 Runtime | 每发布版本不可变；A/B 回滚可暂时并存 |
| Extension Store | 用户 Skill/MCP 环境、Manifest、SBOM、quarantine | 显式安装/更新；不修改 Runtime Image |
| Cache Store | Preview、缩略图、Renderer cache、临时帧 | 可清理，不改变验收事实 |
| 官方服务端 | Identity、Wallet/Ledger、Reservation/Settlement、Official Host Deployment | 远端唯一真相；客户端只持投影 |
| AgentWiki | Space、远端 revision、个人私有区、团队共享记忆副本 | Connector 独立远端真相 |

Operational、Derived Index 和 Personal Data 至少逻辑分库，禁止“重建索引”误删 Workflow/Receipt/Memory。所有本地受管数据按 `user_id + device_id` 命名空间隔离；退出登录不删除 Workspace，切换账户不能读取另一个用户的 Profile、Memory、Token 或远端投影。

## 11. 网络与远端服务平面

网络策略分为三条，不使用一个模糊的通用 Broker 混合身份：

1. **Platform Service Client**：Identity、Managed AI、Credits、Official Publisher；使用短期客户端令牌、证书校验、幂等键和服务端 Receipt。
2. **Connector Client**：AgentWiki 的独立授权、Space、sync journal 与审计语义。
3. **Extension Network Broker**：用户 Skill/MCP 的显式域名、方法、DNS/IP、redirect、localhost、body 和速率策略，默认断网。

三条路径可以共享 TLS、代理适配和网络遥测库，但不能共享凭证、授权决策、幂等命名空间或审计身份。Renderer 不直接访问官方 API；系统浏览器只负责授权交互，Deep Link 结果交给 Rust Core。

离线时 Workspace、Markdown、任务、绘图和已安装的本地能力继续可用；需要 Managed AI、Credits Reservation、Official Host 或 Connector 的操作进入明确 disconnected/blocked 状态，不以本地缓存猜测远端成功。

## 12. 安装完整性与依赖分层

“安装即完备”指：V1 内置能力在目标平台上的传递依赖闭包，要么已进入签名 Runtime Image，要么被明确分类为外部宿主并有能力级 fallback；不得在功能首次运行时再解析或下载。

### 12.1 四层依赖

| 层 | 内容 | 规则 |
|---|---|---|
| OS Baseline | 系统 API、证书、GPU 驱动、平台稳定 ABI | 直接共享；安装/首启 feature probe；不继承随机环境变量 |
| Signed Runtime Image | Electron/Chromium、Rust Core、App Server、静态编辑器、PDF.js、FFmpeg/codec、字体，以及确有必要的 Python/Node | 每版本固定、签名、SBOM；内置能力共享一次 |
| External Host | WPS/Office、系统浏览器、不可再分发宿主 | 标准位置/用户选择 + 签名身份 + 版本/feature probe；缺失只禁用相关能力 |
| User Extension Environment | Skill/MCP 依赖和 native artifact | 仅在显式安装/更新事务中构建；staging、SBOM、quarantine、原子提升 |

### 12.2 包体控制

- 发布流水线根据 V1 Capability Dependency Graph 计算真正需要的 Runtime，不预装“可能以后会用”的语言环境；
- 内置能力完成 Rust 迁移后，通过引用追踪移除不再需要的 Python/Node；
- 同一发布版本内 Runtime 只共享一份；为了安全回滚，前后两个不可变 Runtime Image 可以暂时并存，不做原地覆盖；
- Electron 自带 Node 不作为 Capability、Skill 或 MCP Runtime；
- 不读取用户全局 `site-packages`、`node_modules`、npmrc、pip.conf、shell profile、PATH 命中或其他 Agent 配置；
- 不以首次使用下载 Chromium、Editor、PDF.js、FFmpeg、字体或内置 Workflow Runtime 来规避包体门槛。

## 13. 视频和后台浏览器渲染

视频继续使用 SuperWagie 自有 Scene IR、Timeline IR 与 `frame/fps` 确定性求值。重型渲染不放在 UI Electron Main 的 renderer pool，而由独立 Electron Render Worker Host 承载：

1. Rust Core 创建 Render Job，锁定 Scene/Timeline/Asset/Font/Chromium identity；
2. 启动或复用固定版本的签名 Render Worker Host；
3. Worker 创建 Job 级 ephemeral offscreen Surface；
4. Surface 只加载签名 composition bundle 和 Resource Handle；
5. Rust 按绝对 frame index 驱动，不使用墙钟、CSS 自播放或 UI Session；
6. Render Worker 将帧流交给 FFmpeg Worker，Rust 记录 hash、checkpoint 和 backpressure；
7. 崩溃只恢复当前 Job，不影响 UI、Workspace 或已验收 Artifact。

Gate 4 必须比较 GPU texture、bitmap/software output、色彩、透明度、字体、Canvas/SVG、帧吞吐、内存和双平台像素容差。若 Electron offscreen 达不到要求，重新裁决 Render Worker 技术，不把系统 Chrome 或首次下载 Headless Shell作为静默 fallback。

## 14. 功能闭环与技术承载

| 用户闭环 | 主要承载 |
|---|---|
| 工作台、项目、Tasks | Rust Query Projection + `app_ui` |
| Obsidian 式 Markdown | Workspace/Markdown Core + CodeMirror in `app_ui` + 安全资源协议 |
| Agent 对话与恢复 | Agent Session Adapter + App Server Worker + Durable Workflow |
| PPT/Word | Private Workflow + Capability Worker + WPS Host Worker + Artifact/Review |
| HTML | Private Workflow + 隔离构建 Worker + `artifact_preview` + Official Publisher |
| 视频 | Video Workflow + Render Worker Host + FFmpeg Worker + 媒体 QA |
| Excalidraw/draw.io | `diagram_editor` + Diagram Adapter + Workspace Transaction |
| Office Review | WPS authoritative render + `artifact_preview` + Review Overlay |
| 用户 Skill/MCP | Extension Worker + Public Capability Facade + 可信上下文注入 |
| Continuity/Memory | Continuity + Personal Data Store + Workspace Markdown |
| AgentWiki | Connector Worker + Sync Journal + Workspace Transaction |
| Credits | Platform Service Client + 服务端 Ledger + 本地只读 Projection |

此映射保证所有已确认功能都有唯一的执行面和数据真相，不为 PPT、Word、HTML、视频或扩展建立第二套应用壳。

## 15. 安全配置

所有 Renderer：

- `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`；
- 严格 CSP、Trusted Types、navigation/window/permission/download deny-by-default；
- 不使用 `file://`；本地资源使用受限自定义协议；
- IPC 校验 sender、frame、origin、surface、schema、request nonce；
- 不加载运行时远程脚本，不执行用户 Markdown/HTML/Diagram 活动代码；
- Developer Tools 只在显式 Developer Mode 开放。

生产包：

- 禁用 `RunAsNode`、Node CLI inspect 和 `NODE_OPTIONS` 注入；
- 启用 Embedded ASAR Integrity 和 OnlyLoadAppFromAsar；
- app bundle、Rust Core、App Server、Worker、FFmpeg、静态资源和 Runtime Manifest 全部进入签名、SBOM 与 NOTICE；
- App UI 不持有登录 Cookie；Refresh Token 只在 Secret Vault；
- Electron/Chromium 安全更新进入客户端安全发布 SLA，不能无限期冻结旧版本。

## 16. Human Gate 与运行状态边界

统一决策收据分三类机制：

1. **Workflow Gate**：大纲、样张、风格、发布方案等业务阶段决定；
2. **Risk Gate**：`scope_expansion`、`external_effect`、`destructive`、`high_cost_billing`；
3. **Install Gate**：扩展来源、脚本、网络、native 依赖和权限变化。

三者共用 HumanGateCard 视觉组件，但 Schema、过期规则、审计和恢复语义不同。普通可逆本地编辑不重复确认。

Agent Task Thread 使用完整 lifecycle：

```text
ready → running
running → awaiting_user | user_stopped | credits_blocked |
          disconnected | recoverable_failed | completed
completed | user_stopped → running
ready | completed | user_stopped → archived
```

“完成、等待回答、用户停止、Credits 不足、连接中断、可恢复失败”是六类用户注意/结果状态，不再称为完整六态状态机。

## 17. 更新、回滚与版本兼容

- Electron、Chromium、Node、前端资源和 Surface Manifest 是一个兼容单元；
- Rust Core、App Server、Capability Package、Contract 分别有版本，但发布清单固定兼容矩阵；
- 更新写入新的不可变 Runtime Image，验证通过后切换当前指针；失败回滚上一签名 Image；
- 更新前备份 Operational/Personal Store Schema，派生 Cache 可清理，Workspace 不迁移到应用目录；
- 旧 Workflow/Artifact 必须按记录的 Capability/Renderer identity 重开或明确进入 compatibility state；
- 不维护 Tauri/Electron 双壳，回滚只回到上一签名 Electron 版本。

## 18. 验证 Gate 变更

### G0-SHELL-002

- Electron 双平台签名开发构建、安装、启动、退出与恢复；
- Main → Rust Core 标准启动、握手、身份轮换和 parent-death 行为；
- App UI/Diagram/Preview Surface 的 sandbox、origin、Session、权限和显式销毁；
- CodeMirror 中文 IME、剪贴板、原生拖放、缩放、Tabs、焦点与无障碍；
- Renderer 不能伪造 actor/grant/wallet/extension identity；
- UI Query Snapshot/Event Cursor 重连与 gap resync；
- Resource Handle 的 audience、TTL、Range、大小限制、撤销和 Project 隔离；
- Electron Main 代码审计、fuses、ASAR、CSP、navigation/permission 和资源协议攻击测试；
- Rust Core/Main/Renderer/Worker 分别崩溃后的故障域与恢复。

### Gate 2

- Agent Task Thread 九态生命周期、归档恢复与 Session Credits 持久化；
- Workflow/Risk/Install 三类 Gate 的候选、动作/范围、manifest/permissions、revision 与有效期绑定；
- Effect Journal 只由 Rust Product Core 持有，Host Worker 使用 audience-bound 一次性身份执行；
- execution_unknown、reconcile、compensation 与幂等计量不因 Worker 拆分改变。

### Gate 3 Review

- `artifact_preview` WebContentsView 替代旧 Tauri ReviewShell Surface，WPS/Office 仍提供视觉事实；
- Artifact、Preview Revision、批注与缓存提交权威留在 Rust Product Core；
- Preview Renderer 崩溃只重建 revision-scoped Session，不能重放 WPS 副作用或丢失批注；
- 旧 Tauri reviewer 证据只作渲染研究，不得签署方案 B Review 边界。

### Gate 4

- 独立 Electron Render Worker Host，不与 UI Main 共用业务 Session/Profile；
- 帧流 backpressure、内存、UI 响应性和 Worker 崩溃恢复；
- 逐帧确定性、像素 hash、透明度、色彩、字体、Canvas/SVG 与双平台 golden render；
- Render Worker 与 FFmpeg Worker 的 request/receipt/checkpoint。

### Gate 5

- ClientIntent 不能自报可信上下文；官方 Agent 与用户 Skill 的 AuthorizedCommand 由各自可信网关注入；
- Extension Worker、Installer Worker、Host Worker 进程/权限/环境零共享；
- Public Capability Facade 的完整机器目录等价性不因 Electron Surface 改变；
- Human Gate 决定只经认证 `app_ui` 产品命令提交，Gate Receipt、audit context 和 ResourceHandle audience 均不可伪造或转用。

### Gate 6

- 四层依赖在离线干净机上的闭包、探测、损坏修复和能力级 fallback；
- Signed Runtime Image A/B 更新、回滚、卸载保留 Workspace；
- Electron/Chromium/Node/Rust/App Server/Worker/FFmpeg 的 SBOM、NOTICE、签名和 CVE 响应；
- 包体积、冷启动、空闲/编辑/Review/视频内存、GPU 与子进程数量阈值；
- Platform Service Client 的登录、Credits、Publisher 与断网恢复。

在这些 Gate 通过前，Production Implementation Admission 保持 `NO_GO`。

## 19. 规格联动与验收条件

本决策必须同步到产品基线、编码准入契约、UI/Runtime/Security/Video/Rust/Quality 规则包、Contract v1、技术要求矩阵、技术验证计划和相关技术调查。

本设计升级为可进入生产实现的最低条件：

1. Electron 双平台签名 Spike 通过；
2. Rust Product Core 是唯一业务、数据与策略权威；
3. Electron Main 被纳入 TCB 审计但不拥有业务真相；
4. 高风险/长任务 Worker 的故障和权限域独立；
5. Query/Subscription/Resource Handle/可信命令契约通过测试；
6. Markdown、Diagram、Review 和视频体验达到已确认原型与真实客户端门槛；
7. 安装、升级、回滚、SBOM、许可证和 CVE 响应通过；
8. 包体积、启动、内存、GPU、帧吞吐和任务耗时被记录并接受；
9. macOS 与 Windows 运行同一 fixture；
10. Owner 对 Gate 决定完成签署。
