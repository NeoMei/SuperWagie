# SuperWagie Windows 11 x64 验证交接清单

> 生成日期：2026-09-03
> 用途：让 Windows 11 x64 侧按本清单补齐 `windows-11-x64` 平台验证，提交回代码后即可关闭剩余平台阻塞。
> 权威状态：`docs/技术可行性/当前技术验证状态.json`（当前 31 expected / 11 GO / 12 CONDITIONAL_GO / 0 NO_GO / 8 BLOCKED_ENVIRONMENT / 0 signed_go，Production Admission = NO_GO）。

## 0. 结论先行

当前 mac 侧已把「能在 mac 上验证的」全部跑绿；剩下 20 个权威 fixture 仍缺 `windows-11-x64` 平台证据。其中：

- **纯平台重跑**（Windows 上直接可跑，跑完即补上该平台证据）：G1 全部、G0-ISOLATION、G0-DEPS、G5-EXT、G5-ATTACK、G4-VIDEO-001..005。
- **需要额外外部条件**（Windows 单机关不掉，见 §4）：G0-SHELL-002、G6-PACKAGE-001（签名/公证）、G3-REVIEW-001/002（签名 Surface + 干净机）、G3-PPT/Writer/Review/HTML（真实 WPS/PowerPoint 人工视觉 + 部分 Official Host）、G2-AGENT/G5-CONNECTOR/G6-BILLING（真实服务，非 Windows 平台项）。

## 1. 环境准备

- Windows 11 x64 真机（不要 WSL 模拟）；`uname -s -m` 需落在 MINGW/MSYS/CYGWIN，`run-gate.sh` 才会把宿主识别为 `windows-11-x64`。
- Node.js 22.6+；各 PoC 子目录按其 `package.json` 跑 `npm ci`（例如 `scripts/poc/contract-foundation`、`scripts/poc/gate-3` 等）。
- Rust stable（`scripts/poc/gate-0/shell` 与 `scripts/poc/contract-foundation/consumers/rust-consumer` 的 `cargo test --locked`）。
- 干净机验证（G3-REVIEW-002、G6-PACKAGE-001）需要「从未安装过 Codex Desktop 与 SuperWagie」的机器，另计。
- WPS Office（G3-PPT/Writer/Review 的真实 Office 验收）与 PowerPoint（若做 PowerPoint 真实验收）。

## 2. 统一运行入口

所有权威 fixture 都用同一 runner：

```text
scripts/poc/run-gate.sh <gate-id> --platform windows-11-x64 --fixture <fixture-id> [额外参数]
```

`run-gate.sh` 会自检宿主平台、用 `evidence-run-init.mjs` 在 `evidence/<gate>/<run-id>/` 建 run 目录（manifest.json + environment.json + artifacts/ + screenshots/），再分发到对应 gate runner 写 `results.json`。`--help` 可列出全部额外参数（WPS、candidate-root、obsidian-vault、machine-profile 等）。

退出码约定：`0`=通过，`1`=验收失败，`2`=环境/参数阻塞。

## 3. 需要补的 20 个 fixture

状态列取自当前机器权威。

| Gate | Fixture | 当前状态 | Windows 侧要做的动作 |
|---|---|---|---|
| gate-0 | G0-ISOLATION-001 | conditional_go | 用同 registry 重跑，产出 `windows-11-x64` results |
| gate-0 | G0-DEPS-001 | conditional_go | 同上 |
| gate-0 | G0-SHELL-002 | blocked_environment | 需签名 Electron + Rust Core + 隔离 Surface 构建；另需签名/公证（§4） |
| gate-1 | G1-WORKSPACE-001 | go | Windows 重跑同 fixture |
| gate-1 | G1-CRASH-001 | go | 同上 |
| gate-1 | G1-MARKDOWN-001 | go | 同上（需 Obsidian vault，见 `--obsidian-vault`） |
| gate-1 | G1-DIAGRAM-001 | go | 同上 |
| gate-3 | G3-PPT-001 | blocked_environment | 解耦已关闭；补 Windows 三页真实评测 + 真实 WPS/PowerPoint 人工视觉（§4） |
| gate-3 | G3-WRITER-001 | conditional_go | Windows WPS 真实渲染 + 七阶段 + 三个人工门 + Owner（§4） |
| gate-3 | G3-REVIEW-001 | blocked_environment | 签名 artifact_preview Surface + 双平台 WPS 权威渲染（§4） |
| gate-3 | G3-REVIEW-002 | blocked_environment | 干净 Windows 机上的 renderer crash/restart 恢复矩阵（§4） |
| gate-3 | G3-HTML-001 | conditional_go | Windows Chromium 三断点真实浏览器 + Official Host（§4） |
| gate-4 | G4-VIDEO-001..005 | conditional_go ×5 | Windows 解码/golden render + 时间点人工 Review + Credits 幂等（§4） |
| gate-5 | G5-EXT-001 | conditional_go | 签名 Installer/Extension Worker 在 Windows 的安装/更新/回滚/移除（§4 签名） |
| gate-5 | G5-ATTACK-001 | conditional_go | 真实签名 Electron/Rust/Worker 边界在 Windows 的渗透矩阵 |
| gate-6 | G6-PACKAGE-001 | blocked_environment | 签名 Windows 安装包 + 干净机安装/升级/回滚/卸载 + SBOM（§4） |

## 4. Windows 单机关不掉的外部硬阻塞

以下不属于「Windows 重跑」能解决的，需要对应角色/基础设施到位后，在同一 Windows 平台上再跑一次并签署：

1. **代码签名/公证**：G0-SHELL-002、G5-EXT-001、G6-PACKAGE-001。需要签名 Windows 安装包 + macOS 公证（若做 macOS）+ 更新元数据 + SBOM。
2. **真实 WPS/PowerPoint 人工视觉**：G3-PPT-001、G3-WRITER-001、G3-REVIEW-001。由人工 Owner 完成视觉批准、编辑/撤销/保存/放弃/重开，逐页 PNG 证据 + 角色化 receipt。
3. **干净机**：G3-REVIEW-002、G6-PACKAGE-001。从未装过 Codex Desktop/SuperWagie 的机器，安装候选并执行故障/恢复矩阵。
4. **Official Host**：G3-HTML-001 的 preview/promote/update/rollback/revoke 需要官网测试环境。
5. **真实外部服务**：G2-AGENT-001（封闭 App Server + Managed AI）、G5-CONNECTOR-001（真实 AgentWiki）、G6-BILLING-001（Billing Sandbox）。这些不是平台项，Windows 跑不了。
6. **Owner 签署**：全部 31 个 fixture 在各自平台的 results SHA-256 上需要 owner role + UTC 时间签署，才会把 `signed_go` 计为非零。

## 5. 完成判定与回传

- 每个 Windows 平台 run 在 `evidence/<gate>/<run-id>/` 下必须有：`results.json`（绑定 `gate`、`fixture`、`platform=windows-11-x64`）、`manifest.json`（platform=windows-11-x64）、`command.txt`、以及对应 artifacts。
- 跑完刷新权威：`node scripts/poc/validation-status-audit.mjs --output docs/技术可行性/当前技术验证状态.json`。
- 提交代码回传：Windows 侧改动的 runner/fixture 修复 + 新增 Windows evidence 一并 commit。evidence 默认不进 git（见 .gitignore），只需提交 `results.json`/决策与代码改动；若要保持证据可追溯，单独用附件/归档通道回传。

## 6. 优先级建议

先关「纯平台重跑」这批（G1 全部、G0-ISOLATION/DEPS、G5-EXT/ATTACK、G4-VIDEO），把 `windows-11-x64` 平台证据补上；再处理签名/干净机/Owner 这些需要外部角色配合的项。这样能先让 20 个缺 Windows 的 fixture 里那些「只差一次真机重跑」的降到 signed/conditional，再集中解决签名与人工视觉。
