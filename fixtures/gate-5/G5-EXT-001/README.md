# G5-EXT-001 — 用户扩展生命周期与隔离

- Owner role: Extension/Security
- 平台: macos-15-arm64（本轮）
- 证据修订: `solution-b-v1`
- 执行器: scripts/poc/gate-5/ext-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-5 --fixture G5-EXT-001 --platform macos-15-arm64
- 状态: stub 生命周期合同通过；真实签名 Installer/Extension Worker、OS 沙箱、网络代理和双平台恢复未执行，因此最多 `CONDITIONAL_GO`

## 固定输入

执行器在临时目录构建 stub 扩展注册表与扩展沙箱：两个 Skill 清单、一个 MCP 清单、一个恶意构建脚本扩展、版本仓库与 quarantine 区。

## 阈值

- Skill/MCP 按清单正确识别类型、来源、版本
- 未授予权限的能力调用被拒绝，授予权限后放行
- 安装 v1.0.0 → 更新 v1.1.0 → 回滚 v1.0.0，内容字节级一致
- 停用的扩展调用被拒绝；重新启用后恢复
- 恶意构建脚本扩展被 quarantine，quarantine 中不可执行，可被移除
- 移除后文件与注册表条目删除，调用被拒绝

## 证据

results.json checks 与 artifacts/ext-registry.json。该证据不能替代真实签名 Worker 的进程/文件/网络隔离与恢复证据。
