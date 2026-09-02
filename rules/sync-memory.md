# 规则包：Connector 同步与项目记忆（sync-memory）

适用范围：AgentWiki Connector、知识库同步、项目记忆共享、SessionReviewer 连续性、Agent Profile 与 Safe Memory。

## R-SM-01 官方唯一 Connector

V1 只有官方 AgentWiki Connector；契约按可扩展设计但不开放第三方接入，第三方服务需求由用户 MCP 扩展承接；Connector Plane 与 User Extension Plane 分离。[CONN §3.1] [CON-01]

## R-SM-02 两层管理模型

实例级管理（添加、授权、撤销 AgentWiki 实例、查看 Space 与角色、删除连接）只在设置内完成；项目级绑定在项目内选择一个已授权 Space 并确认目标目录；一个项目同时只绑定一个 Space；工作面板不做连接管理。[CONN §3.2]

## R-SM-03 授权与凭证边界

授权走系统浏览器 + Deep Link 回跳换取 token；凭证只进 OS Secret Vault，客户端界面永不可见；自托管实例先填地址再走同一流程；凭证过期、撤销与按设备管理沿用官网登录机制。[CONN §3.3]

## R-SM-04 手动同步与预览确认

Pull 与 Push 均由用户显式发起，先展示新增、修改、冲突、删除变更清单再确认执行；无后台静默知识同步、无保存即推；同步状态常驻可见；Agent 可建议同步但执行同样走预览确认。[CONN §4.2] [CON-02]

## R-SM-05 冲突分级处理

无重叠改动 diff3 自动合并并在预览中标注；重叠冲突三选一：采用本地（远程存副本）、采用远程（本地存副本）或双栏手动合并；冲突文件挂起不阻塞同批其他文件；解决前本地内容绝不覆盖。[CONN §4.3] [CON-02]

## R-SM-06 三个独立边界

本地文件授权、Push 预览确认与 AgentWiki 服务端 ChangeSet 审核互相独立，任何一次同步不得用一次笼统确认互相替代。[CONN §4.4] [CON-03]

## R-SM-07 生命周期不伤数据

离线或凭证失效时本地照常可用，同步冻结并明确提示原因；重新授权后原地继续；解绑 Space 或删除连接时已拉取文件与本地加工内容原地保留、降级为不再同步的普通文件，删除连接同时从 Secret Vault 清除该实例凭证。[CONN §6.1] [CONN §6.2]

## R-SM-08 记忆共享角色与落点

AgentWiki 集成承担知识库同步与项目记忆共享双重角色；共享的是人可读的项目记忆层，不是记忆本体数据库；Pull 内容以真实 Markdown 落在项目专用同步目录，全量参与编辑、链接、搜索与 Agent 加工。[CONN §4.1] [CONN §5.1]

## R-SM-09 私有区与共享区

连续性产物自动同步到用户个人私有区（仅本人可见、备份语义、无需逐次确认）；向团队共享记忆空间写入走 Push 预览确认；共享记忆条目按条目级幂等同步，不做文本合并。[CONN §5.2] [CONN §5.3]

## R-SM-10 永不上传边界

Safe Memory 本体库、User Profile、未显式共享的记忆条目永不上传；密码、密钥、支付、健康类内容永不进入任何同步路径；共享只是显式勾选的副本，撤回后本地内容不受影响。[CONN §5.4]

## R-SM-11 SessionReviewer 事件边界

SessionReviewer 只消费 SuperWagie 自身 Agent Runtime 的结构化事件，不扫描宿主 Codex/Agent 会话数据；事件 schema、cursor、proposal/apply 遵循 evidence boundary。[CTX §5.1] [CT-01]

## R-SM-12 连续性产物形态

项目回顾.md 与 项目历史.md 是项目内普通 Markdown，遵守 Workspace 事务写入与外部编辑恢复规则；任务线程收尾后异步更新，产物对用户完全可见且可回滚；隐藏 ledger 只存技术核算数据，不形成第二套语义真相。[CTX §5.2] [CTX §5.3] [CT-02]

## R-SM-13 Profile 显式与 scope 限制

Profile 由用户显式编写，Agent 可建议但必须确认后生效；编辑入口在头像菜单独立面板，不进入设置页；V1 记忆 scope 只开放 User 与 Project，Organization 与 Agent 仅数据模型预留，不提供 UI、API 和注入路径。[CTX §3.1] [CTX §3.2] [CTX §4.2] [MEM-01]

## R-SM-14 记忆写入与注入

记忆写入默认人在环（行内记忆卡片确认），仅低敏类别可获本项目自动保存授权且可随时撤销；敏感类别永不自动保存、逐条显式确认；注入采用有界三层（Profile 全量 + Project 全量 + User Top-N 不超过 20 条），全部按不可信上下文处理并全程审计；记忆归个人，官方服务端零记忆，跨设备与团队共享只走 Connector 路径。[CTX §2] [CTX §4.1] [CTX §4.3] [CTX §4.4] [CTX §6] [MEM-02] [MEM-03]

