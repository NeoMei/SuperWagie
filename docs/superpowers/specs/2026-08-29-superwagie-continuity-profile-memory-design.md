# 超级牛马（SuperWagie）项目连续性、Agent Profile 与安全记忆设计

> 状态：产品与架构设计已确认；技术验证和生产准入未完成  
> 日期：2026-08-29  
> 上位产品基线：`docs/最早期产品方案-V0.1.md`  
> V1 范围基线：`docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md`  
> 领域语言：`CONTEXT.md`  
> 编码准入：`docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md`  
> 关联规格：`docs/superpowers/specs/2026-08-29-superwagie-account-credits-organization-design.md`

## 1. 目的与权威边界

本文定义 SuperWagie V1 的 Agent Profile、Safe Memory（安全记忆）与 Continuity（项目连续性）的用户可见行为、scope 模型、同意与保留默认值、注入策略、归属与存储边界。它是这三类产品语义的唯一权威规格；单项技术调查可以补充检索、存储、嵌入和同步的实现候选，但不得改写本文确认的用户边界。

本文不解除任何技术 Gate。`docs/技术可行性/技术要求矩阵.md` 中 CT-01、CT-02、MEM-01、MEM-02、MEM-03 的 `RESEARCH_REQUIRED` 状态不因本文确认而升级；生产实现仍必须通过对应 PoC 门和合同测试。

## 2. 已确认的产品原则

1. Profile 由用户显式编写，Memory 由 Agent 提议；两者职责不混合。
2. 记忆写入默认人在环：Agent 主动提议 + 行内确认；只有低敏类别可获得“本项目自动保存”授权。
3. V1 记忆 scope 只有 User（跨项目）与 Project（项目内）两级；Organization 与 Agent scope 仅作数据模型预留，不开放。
4. 注入有界：User Profile 全量 + 当前 Project Memory 全量 + User Memory 相关性 Top-N（不超过 20 条）。
5. 记忆内容永远是不可信上下文，不能直接提升为系统指令；注入与引用全程审计。
6. 记忆无自动过期；密码、密钥、支付、健康类内容永不自动保存，必须逐条显式确认。
7. 连续性产物是项目内普通 Markdown：`项目回顾.md` 与 `项目历史.md`；隐藏 ledger 只保存技术核算数据，不形成第二套语义真相。
8. 记忆永远归个人：组织付费项目的记忆对组织侧完全不可见，成员离开组织记忆随人走。
9. 本地优先；官方 SuperWagie 服务端（账户与账务）零记忆；跨设备与团队共享经 AgentWiki Connector 项目记忆共享路径，DEF-01（官方通用云同步）保持延后。

## 3. Agent Profile

### 3.1 定义与内容

Profile 是用户显式编写的少量稳定条目，覆盖称呼、语言、语气和交付偏好。它条目数量少、变化低频，每次对话始终注入。Agent 可以在对话中建议修改 Profile，但必须经用户确认后才生效；Agent 不能自动生成或静默改写 Profile 条目。

### 3.2 编辑入口

Profile 编辑入口位于头像菜单的独立 Agent Profile 面板，编辑直接生效。该入口不进入设置页，不改变既有“四项主设置”契约，也不新增第五个设置项。

## 4. Safe Memory

### 4.1 写入模型

Agent 在对话中主动提议记忆，以行内记忆卡片呈现记忆内容、scope 和类别，用户确认后写入。用户可对同一低敏类别授予“本项目自动保存”授权；授权后该类别在当前 Project 内的新增记忆不再逐条确认。所有授权可在设置中随时撤销。

### 4.2 Scope 模型

| Scope | V1 状态 | 注入范围 |
|---|---|---|
| User | 开放 | 所有项目 |
| Project | 开放 | 仅所属项目 |
| Organization | 仅数据模型预留 | 不注入 |
| Agent | 仅数据模型预留 | 不注入 |

预留 scope 在 V1 不提供 UI、API 和注入路径；启用它们属于产品范围变更，必须走 V1 范围基线的变更规则。

### 4.3 保留与同意默认值

记忆无自动过期，长期保留直到用户删除。密码、密钥、支付和健康类内容属于敏感类别：永不自动保存、不可获得自动保存授权，任何写入都必须逐条显式确认。“本项目自动保存”授权只覆盖低敏类别，且仅对已开启该授权的项目生效。

### 4.4 注入策略

注入采用有界三层模型：

```text
User Profile 全量
+ 当前 Project Memory 全量
+ User Memory 相关性 Top-N（≤20 条）
```

三层内容全部以不可信上下文标记注入，不能直接提升为系统指令。注入事件与后续引用全程审计，审计记录包含时间、条目身份和引用场景。

### 4.5 管理界面

设置中提供统一的记忆管理入口：按 scope 和类别浏览；逐条查看内容、来源、时间、捕获方式（行内确认或自动保存）与引用审计；支持编辑、删除、导出、清空和禁用。

## 5. Continuity（项目连续性）

### 5.1 SessionReviewer 的 V1 形态

SessionReviewer 以 Native Continuity 能力保留在 V1。它只消费 SuperWagie 自身 Agent Runtime 产生的结构化事件，不扫描 `~/.codex/sessions` 或机器上其他 Codex / Agent 宿主的数据。

### 5.2 更新节奏

任务线程收尾后异步更新连续性产物。收尾摘要更新不需要逐条行内确认，但产物内容对用户完全可见，且支持回滚到上一版本。

### 5.3 产物与视图

- `项目回顾.md`：一页内的项目当前状态快照；
- `项目历史.md`：追加式时间线记录；
- 两者都是项目内普通 Markdown，遵守 Workspace 事务写入和外部编辑恢复规则。

项目详情页提供宽版可滚动时间线的原生视图，数据来自连续性产物与事件投影，支持手动刷新。

## 6. 归属与存储边界

记忆和 Profile 永远归属个人用户。组织付费项目中的记忆不进入组织可见范围；沿用账户与 Credits 规格的“计费权≠内容权”原则，企业账单侧没有任何路径读取记忆、Profile 或连续性内容。成员离开组织时，记忆随人走。唯一例外是用户显式共享到团队共享记忆空间的条目副本；共享不改变归属，撤回共享后远端副本按 AgentWiki 侧删除策略处理，本地内容不受影响。

存储本地优先：Profile 与记忆保存在客户端受管本地存储，不属于用户项目根目录内的普通文件；官方 SuperWagie 服务端零记忆，不提供记忆的云端存储或检索。连续性的 `项目回顾.md` 与 `项目历史.md` 是唯一写入项目根目录的记忆类内容；其跨设备与团队共享同步经 AgentWiki Connector 项目记忆共享路径完成，规则以 `2026-08-29-superwagie-connector-sync-design.md` 为准。DEF-01（官方通用云同步）保持延后，V1 不做 AgentWiki 之外任何形式的服务端记忆同步。

## 7. 与其他子系统的边界

| 子系统 | 边界 |
|---|---|
| Billing | 计费权≠内容权；企业账单无路径触及记忆内容 |
| Workspace | 连续性 Markdown 走事务写入与 CAS；记忆本体不写入项目根目录 |
| Connector | 项目记忆共享仅同步显式内容；记忆本体库与 Profile 永不经 Connector 上传 |
| Extension | 用户扩展不拥有绕过注入策略直接读取记忆本体的通道；扩展能力访问经 Public Capability Facade |
| Agent Runtime | 记忆注入发生在 Runtime 上下文组装层，全部按不可信上下文处理并审计 |

## 8. 技术验证边界

本文只确认产品语义。以下技术项保持 `RESEARCH_REQUIRED`，状态只能由可重复证据升级：

| 技术项 | 内容 | 状态 |
|---|---|---|
| CT-01 | SessionReviewer 消费 SuperWagie 结构化事件 | `RESEARCH_REQUIRED` |
| CT-02 | 人类可读项目回顾与项目历史 | `RESEARCH_REQUIRED` |
| MEM-01 | Agent Profile 的 scope 与版本 | `RESEARCH_REQUIRED` |
| MEM-02 | 安全长期记忆（provenance、consent、trust、delete、审计） | `RESEARCH_REQUIRED` |
| MEM-03 | 记忆作为不可信上下文（prompt injection、检索隔离） | `RESEARCH_REQUIRED` |
