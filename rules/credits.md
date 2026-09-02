# 规则包：Credits、钱包与消费确认（credits）

适用范围：账户/钱包投影、消费确认、余额提示、充值返回、计费隐私边界。

## R-CR-01 用户不可见的模型层

客户端任何界面不出现 Token、具体模型、Provider、Base URL、API Key 或原始供应商成本；Credits 是唯一消费单位。[ACC §2] [BILL-01]

## R-CR-02 reserve → settle 语义

常规能力自动预留与结算；高成本阶段（批量图片、完整 PPT、视频素材、完整合成等）必须先在对话中展示“预计增加约 N–M Credits”并取得 `high_cost_billing` Risk Gate；禁止独立大块费用页、阻断式通用确认弹窗和每轮消费确认。[ACC §9] [WD §22.2] [BILL-02]

## R-CR-03 Session Credits 固定行

Composer 下方固定弱化显示“本次会话已消耗 N Credits”，严格对应 task_thread_id：只累计已结算消费，待结算显示“处理中”，跨页面、关闭与恢复继续累计，新建线程才归零。[ACC §9] [WD §19.1] [WD §24]

## R-CR-04 项目绑定消费主体

每个 Project 绑定一个 Wallet（Personal 或 Organization），Thread、Delivery、Workflow 只继承绑定；钱包不足或权限失效时不自动切换钱包、不拆分结算；改绑只影响后续新预留。[ACC §2] [ACC §5.1] [BILL-01]

## R-CR-05 绑定失效行为

绑定失效后：停止新建 Reservation；进行中的原子步骤按可信回执结算；多余预留释放；线程在下一个安全 Checkpoint 进入 credits_blocked；不得静默改扣 Personal Wallet。[ACC §5.2] [WF-10]

## R-CR-06 余额状态四态投影

余额状态 normal / low / critical / blocked 由服务端投影，客户端不硬编码阈值数值；normal 不提示余额，low 弱提示，critical 在执行前提示，blocked 在 Checkpoint 暂停。[ACC §10.1]

## R-CR-07 充值返回不依赖单通道

充值完成后官网展示到账状态、可 Deep Link 返回客户端，但客户端必须主动刷新服务端状态；Wallet 恢复后原 credits_blocked 线程提示用户继续，不自动恢复未再次确认的高成本执行。[ACC §10.3] [BILL-03]

## R-CR-08 计费权与内容权分离

Credits 账本与企业视图只保留成员、计费标签、能力类别、Credits、时间、结算状态；本地路径、文件名、Prompt、Working Set、源内容、Artifact 与内部模型路由不得进入账本或财务视图。[ACC §11.2]

## R-CR-09 扩展同规

用户 Skill / MCP 经 Public Capability Facade 使用能力，与官方能力同受 Project Binding、Session Credits、Checkpoint 约束；ClientIntent 不能携带 wallet、billing reservation、risk 或 gate receipt，这些上下文由 Trusted Gateway 注入；扩展不能指定他人支付主体、自签 Usage Receipt、自行扣费或绕过高成本确认。封闭 Agent Runtime 不影响其调用已授权能力。[ACC §11.3] [SEC-10]

## R-CR-10 未知结果不重放

回执未知进入 settlement_unknown，保留预留并核实原 effect；核实前禁止盲目重放同一高成本操作；recoverable_failed 不得通过删除 Reservation 结束，必须保留运行与账务证据。[ACC §8.6] [BILL-02]
