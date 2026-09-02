# 超级牛马（SuperWagie）任务管理模块设计

> 状态：产品设计已确认；等待 Gate 1 技术验证  
> 日期：2026-08-29  
> 上位领域语言：`CONTEXT.md`  
> 视觉参考：[任务管理布局](../../../.superpowers/brainstorm/7433-1787906086/content/task-management-model-choice.html)的 A 方案“统一日程列表 + 任务详情”
> 技术可行性归属：TASK-01～06 依赖 04 号 Workspace/Markdown 引擎调查与本设计；实现证据由技术验证计划 G1-TASK-001 提供

## 1. 设计决定

SuperWagie 将任务管理作为客户端一级工作模块，而不是只在首页展示 Markdown checkbox。用户手动创建、Agent 对话创建和 Project Milestone 自动创建的任务统一为 `Task Item`，使用同一列表、详情、查询、状态和修改协议。

所有任务的用户语义仍以项目 Markdown 为事实源。任务管理模块拥有查询、创建、编辑、筛选、日历和执行入口，但不建立第二套数据库任务真相，也不是独立 Skill、Workflow 或云端服务。

项目自动创建任务只到 **Milestone 粒度**。Workflow Stage、模型调用、索引、渲染、媒体编码和工具调用属于内部执行过程，不进入用户任务列表。

## 2. 对象边界与关系

```text
Project
├── Task Item 0..N
│   ├── source Markdown block 1
│   ├── current Agent Task Thread 0..1
│   ├── historical Agent Task Threads 0..N
│   └── linked Workflow Runs / Delivery Projects 0..N
├── Project Milestone 0..N
│   └── active derived Task Item 0..1
├── Agent Task Thread 0..N
└── Delivery Project 0..N
    └── Workflow Run 0..N
```

- `Task Item` 是用户计划和管理的工作；
- `Project Milestone` 是用户可判断完成与否的阶段目标；
- `Agent Task Thread` 是 Agent 对话、执行和 Session Credits 边界；
- `Workflow Run` 是持久化业务阶段执行；
- 一个 Task Item 可以没有 Agent 执行，也可以先由用户处理、再交给 Agent，或由双方协作；
- 一个 Agent Task Thread 可以由 Task Item 启动，但 Thread 的停止、失败或归档不会隐式删除 Task Item；
- Task Item 完成不等于强制停止仍在运行的 Thread。存在活跃执行时，UI 必须分别提供“仅标记任务完成”和“停止关联执行”。

## 3. Task Item 契约

### 3.1 用户语义字段

| 字段 | 规则 |
|---|---|
| `task_id` | 稳定身份；SuperWagie 创建的任务写入稳定 block ID，不能长期使用行号 |
| `project_id` | 必填；Task Item 只属于一个 Project |
| `title` | 必填、非空，可由用户修改 |
| `state` | `inbox`、`planned`、`in_progress`、`waiting_user`、`blocked`、`completed`、`cancelled`、`superseded` |
| `responsibility` | `user`、`agent` 或 `shared`；与创建来源无关 |
| `due_at` / `scheduled_at` / `start_at` | 可选；驱动今天、即将到期和日历视图 |
| `priority` | 可选、稳定枚举；不由颜色单独表达 |
| `tags` | 项目 Markdown 标签 |
| `recurrence` | 可选；完成当前实例后按规则创建下一实例 |
| `dependency_task_ids` | 可选；只能引用同一 Project 中可解析 Task Item |
| `source_document_id` / `source_block_id` | 指向 Markdown 真实位置 |

### 3.2 来源与执行关联

| 字段 | 值或规则 |
|---|---|
| `origin` | `manual`、`agent`、`project_milestone` |
| `origin_key` | 仅自动派生时必填；由 `project_id + milestone_id` 决定，用于幂等 reconciliation |
| `milestone_id` | 仅 Project Milestone 派生任务使用 |
| `current_task_thread_id` | 可选；只表示当前执行入口，不改变任务身份 |
| `linked_workflow_run_ids` | 可选；用于进度、恢复和证据导航 |
| `linked_delivery_project_ids` | 可选；用于跳转相关交付物 |
| `user_overrides` | 记录用户对自动任务标题、时间、优先级和责任人的显式修改，reconcile 时必须保留 |

`origin` 表示谁触发创建，`responsibility` 表示谁负责完成，两者不能合并。例如 Agent 可以根据对话创建一项由用户负责的任务。

## 4. Markdown 事实源与索引

```text
Markdown task block
→ lossless Task Adapter
→ Task projection / calendar projection
→ Task Management UI / Workbench / Project detail / Agent
→ semantic task command
→ Workspace CAS transaction
→ Markdown task block + new Workspace Revision
```

- 用户在普通文档中已有的任务原地保留；
- 在任务模块或 Agent 对话中创建且未指定目标文件时，默认写入项目根目录的 `任务.md`；
- Project Milestone 派生任务默认写入同一 `任务.md` 的“项目里程碑”区段；
- 如果用户已为项目配置默认任务文档，则使用该文件，不重复创建 `任务.md`；
- SuperWagie 创建的任务使用稳定 block ID。外部已有任务只在首次修改、关联执行或成为 dependency 时，通过语义 patch 增加稳定 ID；只读扫描不能改写文件；
- title、checkbox/status、日期、优先级、标签、循环和 dependency 等可移植语义保存在 Markdown；
- `origin_key`、Thread/Workflow/Delivery 关联、reconcile receipt 和 user override provenance 属于运行关联，保存在 App Data Operational Store，并可裁剪写入项目 `.superwagie` checkpoint manifest；
- Derived Index 保存 source range、解析结果和查询 projection，可以删除重建；不得把索引当成任务事实源；
- V1 的具体 Obsidian Tasks 语法映射必须由 MD-08 / G1-TASK-001 往返 fixture 锁定。在此之前只固定上面的语义枚举，不提前宣称所有自定义 checkbox 字符已兼容。

## 5. 三种创建路径

### 5.1 用户手动创建

- 工作台“今日待办”和 Tasks 一级模块都提供紧凑新建入口；
- 必须选择或继承 Project；title 必填，日期、责任人、优先级和标签可选；
- 创建是可逆的普通 Workspace 写入，成功后显示任务及“打开源文件”；
- 在某个 Markdown 文档内创建时默认写入当前文档，在全局入口创建时默认写入项目任务文档。

### 5.2 Agent 对话创建

- 用户可以自然语言要求“为周五创建 Review 任务”“提醒我补充第二章材料”；
- 当前 Project 和目标明确、单项或小批量创建时，Agent 可以通过 `task.create` 直接创建并返回行内 receipt；
- Project、责任人、日期含义不明确，或创建范围跨项目、数量异常时，Agent 先在原对话中追问或展示结构化预览；
- Agent 不直接拼接 Markdown 字符串，必须调用 Task API 和 Workspace semantic patch；
- Agent 创建任务不等于立即启动执行。只有用户明确要求执行，或责任人为 `agent/shared` 且已授权时，才创建或关联 Agent Task Thread。

### 5.3 Project Milestone 自动创建

- Milestone 必须来自用户已经确认的项目计划、Delivery 计划或重规划决定；未确认的 Agent 草案不能自动写入任务列表；
- 每个 Milestone 使用稳定 `milestone_id`，通过 `origin_key = project_id + milestone_id` 幂等创建或更新一个活跃 Task Item；
- 自动任务只表达 Milestone，例如“完成需求基线”“确认 PPT 大纲”“发布课程视频”；内部八阶段/七阶段可以根据产品语义合并为更少的项目 Milestone；
- Milestone 开始、等待用户、受阻、验收完成时更新关联 Task Item 的投影；内部进度只显示在详情，不生成子任务；
- 重复事件、客户端重启和 Workflow 重放不得重复创建任务；
- 项目重规划取消旧 Milestone 时，将旧任务标记 `superseded`，保留历史和来源；
- 用户修改过的 title、日期、优先级或 responsibility 不被自动 reconciliation 覆盖；系统更新其他字段时必须保留 `user_overrides`；
- 用户删除自动任务后记录 tombstone。相同 Milestone 后续事件不得静默重建，除非用户选择“恢复里程碑任务”。

## 6. Task Item 状态机

```text
inbox → planned → in_progress → completed
             ↘ waiting_user ↗
             ↘ blocked ─────↗

inbox | planned | in_progress | waiting_user | blocked
→ cancelled | superseded

completed | cancelled | superseded
→ planned | in_progress        # 用户明确重新打开
```

- `inbox`：已记录但尚未安排；
- `planned`：已安排，尚未开始；
- `in_progress`：用户或 Agent 正在推进；
- `waiting_user`：需要用户提供内容、选择或确认；
- `blocked`：依赖、权限、环境或外部条件阻止继续；
- `completed`：用户目标已经完成，而不只是某次 Agent 回合结束；
- `cancelled`：目标不再需要；
- `superseded`：因项目重规划被新的 Milestone/Task 取代。

Agent Task Thread 的 `credits_blocked`、`disconnected`、`recoverable_failed` 等运行状态可以显示在任务详情中，但不能直接扩充 Task Item 状态枚举。Task Item 只在这些情况确实阻止目标推进时投影为 `blocked`，并保留具体运行原因。

## 7. Tasks 一级模块与入口

Tasks 使用已确认的“统一日程列表 + 任务详情”布局：

```text
GlobalRail / Tasks
├── 左侧：今天、即将到期、全部、已完成 + 项目/来源/责任人筛选
└── 右侧：任务详情、来源、日期、dependency、Milestone、执行状态和动作
```

必备入口与行为：

- `今天`：已到期、逾期、进行中和等待用户任务；
- `即将到期`：按日期分组，不建立外部日历依赖；
- `全部`：支持 project、state、origin、responsibility、priority 和 tag 筛选；
- `已完成`：completed/cancelled/superseded 分组，默认不混入进行中列表；
- Task Detail 提供编辑、完成、重新打开、取消、打开源文件、开始/继续 Agent、查看 Milestone/Workflow/Artifact；
- Workbench 只显示今日摘要和快速创建，点击进入 Tasks；
- Project Detail 显示本项目任务和 Milestone 进度；
- Agent Panel 显示当前关联 Task Item，但不把完整任务管理塞入对话栏；
- QuickSwitcher 可以按 task title、project、tag 和 stable task ID 定位。

## 8. 命令、权限与副作用

Public Capability Facade 保留统一的 `task.query/create/update`，新增 `task.start_execution` 和 `task.open_source`：

- `task.create` 的 `origin` 由受信调用上下文确定，用户 Skill 不能伪造 `project_milestone`；
- `project_milestone` reconciliation 是 Project & Task 内部命令，不公开为扩展方法；
- `task.update` 使用 task ID、base Workspace Revision 和字段级 patch；
- 完成、取消、重开任务是普通可撤销写入；删除源 Markdown block 是破坏性操作，必须遵循 Workspace 删除规则；
- `task.start_execution` 创建或恢复关联 Agent Task Thread，不能跳过 Working Set、权限、Credits 和 Human Gate；
- 用户 Skill 可以在获授权 Project 中创建普通任务，但不能枚举未授权 Project 或操纵内部 Workflow/Milestone 来源。

## 9. 一致性、冲突与恢复

- 外部 Obsidian 修改优先进入 Workspace watcher reconciliation，再更新 Task projection；
- UI/Agent patch 提交前比较 source revision；任务已被移动时使用 task ID、block ID、内容指纹和邻域重新定位；
- 无法唯一定位时进入 Base/Current/Proposed 冲突，不按旧行号覆盖；
- Task 创建、Milestone mapping 和 Workflow link 使用同一 request ID/receipt，防止文件已写入但关联未提交造成重复；
- Markdown 写入成功、Operational Store 提交失败时进入 recoverable state，并通过 task ID/source hash reconcile；
- Operational Store 丢失时仍能扫描出用户任务；自动来源和执行关联只有在 checkpoint manifest 或已接受项目计划可恢复时才重建，不能凭标题猜测；
- recurrence 产生下一实例时创建新 task ID，并通过 `recurrence_parent_task_id` 关联，不能复用已完成任务身份。

## 10. V1 范围与明确不做

V1 必须完成：

- Tasks 一级模块、列表详情、筛选和快速创建；
- 手动、Agent 对话、Project Milestone 三种创建来源；
- Markdown 事实源、稳定 task ID、semantic patch 和 Obsidian 往返；
- Project、Workbench、Agent、Workflow 和 Artifact 导航关联；
- Milestone 幂等 reconciliation、用户 override、superseded 和 tombstone；
- 今天/即将到期/全部/已完成视图与本地日历投影。

V1 不包括：

- 系统或第三方日历双向同步；
- 多人任务分派、企业审批、工时、甘特图和资源管理；
- 为每个 Workflow Stage 或工具步骤自动创建任务；
- 独立任务云数据库或脱离 Markdown 的任务真相；
- 完整兼容任意 Obsidian Tasks/Dataview 插件查询语言。

## 11. 验收场景

1. 用户在 Tasks 中创建任务，`任务.md` 出现可由 Obsidian 打开和修改的任务；外部完成后 SuperWagie 增量更新。
2. 用户在 Agent 对话中创建一项由自己负责的任务，任务不会自动启动 Agent Thread。
3. 用户要求 Agent 执行一项任务，系统创建/关联 Thread；停止 Thread 后任务仍存在并可继续。
4. 一个已确认项目计划包含三个 Milestone，只创建三个任务；数十个内部 Workflow Stage/event 不增加任务。
5. 同一 Milestone 事件重复、重启或重放十次，只存在一个活跃任务。
6. 用户修改自动任务的日期和标题后项目重规划，修改被保留；被移除 Milestone 的任务进入 `superseded`。
7. 用户删除自动任务后，同一 Milestone 更新不静默重建；用户可从项目详情恢复。
8. 外部编辑与 Agent 同时修改任务时不会按旧行号覆盖，冲突保留 Base/Current/Proposed。
9. 完成任务时存在活跃 Agent 执行，UI 不会暗中终止执行，而是分别提供任务状态与执行控制。
10. 删除 Derived Index 后可从 Markdown 重建任务列表；缺少运行关联时不会伪造 Thread/Workflow link。
