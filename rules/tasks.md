# 规则包：任务管理（tasks）

适用范围：Tasks 一级模块、任务创建/编辑/筛选、Milestone 派生、任务与执行关系。

## R-TK-01 三来源统一协议

用户手动创建、Agent 对话创建、Project Milestone 自动创建统一为 Task Item，走同一 Task API、同一列表与状态协议；不得为任一来源单独建立第二套任务存储。[TASK §1] [TASK §5] [TASK-01]

## R-TK-02 Markdown 事实源与稳定 ID

任务语义以项目 Markdown 为事实源；SuperWagie 创建的任务写稳定 block ID；外部已有任务仅在首次修改、关联执行或成为依赖时经 semantic patch 惰性加 ID，只读扫描不得改写文件。[TASK §3.1] [TASK §4] [TASK-02] [MD-08]

## R-TK-03 默认落点是 任务.md

在任务模块或 Agent 对话中创建且未指定目标文件时，写入项目根 任务.md；Milestone 派生任务写入其“项目里程碑”区段；用户已配置项目任务文档时不重复创建。[TASK §4]

## R-TK-04 Milestone 幂等

每个 Milestone 用 origin_key = project_id + milestone_id 幂等创建或更新唯一活跃任务；重复事件、客户端重启、Workflow 重放不得重复创建；内部 Stage、工具调用、模型调用不生成任务。[TASK §5.3] [TASK-03]

## R-TK-05 Override 与 tombstone

用户对自动任务 title、日期、优先级、责任人的修改记录在 user_overrides，reconcile 必须保留；重规划取消的任务标记 superseded；用户删除自动任务后写 tombstone，同一 Milestone 后续更新不得静默重建。[TASK §3.1] [TASK §5.3] [TASK-04]

## R-TK-06 三对象状态分离

Task Item、Agent Task Thread、Workflow Run 的状态与控制严格分离；完成任务不等于停止执行，UI 必须分别提供“仅标记完成”与“停止关联执行”；Thread 运行态不得扩充任务状态枚举。[TASK §2] [TASK §6] [TASK-05]

## R-TK-07 执行入口不越权

task.start_execution 不得绕过 Working Set、权限、Credits 与 Human Gate；用户 Skill 不能伪造 origin = project_milestone，Milestone reconciliation 不公开为扩展方法。[TASK §8] [WF-02]

## R-TK-08 冲突与一致性

任务写入使用 request ID/receipt 防止“文件已写、关联未提交”；Markdown 写入成功而 Operational Store 提交失败进入 recoverable state；Operational Store 丢失时只重建可证实部分，不凭标题猜测伪造关联。[TASK §9]

## R-TK-09 界面入口固定

Tasks 采用“统一日程列表 + 任务详情”布局（今天/即将到期/全部/已完成 + 项目/来源/责任人筛选）；Workbench 只放今日摘要与快速创建；Agent Panel 只显示当前关联任务，不塞完整任务管理。[TASK §7] [WD §16.1]

## R-TK-10 V1 边界

V1 不做系统日历双向同步、多人分派/审批/甘特、独立任务云数据库，也不承诺完整兼容任意 Obsidian Tasks/Dataview 查询语言；具体语法映射由 MD-08 往返 fixture 锁定后才可宣称兼容。[TASK §10] [TASK-06]
