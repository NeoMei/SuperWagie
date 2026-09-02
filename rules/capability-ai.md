# 规则包：Managed AI 与能力产品化（capability-ai）

适用范围：官方与用户 Skill 的模型访问、两阶段能力发布、Capability Contract、私有化封装与版本治理。

## R-CA-01 Managed AI 统一接口

官方 Skill 与用户 Skill 通过同一 Managed AI Runtime 获得模型能力：统一鉴权、流式协议、取消、重试和超时语义；所有调用由 Rust Product Core 的 Platform Service Client 进入官方端点，不借用 Connector 或 Extension Network Broker；不存在官方专享模型通道或用户降级通道。[V1RS §2] [BCRA §11] [AI-01]

## R-CA-02 模型与 Key 对用户不可见

用户界面与扩展 API 不暴露 Provider、模型名和 API Key；上层只声明 profile 等意图，路由、版本与回执由平台内部管理；Provider Key 只存服务端并经 Credential Broker 轮换与撤销，客户端只持有短期令牌。[AI-02] [AI-04]

## R-CA-03 类型化能力面

chat、reason、vision、OCR、image 等能力以类型化接口提供：输入输出 Schema、Artifact 上传与多模态流是接口契约的一部分，不允许裸文本旁路。[AI-03]

## R-CA-04 统一计量与回执

模型、图像、搜索与计算消费统一映射为 Credits；每次调用产生 Usage Receipt 并进入 Reservation → Settlement 账本；回执不含模型、Provider、Token 或内部成本。[AI-05] [ACC §9]

## R-CA-05 第一阶段 Reference 优先

第一阶段用传统 Skill、MCP、脚本与模板形态在 Dev Host 中调试内置能力；从第一天起必须遵守最终 Capability Contract、文件边界、AI Gateway、凭证、阶段、确认、恢复和计量要求，避免第二阶段重新设计。[WD §10.1] [SK-01]

## R-CA-06 Capability Contract 机器可校验

每个能力进入 Reference 实现前必须拥有 Manifest：identity、schemas、execution、security、dependencies、artifacts、durability、billing、acceptance、compatibility 十组必填项；上层只按 capability_id + version + schema 调用，不得把文件路径、MCP 配置、crate 名或 COM 对象当业务 API。[CAC §9] [SK-02]

## R-CA-07 冻结候选七要素

进入产品化前冻结 Capability Candidate：source_commit、capability_version、contract_version、dependency_lock、evaluation_suite、golden_artifacts、acceptance_report，缺一不可。[WD §10.1] [SK-04]

## R-CA-08 生产包与签名

生产安装包不附带可复制的 SKILL.md、内部 Prompt、MCP 配置、开发脚本目录和测试夹具；私有能力以签名 Capability Package 分发，覆盖完整性、加密、密钥、加载、升级和回滚。[WD §10.2] [SK-05]

## R-CA-09 等价回归闸门

Private Capability 与 Reference Capability 执行相同回归：比较阶段、人工门、文件修改、中间 Artifact、最终结果、错误恢复、权限和 Credits；使用差分 runner 与 golden artifact，非确定性给容差；行为不一致时阻止产品发版。[WD §10.2] [WD §12] [SK-06]

## R-CA-10 版本三元独立

能力版本、私有制品版本与 SuperWagie 客户端版本分别记录与升级；发布清单固定包含的能力版本与兼容契约，支持精确定位与回滚；Skill Compiler 决定哪些内容转 IR、编译、封装或保留 Worker，依据是等价性而非语言偏好。[WD §10.2] [WD §13.6] [SK-03] [SK-07]
