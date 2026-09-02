# 规则包：封闭 Runtime 与系统依赖（runtime-isolation）

适用范围：Agent 运行环境隔离、依赖发现与共享、引导安装与能力降级。

## R-RI-01 封闭 Agent 核心

内置并固定 Codex App Server；不发现、不读取机器上的 Codex CLI/Server/Skills/MCP/配置；Agent 核心、状态、会话、工具与模型出口完全独立。[CAC §2.5] [AR-01] [AR-02]

## R-RI-02 私有通道与崩溃恢复

Electron Main 通过认证私有通道启动并连接 Rust Product Core；Core 通过私有 stdio/pipe 监管 App Server 与各类 Worker（协议版本、流控、取消、heartbeat、parent-death）。Main、Core 或单个 Worker 崩溃后，按 BCRA 的故障所有权与 Durable Workflow Checkpoint 恢复，不把整棵进程树当作一个故障域。[CAC §10] [BCRA §4] [BCRA §5] [AR-03] [AR-04]

## R-RI-03 并行不互扰

与机器上已有 Codex/Agent 环境并行运行且互不影响：端口、Socket、环境变量、缓存、插件和升级路径的冲突必须有验证义务。[CAC §2.5] [AR-05]

## R-RI-04 知识工作产品化

默认 Coding-first 行为必须经 System policy、工具、上下文与真实任务 Eval 产品化为知识工作 Agent，不把通用编码助手原样暴露给用户。[V1RS §2] [AR-06]

## R-RI-05 依赖分类与共享边界

依赖固定分为 OS Baseline、Signed Runtime Image、External Host、User Extension Environment 四层。Electron/Chromium、内置 App Server、V1 能力依赖图实际需要的 Python/Node/FFmpeg/codec、字体和签名静态资源进入只读 Signed Runtime Image，随基础安装完成且由 Runtime Manifest 锁定；WPS/Office、Git 和不可再分发系统库属于 External Host，以绝对身份 + feature probe 验证；用户扩展进入独立环境。四层都不得引入机器上其他 Agent 的参数、配置、状态、缓存或升级通道。[CAC §2.5] [BCRA §12] [DEP-01] [DEP-02]

## R-RI-06 依赖锁定与缓存

能力包依赖用 uv/npm lock 锁定并使用平台内容寻址缓存；native artifact 必须绑定 toolchain 身份；并发安装安全。[V1RS §2] [DEP-03]

## R-RI-07 安装完整性与外部宿主引导

可再分发的内置依赖不得在首次使用或任务执行中动态安装；安装器在同一产品安装事务内写入、校验签名/哈希并完成离线 feature probe。只有 WPS/Office 等不可随包再分发的 External Host 可引导用户从官方来源安装，SuperWagie 不静默安装。用户后来主动添加 Skill/MCP 的依赖属于 User Extension Environment，只能按 R-SE-02/R-SE-03 在授权安装/更新事务中建立，不能拖到首次执行。[V1RS §3] [BCRA §12] [DEP-04]

## R-RI-08 能力级降级

External Host 缺失、损坏或不兼容时，只禁用依赖它的对应能力（Capability availability + UI 降级 + 重试），不阻止 Workspace 与其他能力启动；Signed Runtime Image 缺失或完整性失败属于安装损坏/升级失败，必须进入修复或回滚，不能伪装为正常能力降级。[V1RS §2] [BCRA §12] [DEP-05]

## R-RI-09 迁移后裁剪

Rust 迁移完成并验证后，用引用追踪移除不再需要的 Runtime，保持升级兼容。[WD §11.4] [DEP-06]

## R-RI-10 Runtime Image 不可变

Signed Runtime Image 只收录 V1 Capability 依赖图可达闭包，使用固定绝对身份、签名/hash、架构、版本和离线 feature probe；任务、Worker 与用户扩展均不得修改它。缺失时禁止从系统 PATH 或用户全局 Python/Node 回退。[BCRA §5] [BCRA §12] [PKG-01]
