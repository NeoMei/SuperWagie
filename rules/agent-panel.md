# 规则包：Agent 面板与注意力（agent-panel）

适用范围：Agent 面板、Composer、会话状态显示、通知、任务线程执行与恢复。改动这些区域前逐条核对；与本文冲突时以锚点指向的权威规格为准。

## R-AP-01 Composer 是唯一交互入口

Agent 面板的对话输入与开始/停止执行统一收敛在底部 Composer；开始与停止使用播放/停止图标语义，不堆砌文字大按钮，也不另设第二套执行入口。[WD §19.1] [WD §24]

## R-AP-02 会话 Credits 固定行

Composer 下方固定弱化显示“本次会话已消耗 N Credits”；只累计当前 Agent Task Thread 内已结算消费，待结算显示“处理中”；点击明细只见能力类别、时间、Credits 与状态，不见模型、Provider、Token 或内部成本。[ACC §9] [WD §19.1]

## R-AP-03 Working Set 与 Lease 先行

Agent 执行写入前必须持有 Working Set Lease（revision、内容哈希、CAS）；面板展示的执行范围必须与 Lease 范围一致；未持 Lease 的写动作不得出现在面板中。[WD §19.2] [WF-02] [WF-04]

## R-AP-04 三种 Gate 机制不可混用

确认机制严格分为 Workflow Gate、Risk Gate、Install Gate。Risk Gate 只处理 scope_expansion、external_effect、destructive、high_cost_billing 四种风险；按钮描述真实动作，禁止独立大块费用页、阻断式通用确认弹窗和每轮消费确认。[WD §22.2] [ACC §9]

## R-AP-05 完整生命周期与六类投影分离

Agent Task Thread 持久状态严格采用 CAC §6.1 的完整生命周期；WD §22.3 的六项只是用户可见的注意/结果投影，不得覆盖 ready、running、archived 等持久状态，也不得把 Thread 状态混入 Task Item 状态。[WD §22.3] [CAC §6.1] [WF-10]

## R-AP-06 通知只有四种

注意力通知只保留 WD §19.3 定义的四种类型并按其分级展示；不得自造第五类通知，也不得用模态弹窗替代行内通知。[WD §19.3]

## R-AP-07 检查点恢复不重复计费

断网、失败、余额不足等中断必须停在安全 Checkpoint。已有可信 receipt 的 effect 不得重放；`execution_unknown` 必须先 reconcile；能证明尚未开始的 effect 才可按原 request_id 继续。恢复入口在面板固定位置始终可达。[WD §22.3] [CAC §6.3] [WF-02] [WF-10]

## R-AP-08 任务与执行状态分离

面板显示当前关联 Task Item；credits_blocked、disconnected、recoverable_failed 等只是 Thread 运行状态投影，不写回任务状态枚举；停止 Thread 不隐式修改 Task Item。[TASK §2] [TASK §6] [TASK-05]
