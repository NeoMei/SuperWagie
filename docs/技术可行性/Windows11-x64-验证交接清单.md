# SuperWagie Windows 11 x64 技术验证交接基线

> 交接日期：2026-09-03
>
> 接力目标：在 Windows 11 x64 真机上补齐方案 B 的平台实现与验证证据，修复发现的问题，并把可审计结果提交回本仓库。
>
> V1 平台范围：macOS + Windows 11。Ubuntu/Linux 仅为 V1 后 best-effort，不得为其增加第二桌面壳、第二 Runtime 分支或改变当前架构。
>
> 权威状态：[当前技术验证状态.json](当前技术验证状态.json)；当前实时重算为 37 expected / 11 GO / 12 CONDITIONAL_GO / 0 NO_GO / 9 BLOCKED_ENVIRONMENT / 5 RESEARCH_REQUIRED / 0 missing / 0 signed GO，Production Implementation Admission = `NO_GO`。2026-09-04 的 Windows 自动化已经执行并作为无准入效力的受审观察接入；本清单后续只处理当前签名候选、人工/干净机事实和 GVP 新证据。

## 1. Windows 接力的正确边界

macOS 已完成当前机器上可执行的编码前技术验证，但这不等于 Windows 只需把同一命令再跑一遍。当前 `scripts/poc/solution-b-*` 中仍有以下 macOS 专用实现：

- `Electron.app/Contents/MacOS/Electron`、无 `.exe` 的 Rust Core 路径；
- `electron-v44.1.0-darwin-arm64.zip`、`/usr/bin/ditto`、`/usr/bin/clang`、`/bin/ps`；
- macOS sandbox profile、`.app` 身份探针和 `platform: macos-15-arm64` 固定字段；
- Task 5/6/7 默认引用 macOS 候选目录和 macOS 子 fixture。

因此 Windows 接力分为两步：

1. 保持契约和安全边界不变，补齐 Windows 11 x64 的一次性验证候选及 runner 适配；
2. 在真实 Windows 候选上执行 fixture，产出 `platform=windows-11-x64` 的原始证据。

不得为了跑绿而放宽 fail-closed、伪造人工 Receipt、用 WSL 代替 Windows、恢复 Tauri/System WebView、连接机器已有 Codex Server，或让产品首次运行再动态安装内置依赖。

## 2. 仓库、基线与环境

### 2.1 拉取并记录不可歧义的基线

使用 Windows 11 x64 真机和 Git for Windows。建议路径不含同步盘；路径可含中文，但至少再跑一次带空格和中文的 workspace。

```powershell
git clone https://github.com/NeoMei/SuperWagie.git
Set-Location SuperWagie
git switch main
git pull --ff-only
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

预期：工作树干净，`HEAD` 与 `origin/main` 一致。把这个 SHA 写入回传报告的 `baseline_commit`。不要根据文档里的日期猜版本。

### 2.2 必需环境

- Windows 11 x64 真机，不使用 WSL 作为平台证据；
- Git for Windows（统一 Gate runner 从 Git Bash 运行）；
- Node.js `24.18.0`，与现有 CI 固定版本一致；
- Rust stable x86_64-pc-windows-msvc；
- Visual Studio Build Tools 2022：MSVC、Windows 11 SDK、C++ 构建工具；
- PowerShell 7；
- WPS Office Windows 正式版；需要 PowerPoint 对照时安装 Microsoft PowerPoint；
- FFmpeg/codec 只可作为 PoC 明确记录的工具，最终产品必须使用随安装已完备、受清单约束的系统能力包。

记录环境：

```powershell
git --version
node --version
npm --version
rustc --version
cargo --version
where.exe node
where.exe ffmpeg
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
```

任何路径、用户名、Access Token、API Key、文档正文或企业信息进入回传前都必须脱敏。

### 2.3 安装测试依赖

在 PowerShell 中执行：

```powershell
$packages = @(
  'scripts/poc/contract-foundation',
  'scripts/poc/gate-1/markdown-editor-poc',
  'scripts/poc/gate-3',
  'scripts/poc/gate-3/presentation-service-spike',
  'scripts/poc/solution-b-spike'
)
foreach ($package in $packages) { npm ci --prefix $package }
```

`solution-b-task5`、`solution-b-task6`、`solution-b-task7` 当前只有 Node 内置模块依赖，没有 lockfile，不需要执行 `npm ci`。

如果安装失败，先记录失败目录、命令、退出码和完整日志；不要用全局 npm 包或复制另一台机器的 `node_modules` 绕过。

## 3. 先跑不依赖真实候选的基线

### W-00：规格与仓库卫生，P0

```powershell
node scripts/check-spec-refs.mjs
git diff --check
git status --short
```

预期：以命令当次输出为准；当前基线为矩阵 162 条中 157 条有规格引用，锚点检查通过。无空白错误；此时除依赖目录外不应产生源码改动。如矩阵变更，不得沿用本文的历史数字代替当次输出。

### W-01：跨平台自动测试，P0

在 Git Bash 中执行：

```bash
find scripts/poc -name '*.test.mjs' -not -path '*/node_modules/*' -print0 | xargs -0 node --test --test-concurrency=1
```

再执行 Rust consumer：

```powershell
cargo test --locked --manifest-path scripts/poc/contract-foundation/consumers/rust-consumer/Cargo.toml
```

预期：所有平台无关测试通过；macOS-only 用例只能按明确条件 skip；Windows 专用测试不得被误 skip。失败时先修代码与测试，再从 W-00 重跑。

### W-02：现有 GitHub Windows 契约检查，P0

```powershell
node scripts/poc/gate-3/windows-contract-check.mjs
node --test scripts/poc/environment-gate.test.mjs scripts/poc/gate-3/windows-contract.test.mjs
```

说明：`.github/workflows/office-reviewer-windows-contract.yml` 当前只验证旧实现没有被错误接回，并证明 `G3-REVIEW-001/002` 在缺少方案 B Windows 候选时以退出码 2 安全阻塞。它不是 Office Review 可用性证据，也不能把父 Gate 改成 GO。

## 4. 方案 B 的 Windows 适配任务

以下任务必须先完成，后续 Gate 才有真实意义。所有变更均须有 Windows 单元测试和真实候选证据。

### W-10：Windows 候选构建与启动，P0

适配 `scripts/poc/solution-b-spike/`：

- 使用固定版本和校验和的 Electron `win32-x64` 包，不使用系统 Chrome/Edge；
- 使用 MSVC 或等价受控构建生成 Rust Core `.exe` 和所需原生模块；
- 候选清单写 `platform: windows-11-x64`，记录 Electron/Chromium/Rust Core/Worker 的内容哈希；
- Electron Main、Rust Core、Render/Extension/Review Worker 只从候选根启动；
- 进程树可用 CIM/Toolhelp 等 Windows 原生方法采样，但只能观察本次候选范围；
- 本地 IPC 使用受 ACL 约束的 Named Pipe，不回退到 TCP；
- 路径校验处理 junction、reparse point、symlink、大小写和 `\\?\` 前缀，不能只把 POSIX `openat` 逻辑字符串替换；
- 候选离线启动，首次运行不得下载 Runtime、模型、浏览器或系统内置 Skill 依赖；
- 证据只保留脱敏标签和哈希，不保存 secret 或绝对用户路径。

通过标准：候选可离线启动、自检成功、进程/模块均来自候选根、系统已有 Codex Server 和全局 Node/Python 配置变化不影响结果、篡改和缺件均 fail closed。

### W-11：Task 5 安全与扩展生命周期，P0

适配 `scripts/poc/solution-b-task5/`：

- 去除 macOS 固定 fixture、`.app`、sandbox profile 和默认候选路径；
- Windows isolation 使用 Job Object、Restricted Token/AppContainer 或经过论证的等价边界；
- 执行候选闭包、三种宿主干扰场景、边界攻击矩阵、用户 Skill/MCP 安装—更新—回滚—移除；
- 保持系统内置能力不可在用户扩展页展示，用户扩展只允许 Skill/MCP；
- 用户 Skill 调系统能力只能经过 Public Capability Facade，调用者不能伪造 actor/grant/wallet/Gate Receipt。

通过标准：Windows 子 fixture 真实执行且全部通过；父 fixture 仍按签名、真实 handler、Network Broker/Managed AI 等剩余条件如实保持 CONDITIONAL/BLOCKED，不得越权升级。

### W-12：Task 6 视频链，P0

适配 `scripts/poc/solution-b-task6/`：

- Electron 和 Worker 路径来自 Windows 候选清单；
- 五个 Profile 全部执行：网站 Demo、教学课件、PPT 讲解、图片绘本、照片动态；
- 验证实际帧输出、音视频合成、解码、重复执行、Worker crash/hang 恢复；
- FFmpeg/codec 身份、版本、绝对来源和哈希写入证据；
- 不引入 OpenMontage 或 Remotion 生产依赖，也不暴露 Skill 自带 UI。

通过标准：五个 `G4-VIDEO-001..005` 产生 Windows 解码证据。时间点人工 Review、真实 Credits 幂等若未完成，状态仍为 CONDITIONAL_GO。

### W-13：历史 Task 7 Office Review 交接（不执行）

> historical-only / superseded-for-current-architecture：本项只保留 `G3-REVIEW-001/002` 的 Windows 历史追溯位置，不参与当前 Universal Viewer、GVP-0–5、格式准入或发布判定。

`scripts/poc/solution-b-task7/` 不再作为当前 Viewer Windows 实施或验收入口。当前 Windows Viewer 验证只按 Universal Viewer Platform Design 和 GVP 执行；外部目标应用只可做独立最终交付 smoke，不可作为 Viewer 打开路径、回退或页面依据。

## 5. 需要 Windows 平台证据的 20 个权威 fixture

下表是接力范围，不等于都能在一台普通开发机上关闭。

| 编号 | Fixture | 交接时状态 | Windows 动作 | 额外条件 |
|---|---|---:|---|---|
| W-20 | G0-ISOLATION-001 | CONDITIONAL_GO | 在 W-10 候选上跑隔离矩阵 | 签名候选可继续增强证据 |
| W-21 | G0-DEPS-001 | CONDITIONAL_GO | 候选闭包、缺件/篡改/外部依赖检查 | 固定依赖清单 |
| W-22 | G0-SHELL-002 | BLOCKED_ENVIRONMENT | Electron + Rust Core + Worker 真候选 | Windows 代码签名、人工 IME/拖放/无障碍 |
| W-23 | G1-WORKSPACE-001 | GO | 中文/空格路径、事务、CAS、watch/index | 无 |
| W-24 | G1-CRASH-001 | GO | 写入与索引崩溃恢复 | 无 |
| W-25 | G1-MARKDOWN-001 | GO | Obsidian 等价阅读/编辑、链接、嵌入、图片 | 真实 vault 人工确认 |
| W-26 | G1-DIAGRAM-001 | GO | Excalidraw + draw.io 打开/保存/恢复 | 人工版式确认 |
| W-27 | G3-PPT-001 | BLOCKED_ENVIRONMENT | Windows 三页真实评测 | WPS/PowerPoint 人工视觉、Owner |
| W-28 | G3-WRITER-001 | CONDITIONAL_GO | Windows WPS 七阶段与三个人工门 | SuperWriter 真实执行、Owner |
| W-29 | G3-REVIEW-001 | BLOCKED_ENVIRONMENT | historical-only；不用于当前 Viewer/GVP | 历史追溯 |
| W-30 | G3-REVIEW-002 | BLOCKED_ENVIRONMENT | historical-only；不用于当前 Viewer/GVP | 历史追溯 |
| W-31 | G3-HTML-001 | CONDITIONAL_GO | bundled Chromium 三断点真实浏览器 | Official Host 另行补齐 |
| W-32 | G4-VIDEO-001 | CONDITIONAL_GO | 网站 Demo 视频 | 人工 Review、Credits |
| W-33 | G4-VIDEO-002 | CONDITIONAL_GO | 教学课件视频 | 人工 Review、Credits |
| W-34 | G4-VIDEO-003 | CONDITIONAL_GO | PPT 讲解视频 | 人工 Review、Credits |
| W-35 | G4-VIDEO-004 | CONDITIONAL_GO | 图片绘本视频 | 人工 Review、Credits |
| W-36 | G4-VIDEO-005 | CONDITIONAL_GO | 照片动态视频 | 人工 Review、Credits |
| W-37 | G5-EXT-001 | CONDITIONAL_GO | Windows 用户 Skill/MCP 生命周期 | 签名 Installer/Worker |
| W-38 | G5-ATTACK-001 | CONDITIONAL_GO | Windows 边界攻击矩阵 | 真实签名边界最佳 |
| W-39 | G6-PACKAGE-001 | BLOCKED_ENVIRONMENT | 安装/升级/回滚/卸载/SBOM | 签名安装包、干净机 |

统一 runner 只从 Git Bash 调用：

```bash
bash scripts/poc/run-gate.sh <gate-id> --platform windows-11-x64 --fixture <fixture-id> [fixture 参数]
```

统一 runner 的可选参数包括 `--candidate-root`、`--evaluation-result`、`--review-checklist`、`--machine-profile`、`--scenario-attestation`、`--obsidian-vault` 等；以 `scripts/poc/run-gate.sh` 文件头的 usage 为准。退出码：`0` 通过，`1` 验收失败，`2` 环境或参数阻塞。退出码 2 不是通过；必须在报告中写明 blocker。

每个 run 必须生成：

- `evidence/<gate>/<run-id>/manifest.json`；
- `environment.json`、`command.txt`、`stdout.log`、`stderr.log`；
- `results.json`，其中 gate/fixture/platform/revision 与本次运行一致；
- 所需 artifacts/screenshots，以及它们的 SHA-256。

## 6. Windows 单机不能自行关闭的条件

以下项目不得用 mock 或文字声明代替：

1. Windows Authenticode 签名、更新元数据、安装包与 SBOM；
2. 从未安装 Codex Desktop/SuperWagie 的干净机安装、升级、回滚和卸载；
3. WPS/PowerPoint 真实视觉、编辑/撤销/保存/放弃/重开与 Owner 签署；
4. Official Host 的 preview/promote/update/rollback/revoke；
5. 封闭 App Server + Managed AI、真实 AgentWiki、Billing Sandbox；
6. Writer signer、Credits 结算和有权角色的 Gate Receipt。

`G2-AGENT-001`、`G5-CONNECTOR-001`、`G6-BILLING-001` 等并不缺 Windows 平台条目，它们缺的是上述真实服务；不要重复跑平台命令后误报为已关闭。

## 7. 人工 UI 验收清单

每个步骤记录：测试人、UTC 时间、Windows build、候选 SHA、输入 fixture SHA、预期、实际、截图/录像文件 SHA、结论。

| 编号 | 操作 | 预期 |
|---|---|---|
| UI-01 | 中文 IME 连续输入、候选上屏、撤销/重做 | 不丢字、不乱序，撤销粒度合理 |
| UI-02 | 从 Explorer 拖入 MD/PNG/PDF/DOCX/PPTX | 文件打开且内容可见，不只显示文件名 |
| UI-03 | Markdown 阅读态直接编辑 | 接近 Obsidian Live Preview；语法、选择、光标稳定 |
| UI-04 | WikiLink、别名、标题锚点、块引用 | 打开正确文档/位置，不全部跳到同一页 |
| UI-05 | 嵌入 Markdown、PNG、Excalidraw | 原图可见，块级/行内位置与 Markdown 语义一致 |
| UI-06 | draw.io/Excalidraw 编辑、保存、重开 | 内容不丢失，外部修改冲突可恢复 |
| UI-07 | DOCX/PPTX/PDF Review 滚动、缩放、批注 | 视觉不明显失真，批注锚点稳定 |
| UI-08 | Review Worker/renderer crash 后恢复 | Shell 不退出，任务可重试或恢复 |
| UI-09 | 全局字体缩放与窗口缩放 | 只影响预期区域，无横向溢出和控件遮挡 |
| UI-10 | Agent 播放/停止、交互输入、session Credits | 状态明确；Credits 作为固定附加信息累加，不抢占内容 |

## 8. 缺陷编号、修复循环与完成定义

缺陷编号使用 `WIN-<区域>-NNN`，例如 `WIN-MD-001`、`WIN-REVIEW-002`。每条缺陷必须包含：

- `baseline_commit`、候选 SHA、Windows build；
- 最小复现步骤、预期、实际、退出码；
- fixture 与 run-id；
- 日志/截图/录屏的相对路径和 SHA-256；
- 根因、修复 commit、回归测试；
- 状态：OPEN / FIXED / VERIFIED / EXTERNAL_BLOCKED。

发现 bug 后按以下循环执行，不能只修一次就结束：

1. 添加能先失败的最小自动测试或固定人工复现；
2. 修复；
3. 重跑该 fixture；
4. 重跑 W-00、W-01 和受影响 Gate；
5. 再做一轮代码审查与 UI 回归，直到没有值得修复的已知问题。

Windows 技术验证完成的最低标准：

- W-00/W-01/W-02 全绿；
- W-10 至 W-12 的 Windows 实现和测试提交；W-13 只保留 historical-only 追溯；
- W-20 至 W-39 每项都有真实结果，或有可复核的 `EXTERNAL_BLOCKED` 证据；
- 没有把 `BLOCKED_ENVIRONMENT`、mock 或旧 macOS 证据写成 Windows PASS；
- 规格引用检查、完整自动测试和 `git diff --check` 通过；
- 结果已经过至少一轮独立复核。

## 9. 回传与提交规则

`evidence/` 默认被 `.gitignore` 排除，避免把体积大、含本地环境信息的原始证据直接提交。Windows 接力方应：

1. 保留本机原始 `evidence/`；
2. 将完整证据打包并计算 SHA-256，通过 GitHub Actions artifact、Release 附件或双方约定的受控通道回传；
3. 在 `docs/技术可行性/Windows技术验证阶段报告-YYYY-MM-DD.md` 记录 artifact 名称/地址、包 SHA、run-id、results SHA 和结论；
4. 运行并提交更新后的权威状态：

```powershell
node scripts/poc/validation-status-audit.mjs --output docs/技术可行性/当前技术验证状态.json
```

5. 提交 runner/fixture/测试/规格同步/阶段报告；不得提交 token、私钥、签名证书、企业文档正文或未脱敏绝对路径。

建议提交顺序：

1. `test(windows): add failing solution-b coverage`
2. `feat(windows): port solution-b validation candidate`
3. `test(windows): record platform validation results`
4. `docs(validation): publish windows handoff results`

交接方最终汇报必须分别说明：本地分支、`origin/main`、GitHub Actions、原始证据包、人工验收、外部服务与 Production Admission；其中一项成功不能替代其他项。

## 10. 开工前必读

- [V1 发布范围基线](../superpowers/specs/2026-08-29-superwagie-v1-release-scope.md)
- [方案 B 架构基线](../superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md)
- [技术验证执行计划](技术验证执行计划.md)
- [外部条件清单](技术验证外部条件清单.md)
- [macOS 阶段报告](macOS技术验证阶段报告-2026-09-03.md)
- [规则路由](../../AGENTS.md) 与命中区域的 `rules/*.md`

本交接遵循 R-QS-01（证据优先）、R-QS-02（不得越权升级 Gate）、R-QS-04（平台与干净机）、R-QS-08（真实性）和 R-QS-09（可选平台不反向塑造架构）。

## Universal Viewer 交接增量

### UV-W-00：准备精确 Frozen Core 离线归档

在已验证的源机器、仓库根执行：

```bash
mkdir -p "$PWD/evidence-transfer"
git -C scripts/poc/universal-viewer/.candidate/source archive --format=tar --output "$PWD/evidence-transfer/omni-viewer-core-0.16.0-ffdcda3eea83527380996ac935605f1422e43d3b.tar" ffdcda3eea83527380996ac935605f1422e43d3b
shasum -a 256 "$PWD/evidence-transfer/omni-viewer-core-0.16.0-ffdcda3eea83527380996ac935605f1422e43d3b.tar"
```

只接受 archive SHA-256 `1e0681afd02d7b6887bb373d5256eabcab69f8ac3015aa8372dd5e0754cc698d`。通过受控通道传输当前仓库和该 tar，不传输 `.candidate/source` 的未打包工作树。

在 Windows Git Bash 中从仓库根执行：

```bash
cd scripts/poc/universal-viewer
node acquire-frozen-core.mjs --cache-root "$PWD/.candidate" --offline-archive "/c/transfer/omni-viewer-core-0.16.0-ffdcda3eea83527380996ac935605f1422e43d3b.tar"
cd ../../..
git -C scripts/poc/universal-viewer/.candidate/source status --porcelain=v1
git -C scripts/poc/universal-viewer/.candidate/source rev-parse HEAD
git -C scripts/poc/universal-viewer/.candidate/source rev-parse HEAD^{tree}
```

预期 status 无输出，commit 为 `ffdcda3eea83527380996ac935605f1422e43d3b`，tree 为 `37ed0235fb0da0124d51e5815def4f832b3724d2`，`.candidate/.acquisition.json` 记录同一 archive/source-lock/materialized-tree 哈希。离线 archive 只解决源获取；当前 GVP-0 仍要求实时 npm 公告审计，不可用旧 cache 伪装 freshness。

### UV-W-01：先实现并验收 Windows 进程监督适配器（当前 blocker）

当前 GVP-0 恶意文件 runner 只实现了 macOS `/bin/ps` + POSIX process-group 采集／清理。`win32` 路径没有 Windows CIM 进程树收集器、Job Object 所有权和整组终止／存活者校验；因此当前代码不能完成 Windows GVP-0，也不得执行后文命令并把结果计为 Gate 证据。

必须先在受审查实现提交中完成以下前置条件：

1. 为 `malicious-corpus.mjs` 提供 Windows 专用 collector，通过 CIM 获得 root 及全部后代的不透明身份，并且证据只保留可执行文件 basename/hash；
2. 在创建 worker 时将根进程及后代绑定到专属 Windows Job Object，超时、取消和正常退出都由 Job 级清理，不以单 PID `kill` 代替；
3. 新增 Windows 自动测试，至少覆盖短命后代、脱离存活后代、超时整组清理、采集失败 fail-closed 和清理后零存活者；
4. 在 Windows 11 x64 干净机上证明 `collector_basename`/hash、`group_isolated=true`、`sample_failures=0`、`process_group_survivors_after_cleanup=0` 和 `known_descendant_survivors_after_cleanup=0`。

下方手工 CIM 命令只是诊断快照，不拥有 Job Object，不能证明组清理，不能满足上述前置条件，也不得计入 GVP receipt：

```powershell
Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath
```

### UV-W-02：前置适配器通过后运行 Windows GVP-0

只有 UV-W-01 的实现、自动测试和真机证据均已经受审查通过，才在仓库根的 Git Bash 执行这一条精确命令：

```bash
./scripts/poc/run-gate.sh gvp-0 --platform windows-11-x64 --fixture GVP-0-CORE-001 --candidate-root "$PWD/scripts/poc/universal-viewer/.candidate/source"
```

不得换成 macOS platform、`GVP-0` 简写 fixture、另一候选目录或直接调用内部 acceptance script。记录 exit code：`0` 是完整验收通过，`1` 是验收 `NO_GO`，`2` 是环境／输入阻塞。三者都必须保留原始证据，不得把 `2` 改写为 PASS。

每次运行保留如下精确结构：

```text
evidence/gvp-0/<run-id>/manifest.json
evidence/gvp-0/<run-id>/environment.json
evidence/gvp-0/<run-id>/command.txt
evidence/gvp-0/<run-id>/stdout.log
evidence/gvp-0/<run-id>/stderr.log
evidence/gvp-0/<run-id>/decision.md
evidence/gvp-0/<run-id>/results.json
evidence/gvp-0/<run-id>/artifacts/evidence-manifest.json
evidence/gvp-0/<run-id>/artifacts/acceptance-summary.json
evidence/gvp-0/<run-id>/artifacts/<bound-artifacts>
```

只有 `results.json` 通过 schema/身份/新鲜度/安全检查、evidence manifest 完整绑定 56 个要求的 artifact roles，且 receipt 通过公开 finalization，才可计为 GVP-0 平台 receipt。空 `results.json`、只有 draft `decision.md`、任意环境日志或复制的决策文本均不计数。

Windows 进程树证据必须由 UV-W-01 已验收的 CIM + Job Object 适配器自动产生并脱敏。下列命令只可用于人工诊断对照，不得单独计为收集、终止或 receipt 证据：

```powershell
Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath
```

原始 `evidence/` 目录不得直接更新状态。若 exit `2`，先将上述 9 个保留文件脱敏后复制到
`fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/<run-id>/`，将 operator 改为角色标识，删除绝对路径、PID、用户目录、凭据和 stack trace，并生成 `index.json` 绑定精确 gate/fixture/platform/run-id、`windows-11-x64`↔`win32/x64`、exit-2 reason、`receipt:null` 和 9 个文件 SHA-256。这个 bundle 必须与审查提交一起回传主线；未追踪 bundle、ignored `evidence/` 或只有自报耗时的目录不会被消费。

在主线审查 bundle 后，使用可实际调用的通用导入／更新命令（Git Bash）：

```bash
bundle="fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/<run-id>"
git ls-files --error-unmatch "$bundle/index.json"
node scripts/poc/validation-status-audit.mjs --repo-root "$PWD" --environment-attempt-bundle "$bundle" --update-status docs/技术可行性/当前技术验证状态.json
node scripts/poc/validation-status-audit.mjs --repo-root "$PWD" --status docs/技术可行性/当前技术验证状态.json
```

该命令同时支持受审查的 `macos-15-arm64`↔`darwin/arm64` 和 `windows-11-x64`↔`win32/x64` exit-2 bundle，但只写入 `BLOCKED_ENVIRONMENT` attempt，不生成 receipt。若 exit `0` 并产生了候选 receipt，不使用这条 environment-attempt 命令；将完整 evidence/receipt bundle 回传主线，由现有严格 receipt validator 完成 schema、56-role manifest、平台身份、哈希和 freshness 审查后再决定状态。不得将成功运行改写成环境失败 bundle。

当前 Windows GVP-0 仍为缺失，UV-W-01 仍是前置 blocker。未来在适配器通过后，Windows GVP-0 成功也只能满足该平台的 Contract + Provenance；它不满足 GVP-1–5，不准入任何格式，不替代 macOS receipt，不允许生产实施或发布。Frozen Core base + Office 只读窄切片已移除 PDF editing/conversion fallback，候选闭包为 `GO / forbidden_runtime_edges=0 / patches=0`；Windows 仍必须生成独立 win32/x64 baseline 并在原生 Windows 11 x64 真机产生自己的准入证据，不得复用 Darwin 候选回执。

- [ ] 在 Windows 11 x64 干净机验证 GVP-0–5，每个格式变体使用 Ledger 指定 Corpus；
- [ ] 记录候选/Chunk/OS/arch/字体/renderer/parser 身份、输入输出哈希、状态诊断、资源与恢复指标；
- [ ] 验证 ViewerSurface/Worker 隔离、ResourceHandle/SecretHandle、网络/导航/主动内容拒绝和 archive bomb；
- [ ] 证明签名离线 Chunk、包体预算、SBOM、LICENSE/NOTICE 与可复现来源；
- [ ] 不接受旧 G3-REVIEW、macOS 单平台或外部目标应用 smoke 代替 Viewer 回执。

全部项目初始为 `RESEARCH_REQUIRED`，不得预填 GO。
