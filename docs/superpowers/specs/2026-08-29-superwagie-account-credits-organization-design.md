# 超级牛马（SuperWagie）账户、Credits 与企业组织设计

> 状态：产品与架构设计已确认；技术验证和生产准入未完成  
> 日期：2026-08-29  
> 上位产品基线：`docs/最早期产品方案-V0.1.md`  
> V1 范围基线：`docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md`  
> 领域语言：`CONTEXT.md`  
> 编码准入：`docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md`

## 1. 目的与权威边界

本文定义 SuperWagie V1 的账户、个人与企业 Credits、项目消费主体、充值、预留、结算、退款、客户端投影和企业基础治理。它是这些产品语义的唯一权威规格；技术调查可以补充支付渠道、并发方案和部署细节，但不得改写本文确认的用户边界。

本文不代表 Billing 系统已通过技术验证，也不解除 Gate 6。生产实现仍须通过技术要求矩阵、合同测试、并发测试、故障注入和真实支付渠道沙箱验收。

## 2. 已确认的产品原则

1. 官网负责 `Identity / Money / Organization`，桌面客户端负责 `Work`。
2. Credits 是统一消费单位，用户不见 Token、具体模型、Provider、Base URL、API Key 或原始供应商成本。
3. 每个 Project 绑定一个消费主体：Personal Wallet 或一个已授权的 Organization Wallet。
4. Project 内的 Agent Task Thread、Delivery Project 和 Workflow Run 默认继承该绑定。
5. 项目改绑只影响后续新预留；已有预留和历史账目不迁移、不改写。
6. 钱包不足或权限失效时绝不自动切换钱包，也不拆分为多个钱包结算。
7. 企业 Credits 使用共享 Organization Wallet；V1 只做基础角色、成员消费授权和用量归集。
8. 企业支付权与项目内容权完全分离。企业付费不授予对本地项目内容的远程读取权。
9. 常规 Agent 使用自动结算；高成本制作阶段使用正常对话中的预计增量和 `high_cost_billing` Risk Gate。
10. V1 只销售按需充值 Credits；购买 Credits 默认不设产品级到期日，赠送或补偿批次可以有明确有效期。
11. Personal Wallet 与 Organization Wallet 之间不允许用户自行转账。
12. 钱包余额和账务事实只存在于官方服务端权威账本；客户端只保存可刷新的短期投影。

## 3. 系统边界

### 3.1 Identity & Entitlement

负责用户身份、设备登录、组织成员身份和产品权益。客户端通过系统浏览器打开官网完成注册、登录、企业 SSO 或多因素认证，再以一次性授权码和 Deep Link 返回客户端。

客户端不收集密码、验证码和支付信息。Access Token 短期有效，Refresh Token 只进入操作系统安全存储并可从官网按设备撤销。

### 3.2 Organization Service

负责 Organization、Membership、固定角色、邀请、移除和成员消费权限。它不直接维护余额，不因成员角色变化修改历史账务。

### 3.3 Payment Orchestrator

负责个人和企业订单、支付渠道、对公付款确认、退款和发票状态。支付成功只产生经过签名验证且幂等的 Credits 入账命令；创建订单、客户端回调或浏览器跳转本身不能增加余额。

### 3.4 Credits Ledger

负责 Wallet、Credit Lot、不可变 Ledger Entry 和余额投影，是 Credits 的唯一财务真相。任何服务和人工操作都不能直接覆盖余额字段；纠错通过反向流水或补偿流水完成。

### 3.5 Reservation & Settlement

负责读取项目绑定、验证消费权限、原子预留、接收可信 Usage Receipt、实际结算和释放差额。它不能根据客户端或用户扩展自报的用量扣费。

### 3.6 Billing Projection & Notification

向官网提供余额、订单、退款、发票和消费历史；向客户端提供项目消费主体、Session Credits、余额状态和阻塞恢复入口。投影可以重建，不能反向改写账本。

## 4. 核心对象与稳定身份

| 对象 | 稳定身份 | 核心责任 |
|---|---|---|
| User | `user_id` | 官方账户主体 |
| Organization | `organization_id` | 企业支付和成员治理主体 |
| Membership | `membership_id` | 用户在组织中的角色、状态和消费授权 |
| Wallet | `wallet_id` | Personal 或 Organization Credits 容器 |
| Credit Lot | `credit_lot_id` | 一笔充值、赠送或补偿形成的额度批次 |
| Ledger Transaction | `ledger_transaction_id` | 一组内部平衡且不可变的账本流水 |
| Ledger Entry | `ledger_entry_id` | 钱包可用、预留、消费、退款等科目变化 |
| Project Billing Binding | `project_billing_binding_id` | Project 当前支付主体及版本 |
| Billing Reservation | `billing_reservation_id` | 某执行阶段的预计上限和占用额度 |
| Usage Receipt | `usage_receipt_id` | 受信能力已实际发生的可结算用量 |
| Settlement | `settlement_id` | Reservation 的最终实际消费和释放结果 |
| Payment Order | `payment_order_id` | 支付主体、渠道、金额、币种和支付状态 |

一个 User 始终有一个 Personal Wallet，可以拥有或加入多个 Organization。一个 Organization 在 V1 只有一个共享 Organization Wallet。

`Project Billing Binding` 只允许包含 `project_id`、用户设置的计费标签、`wallet_id`、绑定版本、创建者和时间。它不得包含本地路径、文件名、Prompt、文档或 Artifact 内容。

## 5. 项目消费主体

### 5.1 绑定规则

- Project 创建时绑定一个 Wallet；只有一个可用 Wallet 时客户端不显示选择步骤。
- 有多个可用 Wallet 时，创建项目显示紧凑的“费用由”选择项。
- 绑定 Organization Wallet 必须同时满足有效 Membership 和已启用消费权限。
- Agent Task Thread、Delivery Project 和 Workflow Run 不自行选择 Wallet，只继承 Project Binding。
- 创建 Reservation 时冻结 `wallet_id + project_billing_binding_version`。
- 项目改绑只影响改绑后创建的新 Reservation。
- 不允许一个 Reservation、一个原子能力调用或一个 Settlement 跨钱包拆分。

### 5.2 绑定失效

余额不足、成员退出组织、成员被移除或消费权限被停用时：

1. 不再创建新 Reservation；
2. 正在执行的原子步骤完成并按可信回执结算；
3. 不再需要的剩余预留被释放；
4. Agent Task Thread 在下一个安全 Checkpoint 进入 `credits_blocked`；
5. 用户可以充值、等待管理员处理，或明确改绑另一个有权限的钱包后继续。

系统不得静默改扣 Personal Wallet，不得把同一执行拆成企业和个人两笔消费。

## 6. 企业角色与基础治理

V1 使用四种固定角色，不提供自定义角色。

| 能力 | Owner | Billing Admin | Admin | Member |
|---|---:|---:|---:|---:|
| 管理组织所有权 | 是 | 否 | 否 | 否 |
| 充值、订单、退款与发票 | 是 | 是 | 否 | 否 |
| 查看完整余额和财务流水 | 是 | 是 | 否 | 否 |
| 邀请、移除成员及分配角色 | 是 | 否 | 是 | 否 |
| 开启或停用成员消费权限 | 是 | 否 | 是 | 否 |
| 查看按成员和项目归集的用量 | 是 | 是 | 是 | 仅本人 |
| 使用 Organization Wallet | 按消费权限 | 按消费权限 | 按消费权限 | 按消费权限 |

补充约束：

- Member 只看到 Organization Wallet 的“可用、余额较低、暂不可用”状态和本人消费记录，不看到准确余额。
- Admin 可以查看用量以管理成员，但看不到支付方式、订单、退款和发票。
- Owner 和 Billing Admin 可以查看完整财务信息，但不能因此读取项目内容。
- 组织仍有余额、未完成 Reservation 或待处理退款时不能直接删除；关闭必须进入受控清算流程。
- 用户离开组织后，本地 Project 和内容不被删除或转移，只有组织计费绑定失效。

## 7. Credits 账本与批次

### 7.1 余额语义

每个 Wallet 对外形成以下投影：

```text
total balance
├── available credits
└── reserved credits
```

正常业务不能产生用户欠款或负可用余额。并发 Reservation 必须在服务端原子检查和占用余额。

### 7.2 账本事件

V1 至少支持：

| 事件 | 含义 |
|---|---|
| `purchase_credit` | 充值确认后入账 |
| `promotional_credit` | 赠送或活动额度入账 |
| `compensation_credit` | 客服补偿入账 |
| `reserve_hold` | 从可用额度转为预留额度 |
| `settlement_debit` | 按可信用量实际消费 |
| `reserve_release` | 释放未使用预留 |
| `payment_refund` | 原支付渠道退款并冲销未消费额度 |
| `lot_expiry` | 明确设有有效期的赠送或补偿批次失效 |
| `manual_correction` | 有操作者、原因和关联对象的人工纠错 |

每个 Ledger Transaction 必须内部平衡。历史流水不可更新或删除；修正只能追加新流水。

### 7.3 Credit Lot

- 每次购买、赠送和补偿形成独立 Credit Lot。
- 购买 Credits 默认不设产品级到期日。
- 赠送或补偿 Credits 可以设置有效期，入账时必须向用户明确展示；没有明确有效期时不得事后追加。
- 消费优先使用即将到期的批次，其后按最早入账顺序使用。
- Reservation 必须记录其占用的批次分配，以支持正确释放和退款。
- 赠送与补偿额度不可退款。
- 支付退款只能冲销对应订单仍未消费、未被预留的购买 Credits。
- Personal Wallet 和 Organization Wallet 之间不能转账或合并批次。
- 人工纠错必须记录操作者、原因、时间和关联订单或执行，不允许直接修改数据库余额。

## 8. Reservation、Usage Receipt 与 Settlement

### 8.1 标准流程

```text
读取项目绑定及版本
→ 校验身份、成员状态和消费权限
→ 估算当前执行阶段 Credits 上限
→ 必要时取得 high_cost_billing Risk Gate
→ 使用幂等键创建 Reservation
→ 执行受信能力并收集 Usage Receipt
→ 按实际用量 Settlement
→ 释放剩余预留
→ 更新 Session Credits 投影
```

### 8.2 状态机

```text
reserve_requested → reserved → executing → settlement_pending → settled
reserve_requested → rejected
reserved → expired
reserved | executing → refund_pending → refunded
settlement_pending → settlement_unknown
settlement_unknown → settled | refunded | recoverable_failed
```

### 8.3 幂等与并发

- Reservation 绑定 `wallet_id + project_billing_binding_version + task_thread_id + workflow_run_id + stage_id + idempotency_key`。
- 同一幂等键重试返回原结果，不能创建第二笔预留。
- 支付回调、退款回调、Usage Receipt 和 Settlement 都必须独立幂等。
- 尚未执行的 Reservation 可以按服务端 TTL 过期释放。
- 已进入 `executing` 的 Reservation 不能因客户端计时器或断线直接释放。
- Project 改绑不改变已有 Reservation。

### 8.4 估算与追加预留

- Reservation 是当前阶段的预计上限，不是最终收费。
- 后续阶段需要更多 Credits 时，必须先追加预留再开始新的高成本外部操作。
- 无法追加时在安全 Checkpoint 进入 `credits_blocked`。
- 可信 Usage Receipt 的实际消费小于预留时释放差额。
- 平台或供应商造成的不可预测小额超出不能转为用户欠款；超出已授权预留的部分由平台承担或进入内部异常处理。

### 8.5 Usage Receipt

Usage Receipt 只能由 Model Gateway、受信图片/音频/视频服务、Official Host 或 Trusted Host Adapter 等已登记执行端签发，并至少绑定：

- 唯一 `usage_receipt_id` 和 effect ID；
- Reservation、Capability、Workflow Run 和 Stage；
- 能力类别和实际用量；
- Credits 映射版本；
- 结果或 Artifact 引用；
- 发生时间、签发者和完整性证明。

客户端、Skill、MCP 和普通脚本不能签发可结算回执。

### 8.6 停止、失败与未知结果

- 用户停止或任务失败时先停止后续副作用，再结算已发生的可信用量并释放余额。
- 外部效果可能成功但回执未知时进入 `settlement_unknown`，保留预留并查询原 effect。
- 在未知结果被核实前，不允许盲目重放同一高成本操作。
- `recoverable_failed` 不能通过删除 Reservation 结束；必须保留运行和账务证据供恢复或人工处置。

## 9. 消费确认与 Session Credits

绑定 Wallet 后，普通对话、搜索和常规编辑可以自动预留和结算。图片批量生成、完整 PPT、视频素材生产、完整视频合成等高成本阶段必须在正常 Agent 回复中展示“预计增加约 N–M Credits”，并通过行内继续动作取得结构化 `high_cost_billing` Risk Gate。

不得使用独立大块费用页面、阻断式通用确认弹窗或每轮消费确认。

客户端 Composer 下方固定弱化显示：

```text
本次会话已消耗 N Credits
```

其中“本次会话”严格对应当前 `task_thread_id`，不是应用启动会话：

- 只累计已结算的实际消费；
- 待结算金额显示“处理中”，不提前计入已消耗；
- 跨页面、交付阶段、客户端关闭和恢复后继续累计；
- 新建 Agent Task Thread 才从零开始；
- 点击明细只显示能力类别、时间、Credits 和状态，不显示模型、Provider、Token 或内部成本。

## 10. 客户端与官网体验

### 10.1 客户端

- 账户与 Credits 位于头像菜单，不增加客户端主导航。
- 头像菜单提供账户状态、当前消费主体、管理 Credits、消费记录和退出登录。
- 只有一个可用 Wallet 时不显示支付主体选择器。
- 多个 Wallet 时，在创建 Project 使用紧凑选择项；创建后从 Project 设置改绑。
- 存在执行中 Reservation 时，改绑提示“仅影响后续消费”。
- 正常余额不展示；低余额或阻塞时才增强提示并提供官网充值入口。

余额状态由服务端投影，不由客户端硬编码固定 Credits 数：

| 状态 | 客户端行为 |
|---|---|
| `normal` | 不提示余额 |
| `low` | 弱提示并提供充值入口 |
| `critical` | 下一阶段可能无法完整预留，执行前提示 |
| `blocked` | 无法预留，在 Checkpoint 暂停 |

### 10.2 官网

未登录区域保持：产品介绍、价格说明、下载和登录。

个人登录后提供：

- Credits；
- 使用记录；
- 订单与退款；
- 发票；
- 账户与设备。

组织区域提供：

- 概览；
- 成员；
- Credits；
- 使用归集；
- 订单与发票。

个人支持在线充值。企业支持在线充值，以及大额采购所需的订单、对公付款确认和发票状态。只有支付渠道或授权财务人员确认到账后才增加 Credits。

### 10.3 充值返回客户端

客户端打开官网时只携带短期、一次性跳转上下文，不携带支付凭证。充值完成后：

1. 官网显示确认后的到账状态；
2. 官网可以通过 Deep Link 返回客户端；
3. 客户端同时主动刷新服务端状态，不能只依赖 Deep Link；
4. Wallet 恢复可用后，原 `credits_blocked` 线程提示用户继续；
5. 系统不得在后台自动恢复尚未再次确认的高成本执行。

## 11. 安全、隐私与用户扩展

### 11.1 凭证与支付安全

- Skill、MCP、脚本、子进程和 Workspace 文件拿不到账户凭据、钱包 ID、支付信息或官方 Gateway Key。
- 支付回调必须验证渠道签名、支付主体、金额、币种和幂等键。
- 财务管理操作必须记录 actor、role、request ID、时间和结果。
- 设备撤销、Membership 撤销和消费权限变化必须及时使后续新预留失效。

### 11.2 计费权与内容权分离

企业用量记录只保留完成财务归集所必需的：成员、项目计费标签、能力类别、Credits、时间和结算状态。

以下内容不得进入 Credits 账本或企业财务视图：

- 本地绝对路径和文件名；
- Prompt、对话和 Working Set；
- Markdown、Office、图片、视频和其他源内容；
- Artifact 内容、预览和批注；
- Private Workflow 实现和内部模型路由。

完整企业内容治理必须作为新的产品能力另行设计，不能从支付关系推导权限。

### 11.3 用户 Skill 与 MCP

用户扩展通过 Public Capability Facade 使用系统能力：

```text
User Extension
→ Public Capability Facade
→ 权限与 Project Context
→ Billing Policy / high_cost_billing Risk Gate
→ Reservation
→ Trusted Capability
→ Usage Receipt / Settlement
```

用户扩展不需要知道 Wallet、模型和 Credits 映射，不能指定其他支付主体、签发 Usage Receipt、自行扣费或绕过高成本确认。它与官方能力使用相同的 Project Binding、Session Credits、Checkpoint 和恢复机制。

封闭 Agent Runtime 因此不影响用户扩展调用已授权的系统能力，只阻止其越权读取或修改账户与账务系统。

## 12. 异常处理

| 异常 | 权威行为 |
|---|---|
| 支付处理中 | 不提前入账，官网显示处理中 |
| 支付回调重复 | 返回原订单结果，不重复入账 |
| 余额不足或权限失效 | 写入 Checkpoint，进入 `credits_blocked` |
| 客户端断网 | 本地无计费编辑可继续；新的云端计费能力暂停 |
| Usage Receipt 延迟 | 保留预留，显示结算中 |
| 外部效果未知 | 查询原 effect，禁止直接重做 |
| 用户停止任务 | 结算已发生用量，释放其余预留 |
| 退款处理中 | 冻结对应可退款批次，完成后冲销 |
| 服务端账本异常 | 停止相关新预留，保护已有内容，不用客户端缓存猜测余额 |

任何异常都必须给出下一步动作和可恢复状态，不能只显示错误码、永久 spinner 或不可关闭弹窗。

## 13. V1 范围

### 13.1 V1 Required

- 官网浏览器登录与客户端安全授权；
- Personal Wallet 和 Organization Wallet；
- Owner、Billing Admin、Admin、Member；
- 组织成员消费授权及停用；
- Project 级支付主体绑定；
- 购买、赠送和补偿 Credit Lot；
- `reserve → execute → settle → release/refund`；
- Session Credits、低余额和阻塞恢复；
- 个人在线充值；
- 企业在线充值、对公订单及发票状态；
- 按成员和项目计费标签归集；
- 用户 Skill/MCP 经公开系统能力正常消费；
- 支付、执行和结算全链路幂等。

### 13.2 Deferred

- 订阅套餐；
- Wallet 之间转账；
- 部门和成本中心；
- 成员月度额度及结转；
- 多级预算审批；
- 企业远程查看项目内容；
- 自定义组织角色；
- 自动从 Organization Wallet 切换至 Personal Wallet；
- Credits 交易、赠送或提现。

实际支付渠道、结算币种和税务接入由目标市场的技术验证决定，但不能改变本文的 Credits、Wallet、权限和账本契约。

## 14. 验收与生产准入

上线前必须证明：

1. 个人完成登录、充值、客户端自动刷新、执行任务和查看记录；
2. 企业完成创建组织、邀请成员、授权消费、Project 绑定和财务归集；
3. 至少 100 个并发 Reservation 不能透支同一 Wallet；
4. 重放支付回调、执行请求和 Usage Receipt 不重复入账或扣费；
5. Agent 崩溃、客户端退出、断网和恢复不产生第二份外部结果；
6. 停止、失败和取消只结算已经发生的实际用量；
7. 成员权限被撤销后，新消费停止，已有原子步骤正确收尾；
8. Project 改绑只影响后续 Reservation；
9. 退款只冲销对应订单尚未消费且未被预留的 Credits；
10. 用户扩展能调用系统能力，但无法读取 Wallet、伪造回执或绕过确认；
11. 企业账单中不存在路径、Prompt、文档或 Artifact 内容；
12. Ledger、Credit Lot、Reservation、Settlement 和余额投影可自动对账。

验证层必须包含：

- 账本不变量和属性测试；
- Billing Contract 和状态机测试；
- 支付渠道沙箱与回调重放；
- 并发 Reservation 和 Settlement；
- 崩溃、断网、超时和未知结果故障注入；
- 官网—客户端—Gateway 端到端测试；
- 用户扩展等价能力与越权攻击测试；
- 每日自动对账和异常告警演练。

出现账本不平、长时间 `settlement_unknown`、投影延迟或异常回调重放时，系统必须告警并停止相关新预留，不能带病继续扣费。

本文通过产品设计确认后，只允许启动对应 Contract Foundation 和 Gate 6 技术验证；在全部验收证据完成前，不得把账户与 Credits 标记为生产可用。
