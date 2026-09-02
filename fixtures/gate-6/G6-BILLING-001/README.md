# G6-BILLING-001 — 个人/企业 Credits 账本

必须在真实测试服务中覆盖个人钱包、企业钱包、Owner/Billing Admin/Admin/Member、
充值回调签名、reserve/execute/settle/refund、并发、重放、断网、取消与超时。

客户端显示、Agent session 累计消耗和官网账本必须最终一致；任何串钱包、重复入账、
重复扣费或仅凭浏览器回跳增额都直接失败。当前没有可接受的 Billing Sandbox，stub
只能验证接口形状，不能成为门禁证据，因此状态固定为 `BLOCKED_ENVIRONMENT`。

