# 超级牛马（SuperWagie）

超级牛马（SuperWagie）是以本地内容为事实源、由 Agent 协助加工内容并生成多种交付物的桌面工作系统。本词汇表只定义产品领域语言，不规定具体代码实现。

## 品牌与命名

- 中文产品名：`超级牛马`；
- 英文产品名：`SuperWagie`；
- 中文客户端、官网和面向中文用户的产品文案默认使用“超级牛马”；
- 代码包、目录、协议域名、事件来源和机器标识统一使用 `superwagie`；
- 项目机器目录为 `.superwagie/`，私有能力包扩展名继续使用 `.swcap`；
- 首次对外完整出现时使用“超级牛马（SuperWagie）”，后续按语言环境使用对应名称。

## 内容与项目

**Content Workspace（内容工作区）**：
用户拥有的本地项目目录，是内容、来源、图表、任务和交付物的长期容器。
_Avoid_: 临时会话目录、云端知识库

**Project（项目）**：
用户围绕一个长期工作目标组织的产品对象，锚定一个 Content Workspace，并聚合任务项、任务线程和交付项目。
_Avoid_: Delivery Project、单个文件夹视图

V1 中 Project 与 Content Workspace 一一对应：一个 Project 只有一个授权根目录，一个 Content Workspace 也只属于一个 Project。一个 Project 可以拥有多个 Task Item、Agent Task Thread 和 Delivery Project。

**Task Item（任务项）**：
用户可查看、安排、执行和完成的一项工作。任务项可以由用户手动创建、由 Agent 根据对话创建，或由已确认的 Project Milestone 自动派生；其可移植语义保存在项目 Markdown 中。
_Avoid_: Agent Task Thread、Workflow Stage、内部工具步骤

**Project Milestone（项目里程碑）**：
项目计划中对用户有意义、可独立判断是否完成的阶段性目标。每个已确认 Milestone 最多对应一个活跃 Task Item；模型调用、渲染、索引和其他内部执行步骤不是 Milestone。
_Avoid_: Workflow Stage、每日待办、内部执行进度

**Content Scope（内容范围）**：
当前任务允许 Agent 理解的目录、文件、内容块、选区或外部只读材料集合。
_Avoid_: 整个工作区、上下文窗口

**Working Set（可写工作集）**：
当前任务被明确授权修改的 Content Scope 子集；Agent 可读不等于可写。
_Avoid_: Content Scope、项目权限

**Workspace Revision（工作区修订）**：
一次已提交的本地内容变化及其因果、文件身份和内容哈希记录。
_Avoid_: Git commit、自动保存批次

**Content Baseline（内容基线）**：
进入交付物正式制作前，由用户确认的来源文件版本、范围和哈希集合。
_Avoid_: 内容副本、最终稿

**Delivery Project（交付项目）**：
为一个明确受众、目标和交付形式建立的独立制作项目，拥有自己的目录、来源绑定、流程和输出。
_Avoid_: Content Workspace、输出文件

每个 Delivery Project 必须属于且只属于一个 Project，可以保留多个历史 Workflow Run，但同时只有一个活跃主 Workflow Run。

**Artifact（制品）**：
Workflow 或 Capability 产生并由系统记录来源与所有权的文件或文件集合。
_Avoid_: 任意临时文件、未校验输出

**Artifact Revision（制品修订）**：
某个 Artifact 的不可变版本，绑定生成依据、输入哈希和验收状态。
_Avoid_: 文件修改时间、Preview Revision

**Preview Revision（预览修订）**：
从一个 Artifact Revision 和确定渲染环境派生的不可变审阅视图。
_Avoid_: Artifact Revision、编辑副本

## Agent 与工作流

**Agent Task Thread（Agent 任务线程）**：
用户围绕一个持续工作目标与 Agent 的可恢复对话和执行上下文，也是客户端“本次会话 Credits”的累计边界。
_Avoid_: 应用启动会话、Task Item、Workflow Run

**Workflow Run（工作流运行）**：
一个 Delivery Project 或系统任务的持久化阶段执行实例，可被同一 Agent Task Thread 启动、暂停、恢复或观察。
_Avoid_: Agent Task Thread、一次模型调用

**Workflow Stage（工作流阶段）**：
Workflow Run 中具有明确输入、输出、进入条件和完成条件的业务步骤。
_Avoid_: UI 页面、Agent 消息

**Human Gate（人工门）**：
系统继续执行前必须取得的结构化用户决定及其版本化回执。机制只有三种：Workflow Gate（内容/阶段决定）、Risk Gate（scope expansion、external effect、destructive、high-cost billing）和 Install Gate（扩展安装/更新权限）。
_Avoid_: 通用确定按钮、普通对话回复

**Checkpoint（检查点）**：
任务可安全暂停并在不重复副作用和计费的条件下继续的持久状态。
_Avoid_: 自动保存、临时缓存

**Operational Record（运行记录）**：
为保证恢复、幂等、计费和审计而必须持久化的 event、checkpoint、journal 或 receipt；它不是用户语义内容，也不是可丢弃的派生索引。
_Avoid_: Workspace 内容真相、普通缓存

## 能力与扩展

**Capability（系统能力）**：
通过版本化输入、输出、权限、制品和恢复契约调用的受控产品能力。
_Avoid_: 任意脚本、低层工具函数

**Private Workflow（私有工作流）**：
官方拥有且不向用户枚举或导出的多阶段 Agent 编排，例如 SuperPPT、SuperWriter 和视频制作。
_Avoid_: 用户 Skill、用户 Workflow

**Public Capability Facade（公开能力门面）**：
主 Agent 和已授权用户扩展可调用的稳定高层能力接口，不暴露内部实现和凭证。
_Avoid_: Private Workflow API、原始 WPS API

**Shell Controller（桌面壳控制器）**：
Electron Main 在客户端可信计算基中的最小职责边界，只管理应用生命周期、窗口、菜单、Deep Link、Surface Registry、sender 校验和窄 IPC；可信但不拥有业务权威。
_Avoid_: Rust Product Core、Trusted Host、业务后端

**Rust Product Core（Rust 产品核心）**：
SuperWagie 唯一的业务、数据与策略权威，负责 Project/Workspace/Task、UI Query、Workflow/Effect Journal、Capability/Policy/Billing、Artifact/Review、依赖注册和 Worker 监管。
_Avoid_: Electron Main、单体万能进程、用户扩展 Runtime

**Resource Handle（资源句柄）**：
Rust Product Core 针对特定 Surface/Worker/Capability 签发的短期字节访问授权，绑定 Project、resource revision、允许操作、大小/range、TTL 与 audience；不暴露真实路径，也不是 Artifact 的长期身份。
_Avoid_: ArtifactRef、文件路径、永久 URL

**User Extension（用户扩展）**：
用户在设置中添加、启停或移除的 Skill 或 MCP；系统内置能力不属于用户扩展。
_Avoid_: Private Workflow、内置能力、用户 Workflow

**Trusted Host Adapter（可信宿主适配器）**：
Rust Product Core 中代表 SuperWagie 授权和校验受保护桌面应用、系统自动化或宿主服务调用的受控边界；真实副作用由隔离 Host Worker 执行。
_Avoid_: Extension Sandbox、普通脚本

**Extension Sandbox（扩展沙箱）**：
用户扩展的受限执行域，只能使用声明并获准的文件、网络、进程和公开系统能力。
_Avoid_: Agent Runtime、Trusted Host

**Runtime Dependency（运行依赖）**：
按 OS Baseline、Signed Runtime Image、External Host、User Extension Environment 四层管理的运行前提。内置 Python/Node/FFmpeg 等进入只读镜像；WPS/Git 等按绝对身份探测；扩展依赖只进独立环境；任何层都不共享其他 Agent 配置与状态。
_Avoid_: Agent Runtime、全局 Agent 环境、随机 PATH 命中、首次使用补装

**Official Host（官方托管服务）**：
由 SuperWagie 官网提供的静态 HTML 发布、稳定链接、更新、回滚和停止分享服务。对用户只有这一个发布目标；底层存储和 CDN 不属于用户可见的 Connector。
_Avoid_: 用户配置的 Cloudflare/GitHub Pages、任意第三方服务器

## 连续性与记忆

**Agent Profile（Agent 档案）**：
用户显式编写的少量稳定偏好条目（称呼、语言、语气、交付偏好），每次对话始终注入；Agent 不能自动生成或静默改写。
_Avoid_: Safe Memory、系统提示词

**Safe Memory（安全记忆）**：
Agent 提议、用户确认后保存的长期记忆条目，分 User 与 Project scope，作为不可信上下文按相关性注入。
_Avoid_: Agent Profile、会话日志、缓存

**Continuity（项目连续性）**：
任务线程收尾后异步生成的项目回顾与项目历史 Markdown 产物，以及对应的时间线视图。
_Avoid_: 会话日志、聊天记录

## 连接与同步

**Connector（连接器）**：
客户端连接一方远程服务的官方通道；V1 内置且仅有 AgentWiki Connector，契约可扩展但不开放第三方接入。
_Avoid_: MCP 扩展、第三方连接器

**Project Connector Binding（项目连接绑定）**：
项目与已授权连接的一次绑定，指定 Space 与 Workspace 内同步目录；一项目同一时刻只绑一个 Space。
_Avoid_: 连接管理、实例级授权

**Personal Sync Area（个人私有区）**：
用户在 Space 内仅本人可见的同步区域；连续性产物收尾后自动同步至此，跨设备恢复项目上下文。
_Avoid_: 团队共享记忆空间、云端备份

**Shared Memory Space（团队共享记忆空间）**：
Space 内由项目指定的共享目录；显式勾选的记忆条目经 Push 预览确认后发布给团队成员。
_Avoid_: 个人私有区、自动同步

**MCP Query Bridge（只读查询桥）**：
项目绑定 Space 后自动获得的远程只读查询能力（语义搜索、读未拉取页面）；写入只走同步路径。
_Avoid_: 远程写入、双向同步

## 计量

**Session Credits（任务线程 Credits）**：
当前 Agent Task Thread 自创建以来累计的用户可见消费信息；关闭和恢复任务不清零，新建任务线程才重新累计。
_Avoid_: 账户余额、单轮 Token 数
