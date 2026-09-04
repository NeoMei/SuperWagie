# SuperWagie PoC Runner

> 架构状态（2026-09-01）：现有 `G0-SHELL-001` 和 Gate 3 Tauri runner 是架构变更前的历史 PoC，只保留证据与回归价值，不能签署当前桌面壳 GO。当前权威 fixture 是 `G0-SHELL-002`（Electron + bundled Chromium + Rust Product Core + isolated Workers）；统一入口已有 fail-closed 预检 runner，签名构建和功能 runner 尚未实现，因此当前返回 `BLOCKED_ENVIRONMENT`。不得继续把本目录的 Tauri 代码扩展为生产壳。

统一验证入口（见 docs/技术可行性/技术验证执行计划.md §2）：

```
./scripts/poc/run-gate.sh <gate-id> --platform <platform-id> [--fixture <fixture-id>] [Gate-specific explicit inputs]
```

- 退出码：`0` 通过；`1` 验收失败；`2` 环境不满足或参数错误。
- 证据写入 `evidence/<gate-id>/<run-id>/`。
- 当前已实现 gate：
  - `contract-foundation`（Schema 元验证 + 错误码目录 + 当前 CF-PROTOCOL-002 fixture + TypeScript/Python/Rust 锁定消费者一致性；parity artifact 由结果 SHA-256 绑定；CF-PROTOCOL-001 仅保留为旧 CommandEnvelope 历史证据）；
  - `gate-0 --fixture G0-DEPS-001`（四层依赖归属探针：OS Baseline / Signed Runtime Image / External Host / User Extension Environment；拒绝内置 Runtime 从系统环境回退，可选绑定候选 Runtime Manifest）。
  - `gate-0 --fixture G0-ISOLATION-001`（主机干扰源只读清单基线采集；Runtime 三场景 zero-diff 对比待 Runtime 实现后执行，decision_hint=CONDITIONAL_GO）。
  - `gate-0 --fixture G0-SHELL-002`（当前方案 B 预检；在真实签名 Electron 构建、Runtime Manifest 和双平台证据存在前固定为 `BLOCKED_ENVIRONMENT`）。
- Universal Viewer 验收命名空间已注册 `gvp-0` 至 `gvp-5`：
  - `gvp-0 --fixture GVP-0-CORE-001 --candidate-root <absolute-dir>` 是唯一已实现执行器。它重验冻结源、补丁、依赖/许可/SBOM/漏洞、构建与 chunk 证据，重跑 Host Adapter 与恶意输入基线，并产生符合 `viewer-gate-receipt.schema.json` 的 receipt。当前候选仍有 8 条 forbidden runtime edges，因此成功完成采集也必须以退出码 `1` 返回 `NO_GO`；这不是环境错误。
  - receipt 通过 `evidence_sha256` 绑定仅含相对路径与 SHA-256 的 evidence manifest；验收摘要固定 `release_admission=NO_GO`、`production_registry_admitted=false`、`production_chunk_signed=false`，不制造签名或格式准入。
  - `gvp-1` 至 `gvp-5` 仍为 `RESEARCH_REQUIRED`，显式调用统一返回退出码 `2`，不回退到旧 Gate 3 证据。
- `gate-3 --fixture G3-REVIEW-001|G3-REVIEW-002`：当前统一入口同样使用方案 B fail-closed 预检；旧 Tauri Reviewer 不能签署 `artifact_preview` Surface，真实 Electron runner 尚未实现，当前固定为 `BLOCKED_ENVIRONMENT`。

以下 Gate 3 说明仅记录旧 Tauri Reviewer 的历史执行合同，不能作为当前统一入口行为或方案 B 准入证据：

- 历史 `G3-REVIEW-001` 标准执行器接受显式 WPS/Python/WPSComposer、machine profile、checklist 与 isolation evidence，并绑定 renderer/cache identity。
- 历史 `G3-REVIEW-002` 覆盖十个隔离/恢复场景；其归档证据只证明旧边界下的行为，不证明 Electron `artifact_preview`、真实 WPS、Windows 或当前进程边界。
- Task 10 当前六个 recovery run root 为 `20260831T091949Z-53143`、`20260831T091950Z-53161`、`20260831T091951Z-53179`、`20260831T091951Z-53197`、`20260831T091951Z-53222`、`20260831T091952Z-53140`（均位于 `evidence/gate-3/`，且逐一通过 archival validator）。它们只证明当前 macOS 固定自动化恢复契约，不证明断电/进程崩溃后的落盘持久性，也不升级 Windows、never-installed Codex、真实 WPS/视觉验收或 DOC-04/05/06、UI-05。
- Gate 3 automation 固定使用项目 built PoC binary；统一 runner 不接受 reviewer executable/argument override。测试 override 只存在于 `review-gate.mjs` 的 fake-owned-process 单元测试 seam。
- `macos-15-arm64` 的标准 automation 在采集 renderer provenance、绑定 WPS 或启动 Reviewer 前，使用固定绝对路径 `/usr/sbin/ioreg` 和固定参数只读检查当前 console session。只有唯一当前 console user 明确报告 `CGSSessionScreenIsLocked=No` 才继续；锁屏、非交互、字段缺失、输出异常、超时或工具失败都以退出码 2、`BLOCKED_ENVIRONMENT/INTERACTIVE_SESSION_UNAVAILABLE` fail closed。该探针不适用于 metrics/checklist 导入，也不改变 Windows 执行路径。
- 当前 `.github/workflows/office-reviewer-windows-contract.yml` 是方案 B 的 fail-closed Windows 合同：它静态检查旧 native PoC 仍可审计，同时通过公开 `run-gate.sh` 分别执行 `G3-REVIEW-001` 与 `G3-REVIEW-002`，只接受退出码 `2`、`BLOCKED_ENVIRONMENT` 和 `evidence_revision=solution-b-v1`，并仅上传这两份阻塞证据。工作流不得调用旧 `review-gate.mjs`、`review-isolation-gate.mjs`、fake WPS、Cargo/Tauri build 或旧 Windows report，也不使用 secret、不发布、不部署。
- `windows-ci-report.mjs`、`windows-toolchain-identity.mjs`、fake-WPS fixture 与旧 Rust reviewer 的精确绑定测试继续保留为历史证据库和 clean-room 研究资料，但不再是当前公共 CI 或准入执行链。后续只有真实方案 B `artifact_preview` Surface、Rust Product Core/Worker 边界、Windows 11 x64、真实 WPS、签名构建和指定恢复场景的证据，才能解除 Review 阻塞；旧报告无论是否通过都不能升级当前技术矩阵。
- Gate 3 metrics JSON 必须精确包含十个指标以及 fixture、manifest SHA-256、opaque session、24 小时内采集时间、代表性机器标记和四组非零样本数；多余 provenance/sample 字段、非有限/负数、陈旧或 fixture 不匹配均为 `NO_GO`。只有性能阈值未达标时才允许 `CONDITIONAL_GO`，并固定记录 external/side-by-side WPS fallback；silent annotation misplacement 永远是 `NO_GO`。
- 人工 checklist 除九项逐项布尔结果和相对截图引用外，还必须记录 `renderer.application=WPS`、精确版本、字体环境 hash、`wpscomposer_source_identity=source-sha256:<sha256>`、terms-review owner/decision。截图会复制到标准 `screenshots/`，但不能替代 metrics JSON。缺少 terms/source 或通过的 `codex-never-installed` 隔离结果时不能升级为 `GO`。
- Task 8 的 built-shell automation 仅由 Rust 读取并 hash 校验原生 fixture manifest/path；WebView 只收到 opaque handle、白名单显示名和 session/index。它仅复用现有 `artifact-opened` 事件与七个命令，完成 PDF、DOCX fast、DOCX truth、PPTX truth 和固定五类交互；trusted host 验证 metrics/session 后才按顺序写 metrics 与 completion。
- 依赖证据位于 `evidence/gate-3/{npm-sbom.cdx.json,cargo-metadata.json,third-party-inventory.json}`。inventory 只证明已安装许可证来源、locked Cargo 图和 forbidden-coupling scan；`commercial_redistribution_approval=false`，不能据此宣称 WPS 商业再分发已经获批。
- Task 8 不执行真实 WPS/Office、视觉验收或 clean-machine 场景。真实 macOS/WPS checklist 属于 Task 9；四个隔离场景与 clean target 的最终组合结论属于 Task 10。
- gate-0 其余未注册的 fixture（包括历史 `G0-SHELL-001`）运行时会以退出码 2 提示。
- 首次运行前：`cd scripts/poc/contract-foundation && npm install`。

## Gate 3 HTML 随包 Chromium 评估

`html-browser-eval-host.mjs` 用候选 Electron 内的 Chromium 在隐藏、sandboxed
BrowserWindow 中跑三个固定页面。它拒绝所有权限与 HTTP(S) 请求，记录桌面/移动
截图，并产生可被 `G3-HTML-001` 绑定的 `evaluation.json`：

```bash
"$ELECTRON_EXECUTABLE" scripts/poc/gate-3/html-browser-eval-host.mjs \
  --site-root "$PWD/fixtures/gate-3/G3-HTML-001/site" \
  --output-root "$PWD/evidence/gate-3/html-browser-evaluation-<run-id>"

./scripts/poc/run-gate.sh gate-3 --platform macos-15-arm64 \
  --fixture G3-HTML-001 \
  --evaluation-result "$PWD/evidence/gate-3/html-browser-evaluation-<run-id>/evaluation.json"
```

`ELECTRON_EXECUTABLE` 必须指向候选 Runtime 中的绝对可执行路径；不接受系统 Chrome
或在首次运行时下载浏览器。
