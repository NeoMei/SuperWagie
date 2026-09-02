# G5-CONNECTOR-001 — AgentWiki Connector 授权与同步（外部依赖）

- Owner role: Connector/Security
- 平台: macos-15-arm64
- 状态: BLOCKED_ENVIRONMENT —— 需要真实 AgentWiki 服务授权，不能用 stub 代替

## 为什么不能 stub

授权流、真实 Pull/Push、preview/confirm、断网恢复、冲突与部分成功都以真实服务端状态为准。按项目约定，只读探针与真实认证 Pull/Push 必须区分，stub 无法产生可签署的证据。

## 前置条件

1. 可访问的 AgentWiki 实例与测试 Space；
2. 用户完成真实授权（连接授权 + 凭证授权一条流）；
3. 测试用项目记忆与团队共享记忆空间。

## 手动验证步骤

1. 在设置内发起 AgentWiki 授权，完成真实 OAuth/凭证流；
2. 对测试项目执行 Pull，校验 preview → confirm 两步与本地落盘；
3. 修改本地记忆后 Push，校验服务端内容与审计；
4. Push 中断网，恢复后重试，验证幂等（无重复条目）；
5. 制造远端并发修改，验证冲突报告与部分成功语义；
6. 记录全部请求/响应证据后运行门禁签署。
