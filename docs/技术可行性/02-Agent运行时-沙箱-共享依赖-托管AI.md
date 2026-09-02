# 技术可行性 02：Agent 运行时、沙箱、共享依赖与托管 AI

> 状态：已确认方案 B“分层模块化核心”；既有协议/依赖 fixture 是旧边界证据，Main/Core/Worker 与可信上下文 fixture 待补跑  
> 日期：2026-09-01  
> 范围：`AR-01`～`AR-06`、`SEC-01`～`SEC-10`、`DEP-01`～`DEP-06`、`AI-01`～`AI-05`  
> 结论等级：除明确保留为 `RESEARCH_REQUIRED` 的项目外，本报告中的“可行”均为 `FEASIBLE_CONDITIONAL`。

## 1. 本轮结论

这一组要求总体可行，但“封闭 Agent 环境”必须被准确实现为：

> **Agent 核心、协议、状态、配置、权限与凭证完全隔离；依赖固定进入 OS Baseline、Signed Runtime Image、External Host、User Extension Environment 四层；不共享机器上其他 Agent 或用户全局语言环境。**

推荐架构：

```text
SuperWagie Desktop
├── Electron Main / Shell Controller（TCB，非业务权威）
├── sandboxed Chromium Surfaces
└── Rust Product Core（唯一业务、数据与策略权威）
    ├── Trusted Gateway：ClientIntent → AuthorizedCommand
    ├── UI Query / Workspace / Task / Workflow / Artifact / Policy / Billing
    ├── Platform Service Client / Connector Client / Extension Network Broker
    ├── Worker Supervisor
    │   ├── 固定 Codex App Server Worker + 独立 CODEX_HOME
    │   ├── Built-in Capability / Extension / Installer Workers
    │   ├── WPS / FFmpeg / Connector Workers
    │   └── Electron Render Worker Host
    └── Dependency Resolver
        ├── OS Baseline
        ├── Signed Runtime Image（只读、随安装完备）
        ├── External Host（绝对身份 + feature probe）
        └── User Extension Environment（显式安装事务）
```

### 1.1 关键架构调整

| 决策 | 第一轮结论 | 原因 |
|---|---|---|
| Codex Runtime | 固定版本 App Server 作为签名 sidecar 随包分发，由 Rust Runtime Supervisor 启动和监管 | 不能寻找、连接或升级机器上已有的 Codex；sidecar 生命周期不依赖桌面壳框架 |
| 客户端协议 | Rust Adapter 只暴露 SuperWagie 所需方法 | App Server 原始协议包含不受沙箱约束的 `thread/shellCommand`，不能直接交给 Chromium renderer、Skill 或用户脚本 |
| Runtime 状态 | App Server 负责对话运行状态，Rust Workflow 才是业务真相 | Agent 进程崩溃或协议升级不能破坏交付物状态、计费和人工确认门 |
| 配置隔离 | 独立状态根 + 清空环境 + 绝对可执行路径 + 启动参数覆盖 | 只设置 `CODEX_HOME` 仍不足以抵御继承环境、项目配置、`AGENTS.md`、PATH 和插件发现 |
| OS 沙箱 | App Server 原生 sandbox 作为第一道墙，Rust Product Core Broker 作为外层授权 | 单靠 Prompt 或工具说明不是安全边界；Core 不加载用户扩展，副作用 Worker 分进程 |
| 用户 Skill 的系统能力 | 与官方能力调用同一套已发布 Capability Facade，不因运行在 Extension Worker 而降级 | 隔离的是实现、状态和凭证；不是产品功能。区别只在授权范围和是否属于公开能力 |
| 内置 Runtime | Electron/Chromium、App Server、内置能力可达闭包、FFmpeg/codec、必要字体和签名静态资源进入 Signed Runtime Image | 安装后依赖即完备，不能首次使用时动态安装；由 Runtime Manifest 固定身份且任务不可修改 |
| 外部宿主 | WPS/Office、Git 和不可再分发系统库可经探测复用，不共享其 Agent 参数或配置 | 通过绝对路径与 feature probe，缺失时只降级依赖该宿主的能力 |
| Python 依赖 | 固定版 `uv` + Signed Runtime Image 中的固定 Python（确有内置能力需要时）+ 锁定内置环境/独立扩展环境 | 内置环境随安装预填且只读；扩展环境只在显式安装事务中建立，不在首次任务执行时建立 |
| Node 依赖 | 固定版 pnpm + Signed Runtime Image 中的固定 Node（确有内置能力需要时）+ 锁定内置 `node_modules`/独立扩展环境 | Electron Node 不作为 Skill Runtime；内置依赖图由 lockfile 固定，扩展不得修改镜像 |
| 托管 AI | 分成 Agent Reasoning 通道和 Capability AI Facade | Codex 自定义 Provider 当前只支持 Responses wire API，不能替代图片生成、OCR 等全部类型化能力 |

## 2. Codex App Server 的可用性与边界

OpenAI 官方将 Codex App Server 定义为把 Codex 深度嵌入产品的接口，覆盖鉴权、对话历史、审批和流式 Agent 事件；实现位于开源 `openai/codex/codex-rs/app-server`。Codex 仓库采用 Apache-2.0 许可证，满足闭源客户端再分发的基本许可条件，但发布时仍需保留许可证、NOTICE 与 SBOM。

官方协议事实：

- 默认传输是 stdio 上的 newline-delimited JSON；WebSocket 仍标为 experimental/unsupported；
- 客户端先 `initialize`，然后以 thread、turn、item 为核心管理运行过程；
- CLI 可以为**当前固定版本**生成 TypeScript 类型和 JSON Schema，因此 SuperWagie 可以在构建时固定协议快照；
- 支持 thread start/resume/read/list/archive、turn start/steer/interrupt 和持续事件流；
- `thread/shellCommand` 明确在沙箱外以 full access 运行，并且不继承 thread sandbox policy。

参考：

- [OpenAI Docs: Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex App Server source](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [Codex Apache-2.0 license](https://github.com/openai/codex/blob/main/LICENSE)
- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)

本机只作为协议现状证据，不作为最终选版：

```text
可执行文件：/Users/neomei/.npm-global/bin/codex
版本：codex-cli 0.147.0
app-server 默认监听：stdio://
可生成：TypeScript bindings / JSON Schema
analytics：app-server 默认关闭
```

最终产品不得调用这个系统安装。构建系统要从锁定的 Codex commit/release 生成各目标平台 sidecar，并记录二进制哈希、源码 commit、许可证、协议 Schema 哈希和 SuperWagie Adapter 版本。

### 2.1 不能直接暴露原始 App Server

推荐协议层：

```text
Renderer / Official Agent / User Skill-MCP / Connector
                   │ ClientIntent（不含可信上下文）
                   ▼
        Rust Trusted Gateway
        ├── 从认证 channel 注入 actor/caller/project/grants/billing/risk
        └── 伪造可信字段在进入领域处理器前拒绝
                   │ AuthorizedCommand
                   ▼
        SuperWagie Agent Runtime Adapter（稳定）
        ├── conversation.start/resume
        ├── turn.start/steer/cancel
        ├── approval.respond
        └── event.subscribe
                   │
                   ▼
        Versioned Codex Adapter（内部）
        ├── method allowlist
        ├── params/result schema validation
        ├── notification normalization
        └── unknown/experimental method deny
                   │
                   ▼
        Bundled Codex App Server stdio
```

Rust Adapter 必须从根部拒绝：

- `thread/shellCommand`；
- experimental API；
- App Server 新版本新增但尚未审计的方法；
- 客户端伪造的 approval、thread ID、workspace root 或 sandbox policy；
- 任意透传配置覆盖。

这意味着 Codex App Server 是**内部执行引擎**，不是 SuperWagie 的公开扩展 API。Skill/MCP 只能看到 Public Capability Facade；产品 UI 使用独立 UI Query API；两者都不能提交可信身份、授权、Billing 或 Risk Context。

### 2.2 完整配置隔离

OpenAI 官方说明：

- `CODEX_HOME` 控制 config、auth、logs、sessions、skills 和 standalone package metadata；
- `CODEX_SQLITE_HOME` 控制 SQLite 状态；
- custom model provider 可以设置 `base_url`、鉴权、重试与流式超时；当前 wire API 只支持 `responses`；
- `shell_environment_policy.inherit` 可以设为 `none`；
- sandbox 可以使用 workspace-write 且关闭 command network；
- untrusted project 会跳过 project-scoped `.codex/` config、hooks 和 rules。

参考：

- [OpenAI Docs: environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)
- [OpenAI Docs: configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

但仍有一个重要风险：Codex 会发现 Workspace 中的 `AGENTS.md`。官方配置提供 `project_doc_max_bytes`，当前开源实现允许将它设为 `0` 以禁止载入项目指令；SuperWagie 必须在每个锁定版本上用自动化测试证明这一行为。若未来版本不再可靠，必须维护一个最小 fork，在 Agent Core 中显式关闭项目指令发现。

建议启动序列（伪代码，具体键值由锁定版本 Schema 生成）：

```rust
Command::new(absolute_bundled_app_server)
    .env_clear()
    .current_dir(authorized_workspace)
    .env("CODEX_HOME", superwagie_runtime_home)
    .env("CODEX_SQLITE_HOME", superwagie_runtime_state)
    .env("LANG", validated_locale)
    .args(["app-server", "--stdio", "--strict-config"])
    // 通过固定配置层：untrusted project、project_doc_max_bytes=0、
    // shell env inherit=none、workspace sandbox、command network off、
    // apps/hooks/remote plugin/memories/未审计工具关闭
    .spawn();
```

Rust 标准库明确指出 `env_clear()` 会阻止子进程继承父进程环境；同时，当 PATH 被清除时各平台的可执行文件解析行为不同，所以所有 sidecar、解释器和工具必须使用已验证的绝对路径。

参考：

- [Rust `std::process::Command`](https://doc.rust-lang.org/std/process/struct.Command.html)
- [Codex AGENTS.md discovery source](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs)

### 2.3 Runtime 版本与升级

每个客户端版本必须携带：

```text
runtime-bundle.json
├── codex_version
├── codex_source_commit
├── target_triple
├── executable_sha256
├── app_server_schema_sha256
├── adapter_protocol_version
├── required_gateway_protocol
├── license_files[]
└── rollback_compatible_versions[]
```

升级规则：

1. 不执行 `codex update`，不使用系统 npm、Homebrew 或 winget 更新 Agent Core；
2. Codex sidecar 只随签名的 SuperWagie 应用或签名 Runtime Bundle 升级；
3. 新版本先在隔离数据副本做 Schema、会话恢复、沙箱和 Eval 回归；
4. Runtime DB 迁移前保留可恢复快照；若格式无法向后兼容，旧客户端不得直接打开新状态；
5. Runtime 可回滚不等于 Workflow 可回滚，业务状态仍由 Rust Durable Workflow 管理。

## 3. 沙箱、权限和安全代理

OpenAI 官方说明 Codex sandbox 会覆盖 Agent 启动的 git、包管理器、测试命令等所有子进程，并使用平台原生机制：macOS 使用 Seatbelt；Windows 原生模式有 elevated 与 unelevated 两档。Windows elevated 使用专用低权限用户、文件 ACL、Firewall 和本地策略，是推荐模式；unelevated 使用受限 token 和 ACL，但网络隔离更弱。官方把 Windows 11 列为推荐基线，最新 Windows 10 仅为 best effort。

参考：

- [OpenAI Docs: Sandbox](https://learn.chatgpt.com/docs/sandboxing)
- [OpenAI Docs: Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)

因此首发安全口径建议为：

- macOS：使用 Seatbelt，最低系统版本另由 Electron/Chromium、draw.io 与原生桥 PoC 共同决定；
- Windows：**Windows 11 才能作为完整支持的安全基线**；Windows 10 如保留，只能标为兼容/尽力支持，不能声称与 Windows 11 安全能力等价；
- 企业 Windows 若策略禁止 elevated sandbox，客户端必须明确显示降级状态，管理员可禁止使用用户扩展与本地命令；
- App Server sandbox 是内层防线，不替代 SuperWagie 的外层 Capability Broker。

### 3.1 双层隔离模型

```text
第一层：SuperWagie Rust Authorization
├── capability manifest
├── workspace root / artifact ownership
├── typed file, process, network, credential operations
├── approval and audit
└── Rust Product Core / Host Worker 与 Extension Worker 进程分离

第二层：OS Enforcement
├── Codex native sandbox
├── Extension Worker sandbox profile
├── network proxy / broker
└── process and filesystem restrictions
```

默认规则：

- Extension Worker 没有原始网络、Keychain/Credential Manager、任意 shell 和任意文件系统；
- Agent command sandbox 默认断网，只能在授权 Workspace 和 SuperWagie staging 目录写入；
- WPS/Office 等桌面宿主副作用由隔离 Host Worker 执行；系统对话框由 Electron Main 受控代理，登录/支付走系统浏览器 `external_route`，发布由 Platform Service Client 调用官方服务；
- Host Worker 只接受 Rust Product Core 授权的 typed request 与一次性身份，不接受任意命令字符串；
- 所有 Host Request 都有 request ID、caller capability、workspace、预算、输入哈希、审批状态和 receipt。

### 3.2 Network Broker

Codex 当前已经提供实验性的 command network proxy 与域名 allow/deny 规则，但官方也明确其不约束 web search、apps、MCP 或其他 hosted tools。由于该能力仍是 experimental，SuperWagie 不能把它作为唯一稳定授权层。

建议：

1. App Server command network 默认关闭；
2. 用户 Capability 不直接启用 Codex apps、remote plugin、web search 或任意 MCP；
3. 所有联网能力通过 SuperWagie Network Broker 或服务端 Connector；
4. Broker 按 capability、operation、method、domain、redirect、DNS result、IP class、body size、timeout 和 task token 审批；
5. 禁止默认访问 localhost、link-local、私网 IP、Unix socket 和用户配置的上游代理；
6. Codex experimental network proxy 可以在 PoC 后作为附加防线，但不得替代 Broker 的审计和身份模型。

### 3.3 Credential Broker

平台 Provider Key 永远只存在于服务端。客户端和子进程最多获得一个短期任务令牌：

```text
task_token
├── user_id / org_id / billing_context
├── capability_id / capability_version
├── allowed_ai_operations[]
├── workspace_id / artifact_scope[]
├── max_credit_reservation
├── task_id / nonce / idempotency_key
├── issued_at / expires_at
└── audience = superwagie-gateway
```

即使 App Server 必须从环境读取鉴权，也只能注入这个短期、窄权限、可撤销的令牌。不能把模型中转站的主 API Key、用户长期 refresh token 或企业支付凭证放入 App Server、Skill、MCP、脚本、日志或 crash dump。

### 3.4 用户 Skill 调用系统能力

进程隔离不是功能隔离。用户 Skill 和用户安装的 MCP 可以通过 SuperWagie Extension SDK 调用所有**已发布的高层系统能力**，调用链如下：

```text
User Skill / User MCP
        │
        ▼
Extension SDK / MCP Gateway
        │  capability_id + operation + scoped inputs
        ▼
Capability Registry + Policy Engine
        │
        ├── Workspace Broker  → read/search/patch/export（授权范围内）
        ├── Process Broker    → Python/Node/Git/ffmpeg 等已探测 Runtime
        ├── Office Bridge     → WPS 生成、渲染、Review
        ├── Canvas Bridge     → Excalidraw / draw.io typed operations
        ├── Browser/Network   → 受域名、动作和预算约束的访问
        ├── Artifact/Workflow → 中间文件、检查点、Review/Undo
        └── Managed AI        → chat/reason/vision/OCR/image/embed
```

硬性规则：

1. 用户 Skill 与官方 Capability 调用同一个公开接口版本、参数语义和结果 Schema；不能提供一个功能残缺的“用户版 API”；
2. 已在安装时声明并由用户授予的普通权限，执行时直接调用，不反复确认；只有扩大 Working Set、对外发布/发送和永久删除等高风险动作触发行内授权；
3. 产品 Runtime 与外部宿主由 Runtime Catalog 解析为绝对路径，Process Broker 以声明过的 executable profile、参数 Schema、工作目录和资源限额执行；用户 Skill 不需要自己捆绑整套 Python、Node、Git、ffmpeg 或 WPS；
4. 用户 Skill 可以提供并运行自己的锁定依赖与脚本，但运行在能力私有环境中；可以共享 SuperWagie 的 uv/pnpm 内容缓存，不能读取用户全局语言包和配置；
5. 不公开的仅是平台内部实现：Provider Key、Codex App Server 原始协议、私有 Workflow/Prompt、账本、更新器、Credential Store 和任意 Host Worker 命令；
6. “可调用系统能力”不等于“获得宿主原始权限”。任何公开能力都必须是 typed request，返回 receipt/artifact；不得接受任意 shell 字符串、任意动态库路径或任意本机凭证句柄；
7. 内置能力若依赖某项公开系统能力，该能力原则上也必须向用户 Skill 提供相同契约。只有涉及平台运维、密钥、支付、签名和私有能力实现的接口可以保持内部专用。

因此，隔离架构不会妨碍用户 Skill 完成文件加工、调用系统工具、生成 Office 文件、使用绘图编辑器或调用托管 AI。它只把“直接碰宿主”改为“通过稳定、可审计的系统能力调用”。

### 3.5 用户 Skill 的脚本与进程执行

已确认采用“声明式脚本执行、禁止任意 shell”的边界。Skill 包可以包含 Python、Node 或已审核的原生程序入口，MCP 也可以声明本地 stdio server，但必须在安装后形成可校验的 execution manifest：

```text
ExecutionManifest
├── entrypoint：包内相对路径或 Runtime Catalog 中的 executable profile
├── runtime：python / node / native / mcp-stdio
├── runtime_version / feature requirements
├── argv_schema：允许的结构化参数，不接受拼接 shell 字符串
├── cwd_policy：能力 staging 或已授权 Workspace 子目录
├── filesystem_scope：read / write / create / delete 范围
├── network_policy：默认 deny，按公开 Broker operation 放行
├── resource_limits：timeout / memory / output / child process
├── dependency_lock / package hashes
└── requested_capabilities[]
```

Process Broker 使用绝对可执行路径和参数数组直接启动进程，不经过 `/bin/sh -c`、`cmd.exe /c`、PowerShell `-Command` 或用户 login shell。复杂命令应写成 Skill 包内的版本化脚本，由 Broker 直接交给经过探测的 Python/Node；不能在运行时把模型生成的字符串当 shell 程序执行。

脚本仍可通过 Extension SDK 请求 Workspace、AI、WPS、绘图、网络和 Artifact 等系统能力。需要子进程的工具必须在 manifest 中声明，子进程继承相同或更严格的沙箱，不能扩大父能力权限。stdout/stderr 只作为有大小限制的非可信数据返回，结构化结果优先通过约定 JSON 或 Artifact 文件交付。

开发内置能力时可以提供显式的 Developer Mode 诊断终端，但它属于开发工具，不进入普通用户 Skill 权限模型，不得随生产设置静默开启。

## 4. 产品级共享 Runtime 与能力依赖隔离

“共享”必须按四层责任划分，并把内容寻址缓存视为实现细节而不是第五种权威来源：

| 类型 | 是否共享 | 规则 |
|---|---:|---|
| OS Baseline | 条件共享 | 只使用目标 OS 保证的系统 API、证书库、GPU 驱动与稳定 ABI；不继承 `DYLD_LIBRARY_PATH`/`LD_LIBRARY_PATH`/PATH 注入 |
| Signed Runtime Image | 内置能力共享 | Electron/Chromium、App Server、V1 能力图实际需要的 Python/Node、FFmpeg/codec、字体和签名资源只安装一次；只读、版本锁定、可校验，不按 Skill 重复 |
| External Host | 条件共享 | WPS/Office、Git 等经绝对路径、签名/身份、版本和 feature probe 使用；缺失时只禁用依赖能力 |
| User Extension Environment | 扩展内隔离 | 用户明确安装/更新 Skill/MCP 时由 Installer Worker 建立；不导入用户全局包，不修改 Signed Runtime Image，不拖到首次执行 |

缓存、uv/pnpm store 与预编译制品可以在产品管理目录内按内容寻址去重，但缓存可丢弃，不能成为 Capability 版本、授权或安装完整性的真相。

### 4.1 Runtime Catalog

Runtime 解析分两条固定路径：

```text
Signed Runtime Image
└── Runtime Manifest 中的应用内绝对身份 + 签名/hash/ABI/feature probe

外部宿主
├── 用户在 SuperWagie 中明确选择的绝对路径
└── 操作系统标准安装位置（固定候选表，不接受任意 PATH 命中）
        │
        ▼
静态检查：文件类型、签名/所有者、是否位于可疑可写目录
        │
        ▼
版本探测：--version / architecture / runtime ABI
        │
        ▼
能力 feature probe：真实 import、codec、Office API 或格式支持
        │
        ▼
RuntimeDescriptor（绝对路径 + 身份哈希 + capabilities）
```

不能只判断“命令存在”。例如随包 FFmpeg 是否包含所需 codec、产品 Python/Node 是否满足 ABI、WPS 是否提供所需 JSAPI/COM，都必须由对应能力做 feature probe。Signed Runtime Image 探测失败表示安装损坏或升级不完整，必须修复/回滚；External Host 探测失败才进入能力级降级。

### 4.2 Python 路径

uv 官方文档提供了这条路径所需的关键能力：

- `uv.lock` 是跨 OS、架构和 Python 版本的精确锁文件；
- `--no-managed-python` 禁止 uv 自行管理/下载 Python；SuperWagie 另以 `--python` 指定产品 Runtime 的绝对路径；
- `--no-python-downloads` 禁止静默下载 Python；
- `--no-config` 避免读取当前目录、父目录和用户 uv 配置；
- `--locked` 在 lockfile 不一致时失败，不自动改锁；
- cache 是 thread-safe、append-only，并对目标 venv 使用文件锁；
- 可导出 CycloneDX SBOM。

参考：

- [uv project layout and lockfile](https://docs.astral.sh/uv/concepts/projects/layout/)
- [uv cache safety](https://docs.astral.sh/uv/concepts/cache/)
- [uv locking and syncing](https://docs.astral.sh/uv/concepts/projects/sync/)
- [uv CLI reference](https://docs.astral.sh/uv/reference/cli/)
- [uv source and license](https://github.com/astral-sh/uv)

如果任一 V1 内置能力仍需要 Python，SuperWagie 在 Signed Runtime Image 中携带一份固定、签名的 uv 与 Python Runtime，并只收录可达的内置环境。内置能力环境由发布流水线构建并随安装介质预填；运行时只允许离线校验/修复，不在线解析或下载。用户扩展在明确触发的安装事务中使用 Installer Worker 建立独立环境，不写入镜像：

```text
uv --no-config --no-managed-python --no-python-downloads --offline
   --cache-dir <SuperWagie cache>
   sync --locked --python <absolute product python>
```

实际参数必须针对锁定 uv 版本生成并回归。能力环境键：

```text
sha256(capability_id + capability_version + uv.lock_hash
       + platform + architecture + python_runtime_identity)
```

### 4.3 Node 路径

pnpm 官方说明其 `node_modules` 中文件链接到内容寻址 store；`pnpm install --frozen-lockfile` 不修改 lockfile，manifest 与 lock 不一致时失败；`--offline` 可以强制只使用 store。pnpm 采用 MIT 许可。

参考：

- [pnpm symlinked node_modules and content-addressable store](https://pnpm.io/symlinked-node-modules-structure)
- [pnpm install](https://pnpm.io/cli/install)
- [pnpm fetch and offline install](https://pnpm.io/cli/fetch)
- [pnpm source and license](https://github.com/pnpm/pnpm)

如果任一 V1 内置能力仍需要 Node，则在 Signed Runtime Image 中携带一份固定 Node 与 pnpm；Electron 自带 Node 不作为 Skill Runtime。内置 `node_modules` 由发布流水线生成并随安装介质预填；用户扩展只在显式安装事务中建立私有 `node_modules`。不依赖用户全局 Node/pnpm、Corepack、npm 配置或全局 node_modules。每个能力拥有锁定依赖图，共享的只是不可变 Runtime 与内容缓存：

```text
<SuperWagie app data>/capabilities/<env-key>/node_modules
<SuperWagie cache>/pnpm-store
```

依赖生命周期脚本默认关闭。内置能力确实需要 native addon 或构建脚本时，在发布构建阶段完成并随签名制品分发，不能转移到用户首次运行。用户 Skill 需要构建脚本时，必须在 manifest 中逐包、逐脚本声明，在专用 Installer Worker 中执行，并在扩展安装前展示包来源、脚本、网络目标、构建工具和预计产物，取得一次明确授权。授权只允许这次扩展安装事务，不能转换为运行期任意命令权限。

### 4.4 缺失与冲突处理

- 内置 Runtime 缺失、hash/签名错误或 feature probe 失败：判为安装损坏/升级不完整，进入应用修复或回滚；不显示为某 Capability 的普通“需要安装”；
- 外部 WPS/Office 等宿主缺失：只禁用依赖它的能力，显示官方来源与重新检测，不由 SuperWagie 静默下载安装；
- 用户扩展依赖缺失：只能在用户主动安装/更新该扩展的事务中获取、构建和验证；任务首次执行时不得临时补装；
- Runtime 版本冲突：内置能力只使用 Runtime Manifest 指定的产品 Runtime，不从系统中选择“另一个版本”；外部宿主按 Adapter 兼容矩阵选择；
- 依赖安装失败：保留旧的可用环境，新环境进入 quarantine，不覆盖当前指针；
- 磁盘不足：安装前预算空间；共享缓存和旧环境使用引用计数/租约清理；
- 断网：基础安装介质必须可完成全部内置能力安装；用户扩展只在其离线包/缓存完整时安装，否则给出精确缺失清单；
- 不允许能力修改系统 Python、全局 npm、用户 shell profile 或 PATH。

### 4.5 原生依赖 Installer Worker

官方内置能力的必要原生依赖在发布构建阶段生成、审计并随安装包分发；用户 Skill 的必要原生依赖只能在显式扩展安装/更新事务中生成。两者都使用比普通 Extension Worker 更窄的临时环境，但生产客户端不得在首次调用内置能力时运行构建：

```text
Verified package source / lockfile
        │
        ▼
Installer Plan
├── exact packages + hashes
├── lifecycle/build scripts
├── compiler/toolchain requirements
├── allowed registry/artifact URLs
├── expected outputs
└── permission receipt
        │
        ▼
Ephemeral Installer Worker
├── no Workspace mount
├── no user home / Keychain / browser data
├── no platform or task credentials
├── network only for declared immutable artifacts
├── staging directory only
└── CPU / memory / time / output limits
        │
        ▼
Validate → SBOM → sign environment manifest → atomic promote
                    └── failure: quarantine and preserve old environment
```

优先顺序固定为：已验证预编译 wheel/binary → 可复现本地构建 → 明确失败。不能为了安装成功而临时扩大到任意网络、Workspace 或用户主目录。构建产物必须与 capability/version/lock/runtime/platform/toolchain 身份绑定；任何输入变化都生成新环境，不能原地修改正在使用的环境。

用户授权界面描述真实动作，例如“允许为此 Skill 构建 `sharp` 原生模块”，不使用笼统的“允许执行脚本”。升级新增或改变构建脚本、网络目标、原生包或权限时必须重新授权。

## 5. Managed AI Runtime

托管 AI 应拆成两个技术通道：

```text
1. Agent Reasoning Channel
Bundled Codex App Server
  -> Responses-compatible SuperWagie Gateway
  -> internal model router

2. Capability AI Facade
Official/User Capability
  -> typed Host Request
  -> Rust Managed AI Client
  -> SuperWagie Gateway
  -> chat / reason / vision / OCR / image / embed / search
```

这样拆分的原因是：Codex 自定义 Provider 当前只接受 `responses` wire API；图片生成、OCR、embedding、素材上传和未来媒体模型需要独立的类型化协议。两条通道都只能接触 SuperWagie 的 profile 与 task token，不能看到 Provider、真实模型名、Base URL 或平台 Key。

推荐公开给能力的稳定接口：

```text
ai.chat(request)
ai.reason(request)
ai.vision(request)
ai.ocr(request)
ai.generate_image(request)
ai.embed(request)
```

请求中允许的是 `profile = fast | balanced | deep | vision | image` 和质量/尺寸等产品参数，不公开 Provider model ID。返回统一包含：

```text
operation_id
result / artifact_refs
usage_receipt_id
retryability
policy_decision
```

计量应发生在服务端 Gateway：客户端 receipt 只能用于展示和对账，不能成为可篡改的最终账本。`reserve → execute → settle`、个人/企业 Wallet 与 Credits 映射仍需在账户与计费专题中完成，因此 `AI-05` 暂不升级状态。

## 6. 分项可行性结论

### 6.1 封闭 Agent Runtime

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| AR-01 | `FEASIBLE_CONDITIONAL` | Apache-2.0 Codex App Server 固定 commit、按 target 分发签名 sidecar | macOS/Windows 安装包均启动指定哈希，许可证/SBOM/Schema 齐全 |
| AR-02 | `FEASIBLE_CONDITIONAL` | 独立 roots、`env_clear`、绝对路径、untrusted project、项目指令关闭、插件/用户配置关闭 | 恶意系统 `~/.codex`、PATH、AGENTS、Skill、环境变量均不能改变结果 |
| AR-03 | `FEASIBLE_CONDITIONAL` | 私有 stdio JSONL + Rust allowlist adapter + bounded queues | 流控、取消、10MB tool output 被转为 ArtifactRef 而非内联、乱码行、协议错误与 crash 测试通过 |
| AR-04 | `FEASIBLE_CONDITIONAL` | Runtime thread 可恢复；Durable Workflow/Artifact 状态归 Rust | kill -9 后从 checkpoint 恢复，不重复 Host Request 或扣费 |
| AR-05 | `FEASIBLE_CONDITIONAL` | 无端口、无 daemon attach、独立进程树/状态/cache/升级 | 同时运行系统 Codex 与 SuperWagie，双向配置/会话/升级均无影响 |
| AR-06 | `RESEARCH_REQUIRED` | SuperWagie system policy、知识工具、内容 readiness 与任务 Eval | 固定 30 题 Eval（长文/PPT/资料整理各 10 题）端到端任务成功不少于 24 题，平均人工评分不少于 4/5，越权写入、文件损坏、泄露 Provider/Key 和错误跳过必经 Human Gate 均为 0 |

### 6.2 沙箱与安全代理

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| SEC-01 | `FEASIBLE_CONDITIONAL` | Rust root authorization + Codex/Worker OS sandbox | traversal、symlink、junction、hardlink、TOCTOU 攻击集无法越界 |
| SEC-02 | `FEASIBLE_CONDITIONAL` | 已确认采用 ExecutionManifest + Process Broker；允许声明式 Python/Node/native/MCP stdio 入口，不提供任意 shell；子进程继承 sandbox | 合法 Skill 脚本完整运行，同时 shell、batch、PowerShell、script shebang、参数注入和 child-of-child 逃逸失败 |
| SEC-03 | `FEASIBLE_CONDITIONAL` | 默认断网 + SuperWagie Broker；Codex proxy 只作附加防线 | DNS rebinding、redirect、localhost、私网、Unix socket、上游代理测试 |
| SEC-04 | `FEASIBLE_CONDITIONAL` | 服务端 Key + 短期 task token + secret handle + 日志脱敏 | Skill、child env、stdout、crash dump、错误栈均取不到 Provider Key |
| SEC-05 | `FEASIBLE_CONDITIONAL` | Rust Product Core 权威；Shell/Host/Extension/Render 分进程；ClientIntent→AuthorizedCommand；Resource Handle | 伪造 actor/caller/project/grant/wallet/risk、replay、跨 audience handle、未确认 Office 操作被拒绝 |
| SEC-06 | `RESEARCH_REQUIRED` | 依赖后续 Capability Manifest、审批 UI 和审计协议 | 权限声明、差异升级、撤销、企业策略 PoC |
| SEC-07 | `RESEARCH_REQUIRED` | 不可信内容标记、渲染隔离、URL broker、prompt boundary | 专门 threat model 与 prompt-injection/HTML/图表攻击语料 |
| SEC-08 | `RESEARCH_REQUIRED` | 用户扩展仅接受 Skill/MCP，安装后转换为 versioned manifest 与隔离执行描述 | 来源、类型、权限、更新和卸载全链路 PoC |
| SEC-09 | `RESEARCH_REQUIRED` | 设置内 Agent 解析安装意图，安装前展示实际来源与权限差异 | GitHub、本地 Skill、stdio/remote MCP 的幂等安装和回滚 |
| SEC-10 | `FEASIBLE_CONDITIONAL` | 用户 Skill 与官方能力共用 Public Capability Facade；Trusted Gateway 注入可信上下文；Extension Worker 经 Broker 调用 Signed Runtime/External Host | 同一 fixture 分别由官方与用户能力调用文件、Python/Node、ffmpeg、WPS、绘图和 AI，结果契约一致且无法绕过 Broker |

### 6.3 公共 Runtime 与依赖

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| DEP-01 | `FEASIBLE_CONDITIONAL` | OS Baseline + Signed Runtime Image/Manifest + External Host + User Extension Environment | 双平台离线干净安装、镜像损坏修复/回滚、WPS 缺失/多版本、扩展环境隔离矩阵 |
| DEP-02 | `FEASIBLE_CONDITIONAL` | 共享只读产品 executable/OS ABI；清空环境；不共享用户全局包与配置 | 污染 PATH/npmrc/pip.conf/site-packages 后结果不变，内置 Runtime 不发生系统回退 |
| DEP-03 | `FEASIBLE_CONDITIONAL` | uv.lock/pnpm-lock + 独立 env + SuperWagie shared store；原生依赖绑定 toolchain 身份 | 两个依赖冲突能力并行运行，store 去重、环境不串包、toolchain 变化不复用旧 native artifact |
| DEP-04 | `FEASIBLE_CONDITIONAL` | 内置能力可达闭包在发布构建阶段 staging/SBOM/签名后进入只读镜像；用户扩展依赖在显式安装事务的 Installer Worker 中处理 | 离线基础安装、取消/失败/修复/回滚，以及用户扩展断网、代理、磁盘满、checksum 错、恶意 install script 测试 |
| DEP-05 | `FEASIBLE_CONDITIONAL` | 内置依赖缺失进入安装修复；外部宿主使用 Capability availability 按能力降级 | 篡改产品 Python/Node/FFmpeg 触发修复/回滚；移除 WPS 只禁用 Office truth 能力 |
| DEP-06 | `RESEARCH_REQUIRED` | Runtime 引用图 + release telemetry + Rust replacement | 迁移后证明无能力引用该 Runtime，并完成旧环境安全清理 |

### 6.4 Managed AI

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| AI-01 | `FEASIBLE_CONDITIONAL` | Agent Responses 通道 + typed Capability AI Facade，共用 task identity | 官方和用户能力同一 fixture 能调用同等级授权能力 |
| AI-02 | `FEASIBLE_CONDITIONAL` | 只公开 profile 与产品回执，路由完全在服务端 | UI、日志、Capability、错误响应均不泄露 Provider/Key/内部 model ID |
| AI-03 | `FEASIBLE_CONDITIONAL` | 版本化多模态 Schema + Artifact upload/ref + stream/cancel | text/image/PDF 输入、OCR、图像生成、大 Artifact 和取消 PoC |
| AI-04 | `FEASIBLE_CONDITIONAL` | 服务端 Key Vault + 短期 scoped token + rotation/revocation | token 过期、撤销、重放、跨用户/组织/能力越权均失败 |
| AI-05 | `RESEARCH_REQUIRED` | Gateway 服务端计量 + receipt + Billing ledger | 留待 Credits/Wallet/reserve-settle 专题与故障注入证明 |

## 7. 不采用的路径

- 不发现或连接机器上已存在的 Codex Server/daemon；
- 不通过 `codex`、`node`、`python` 等裸命令名启动关键进程；
- 不向普通用户 Skill 提供任意交互式 shell、`shell -c`、`cmd /c` 或 PowerShell `-Command`；复杂任务使用包内版本化脚本和结构化参数；
- 不把 App Server WebSocket/TCP 暴露在 localhost，也不让多个应用共享 daemon；
- 不把原始 App Server JSON-RPC、`thread/shellCommand` 或配置覆盖传给前端和 Skill；
- 不仅靠 `CODEX_HOME` 宣称完成隔离；
- 不允许 Capability 直接读取系统 Keychain/Credential Manager 或平台 Provider Key；
- 不把用户的 `site-packages`、全局 `node_modules`、npmrc、pip.conf、`.env`、shell profile 当公共依赖；
- 不为每个 Skill 打包一套完整 Python/Node Runtime；
- 不为每个 Skill 重复打包 Python/Node，也不使用 Electron Node 充当 Skill Runtime；确有内置能力需要时只在 Signed Runtime Image 随基础安装一份；
- 不在内置能力首次使用时安装 Runtime 或依赖；用户扩展依赖只允许在用户明确触发的扩展安装/更新事务中处理；
- 不让依赖安装直接写正式环境，也不默认运行第三方 install script；
- 不因为用户 Skill 需要 native addon 就永久拒绝其安装；允许受控构建，但 Installer Worker 不得挂载 Workspace、用户主目录或凭证；
- 不把 Codex experimental network proxy 当成覆盖所有工具的稳定 Network Broker；
- 不承诺 Windows 10 与 Windows 11 elevated sandbox 等价。

## 8. 必须执行的组合 PoC

### 8.1 PoC A：Runtime 完全隔离与协议收口

准备一台已经安装并运行系统 Codex 的机器，同时设置：

- 系统 `~/.codex/config.toml` 指向错误 Provider；
- 系统 Skills、MCP、AGENTS.md 和 project `.codex/config.toml`；
- PATH 前部放置伪造的 `codex`、`python`、`node`；
- 父进程环境放置测试 SECRET/TOKEN；
- 系统 Codex 正在运行长任务并更新自身。

必须证明 SuperWagie：

1. 启动的是 manifest 记录哈希的 sidecar；
2. 只创建私有 stdio，不开 TCP/daemon；
3. 不读取上述系统状态和项目指令；
4. Rust Adapter 拒绝 `thread/shellCommand` 与未知方法；
5. App Server Worker crash 后恢复 thread，Workflow 不重复 Host Request；Main/Core/其他 Worker 不被连带重启；
6. 系统 Codex 与 SuperWagie 的会话、日志、Skill、配置、升级互不变化。

### 8.2 PoC B：跨平台沙箱与 Broker

攻击集至少覆盖：

- `../`、绝对路径、symlink/junction/hardlink、rename race；
- shell、PowerShell、batch、shebang、解释器 `-c`、child-of-child；
- 合法 Python/Node Skill 脚本、多参数与空格/中文路径，证明禁止任意 shell 不会阻断正常执行；
- DNS rebinding、HTTP redirect、localhost、私网、IPv6、Unix socket、系统代理；
- 读取 Keychain/Credential Manager、浏览器 cookie、SSH key、环境 secret；
- 伪造 Host Request、重复 request ID、过期 token、跨 workspace artifact。
- 伪造 ClientIntent 的 actor/caller/project/grant/wallet/billing/risk，以及转用其他 audience 的 Resource Handle。

平台：macOS arm64 实机、Windows 11 x64 elevated sandbox；若要支持 Windows 10 或 unelevated，必须单独给出降级报告。

### 8.3 PoC C：产品共享 Runtime + 隔离依赖

构造四个能力：

```text
Python A：依赖 package-x==1
Python B：依赖 package-x==2
Node A：依赖 package-y@1
Node B：依赖 package-y@2
```

必须证明：

- 同一份 Signed Runtime Image Python/Node 可并行运行四个内置能力，Electron Node 不出现在执行身份中；
- 依赖版本互不污染；
- uv/pnpm store 确实去重；
- 用户全局包、配置和环境变量无法改变锁定结果；
- 篡改或删除产品 Runtime 会被安装完整性检查发现并进入修复/回滚，不伪装为普通能力降级；
- 在没有系统 Python/Node 的干净机上，离线基础安装后四个内置能力仍可运行，首次执行无网络与安装动作；
- 移除 WPS 等外部宿主只禁用依赖该宿主的能力，恢复宿主后重新探测即可恢复；
- 新增用户 Skill 时，其依赖只在扩展安装事务中建立；取消安装不会影响工作台、内置能力和其他扩展；
- 断网且 cache 完整时可重建，cache 不完整时精确报缺失；
- checksum 错误、磁盘满和进程中断不会替换旧可用环境。
- 官方签名白名单与用户明确授权两条原生构建路径都能生成可审计环境；恶意构建脚本无法读取 Workspace、凭证或向未声明目标联网；

### 8.4 PoC D：托管 AI 与凭证不泄露

搭建最小 Responses-compatible Gateway 和 typed AI mock：

- App Server 完成一轮 streaming、tool call、cancel、retry；
- 官方/用户 Capability 各调用 chat、vision、OCR、image；
- profile 在服务端路由，客户端与 Capability 不出现 Provider/model ID；
- task token 限定 capability、operation、artifact、预算与过期时间；
- 服务器 Provider Key 不出现在子进程环境、日志、错误、crash dump；
- 重放、越权、撤销和 Gateway 中断都有可核验结果。

### 8.5 PoC E：用户 Skill 系统能力等价性

使用同一组 fixture，分别从官方 Capability 与用户 Skill 调用：

- Workspace 读取、检索、source-range patch、Artifact 导出；
- 产品 Python/Node、随包 ffmpeg 以及外部 Git 的允许操作；
- WPS 生成、真实渲染和 Review；
- Excalidraw 与 draw.io typed operations；
- chat、vision、OCR、image 等 Managed AI；
- Workflow checkpoint、Review 和 Undo。

必须证明公开操作的参数语义、结果 Schema、错误类型和 Artifact 一致；普通已授权调用不产生额外交互阻塞。同时必须证明用户 Skill 无法获得 Runtime 原始环境、任意 shell、Provider Key、私有 Workflow 或 App Server 原始协议。

### 8.5 Go / No-Go 条件

五个 PoC 通过后，相关 `FEASIBLE_CONDITIONAL` 项才可升级为 `PROVEN_POC`。

出现以下任一情况时不得进入正式实施：

- 无法可靠禁止项目 `AGENTS.md`、project config 或系统 Skill 改变 SuperWagie Agent 行为；
- raw App Server 的 full-access 方法可从 Chromium renderer、Skill 或用户输入触达；
- Windows 目标环境无法建立声明所需的 sandbox 强度，且产品没有明确降级/禁用策略；
- 产品/外部 Runtime 复用必须依赖用户全局语言包或未锁定 install script；
- 任意客户端/Capability 可获得平台 Provider Key；
- Agent crash 或重试会重复高权限 Host Request、Artifact commit 或 Credits 结算。

## 9. 已确认的产品边界

已确认：首发完整支持基线为现代 macOS 与 Windows 11，不支持普通 Windows 10。

已确认：第一版普通用户 Skill 不提供通用 shell，但允许通过 ExecutionManifest 和 Process Broker 执行已声明的 Python、Node、原生程序与 MCP stdio server。

已确认：V1 内置能力若需要 Python/Node，只在只读 Signed Runtime Image 随基础安装一份并共享；不读取或动态安装系统/用户 Python/Node，不把 Electron Node 作为 Skill Runtime。Rust 迁移后按引用图裁剪不再需要的产品 Runtime。

已确认：官方内置能力的原生依赖在发布构建阶段完成并随签名安装包交付；用户 Skill 的原生依赖使用扩展安装前的一次明确授权。二者都只能在无 Workspace、无凭证、受限网络的 Installer Worker 中构建并经验证后原子提升，但生产首次调用内置能力绝不触发构建或安装。
