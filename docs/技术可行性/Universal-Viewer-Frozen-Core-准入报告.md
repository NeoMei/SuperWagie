# Universal Viewer Frozen Core 准入报告

> 日期：2026-09-04
> 当前结论：Frozen Core 窄切片候选 `GO`；macOS 15 GVP-0 因当前主机实际为 macOS 26.6.2 而 `BLOCKED_ENVIRONMENT`，Windows GVP-0、GVP-1–5、89 条格式双平台准入、签名 Chunk 和正式应用集成也尚未完成，因此 Production Implementation Admission 和 Universal Viewer 发布仍为 `NO_GO`。

## 1. 决策摘要

| 决策层 | 当前结果 | 边界 |
|---|---|---|
| 产品方向 | 已确认 | 内部 Viewer 承担默认只读打开；WpsComposer/WPS 保留生成、编辑和终验职责 |
| 权威迁移 | 完成 | Viewer 当前权威唯一，历史 WPS-authoritative Viewer 证据已排除 |
| Frozen Core 候选 | `GO` | 零 patch、零禁用运行时边、零可达 moderate-or-higher 漏洞 |
| GVP-0 macOS 15 | `BLOCKED_ENVIRONMENT` | 当前主机为 macOS 26.6.2，不得冒充 `macos-15-arm64` 产生 receipt |
| GVP-0 Windows | 未实现/未执行 | 已锁定官方 Node/npm Windows 发行树哈希，但 Windows 隔离构建器和 win32/x64 baseline 尚未实现；之后仍需 Windows 11 x64 真机 receipt |
| GVP-1–5 | `RESEARCH_REQUIRED` | 不得由 GVP-0 或 parser smoke 抵扣 |
| 格式准入 | 0 条 | 89/89 记录仍需双平台完整 receipt |
| 生产实施/发布 | `NO_GO` | PoC Chunk 未签名且 `production_loadable=false`，正式前后端应用尚不存在 |

当前没有可计入准入的 GVP-0 receipt；候选构建 `GO` 不能抵扣目标平台 Gate。

## 2. 冻结来源与零修改边界

| 项目 | 精确值 |
|---|---|
| upstream | `https://github.com/battlecook/omni-viewer-core.git` |
| version / commit | `0.16.0` / `ffdcda3eea83527380996ac935605f1422e43d3b` |
| Git tree | `37ed0235fb0da0124d51e5815def4f832b3724d2` |
| archive/source tree SHA-256 | `1e0681afd02d7b6887bb373d5256eabcab69f8ac3015aa8372dd5e0754cc698d` |
| materialized tree SHA-256 | `3723711a6c59fecd24a48e7d5abb031809e8532f12e7d68d21a5bc1b25dd95cc` |
| patch ledger | `patches: []`；pre/post tree 均为上述 source tree |

只构建 `viewer-base` 和 `viewer-office`；`viewer-media`、`viewer-data`、`viewer-specialized` 保持 `planned_not_built`。Office 闭包改用只读 `mountPptDocument`，不再引入 `mountPptViewer` 的 PDF 编辑 fallback；上游源码仍零修改。

## 3. 当前候选证据

| 证据 | 结果 |
|---|---|
| admission decision | `GO`，`patches=0`，`forbidden_runtime_edges=0`，`moderate_or_higher=0`，`chunks=GO` |
| admission SHA-256 | `537016d2119e530559026fd223a3be6f28bfff6ad4c2f659e154d19fc57dad5e` |
| build provenance SHA-256 | `2be7c1c42e6cf37c1aea4ecbe4786c53e3c3ec4f7ff89f2b870c23cc95d370d7` |
| built source policy SHA-256 | `732b181c78cfe45fca079474a853cd2fe8e8e0960841dde617c26a3e54832a7d` |
| module graph SHA-256 | `3d1a91e909e60b591ebf043a71df06d866d0072dbb96a67312404f33c39cdc46` |
| 14-artifact index SHA-256 | `c88ff214500a76fcb5ec9826d4e72d50d852618c5b4ac303c77e954566716e40` |
| CycloneDX 1.5 SHA-256 | `69bc02cb9cee011d2fb7ba5849b46787bbe5da49eee2baafd87e57bbc0d73746` |
| 两份 audit | info/low/moderate/high/critical/total 均为 `0` |
| chunk 包体 | base `3,535` gzip bytes；office `165,273`；合计 `168,808` |

17 个精确 runtime 组件均有非空许可证据，无 unknown/GPL/AGPL 组件被当成允许项。无 LibreOffice/soffice，也没有 WPS/WpsComposer Viewer fallback。

## 4. 工具链、隔离与发布事务

候选构建不再从 `PATH` 解析 npm：

- macOS arm64 Node 24.18.0 executable SHA-256：`bf0cea6a...197f`；
- macOS npm 11.16.0 完整 1,916 文件树 SHA-256：`0434cdfe...0e5`；
- Windows x64 Node 24.18.0 executable SHA-256：`9a4eb5f1...52de`；
- Windows npm 11.16.0 完整树 SHA-256：`8f6d14c6...ecdde`。

构建、SBOM 和 audit 全部由内容定址的 Node 执行绝对 npm CLI，执行前后重算身份。macOS 候选测试/构建运行在 Seatbelt default-deny 内，禁止网络、主机 Home 和兄弟临时目录访问。子进程收容使用 OS 继承的 sandbox 指纹；编译 helper 时固定一次解析的 Clang 和 SDK，执行前后核对 hash，provenance 绑定 Clang、SDK Settings、helper 与源码身份。

`dist` 和 `baseline-evidence` 先写 staging，递归 fsync 后再使用同一准入域 journal 进行事务提升；长构建期间持有独立 build-domain 锁，因此后续构建可在确认无活动 owner 后回收 journal 产生前遗留的 marker-owned staging。跨进程锁由已 fsync 的同目录 candidate 通过原子 hard-link no-replace 发布，其他进程不会看到空或部分 owner 文档。GO/NO_GO 或是否持久化 baseline 变更时，都会在新构建开始前恢复旧 prepared/committed 状态并清理中断 staging。

## 5. Office 和恶意输入表征

| fixture | 字节 / SHA-256 | 观察结果 |
|---|---|---|
| `smoke.docx` | `1,624` / `7d2ea45e...3b1e` | mount `ready`，DOM 含 `Universal Viewer DOCX Smoke` |
| `smoke.pptx` | `2,448` / `488ccfd0...6821` | parse `ok`，1 slide / 1 element，mount `slides` |

这仅证明命名 PoC fixtures 在记录限额下被解析，不等于对外宣称已支持 DOCX/PPTX 全格式。恶意 corpus 真实子 worker 验证网络尝试、外部进程、源修改、路径暴露、超界写入均为 0；挂起 worker 会被硬截止。

## 6. GVP-0 macOS 15 最新实际结果

```bash
./scripts/poc/run-gate.sh gvp-0 \
  --platform macos-15-arm64 \
  --fixture GVP-0-CORE-001 \
  --candidate-root "$PWD/scripts/poc/universal-viewer/.candidate/source"
```

- run id：`20260904T155600337Z-58606-b35f94361ff0d63772ccae08`；
- 实际主机：macOS `26.6.2` / build `25G83` / arm64；
- CLI：`GVP0_PLATFORM_MISMATCH`，`BLOCKED_ENVIRONMENT`，exit `2`；
- receipt：无；evidence SHA-256：不可用；
- repository-reviewed bundle：`fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/20260904T155600337Z-58606-b35f94361ff0d63772ccae08`，index SHA-256：`23fa55948cf024b068b674db8bd7653d54fc4bc329530e492f96b92cd9ea59cf`。

之前的 `macos-15-arm64` GO receipt 由仅检查 `darwin/arm64` 的旧映射在 macOS 26 主机上产生，不得继续作为 macOS 15 准入证据。新 Gate 必须绑定 `sw_vers` 主版本/build；Windows 必须通过 CIM、Node OS kernel release/version 以及固定系统路径 PowerShell 内对 Win32 `IsWow64Process2` 的调用，交叉证明 Windows 11 workstation、精确 build 与 native machine AMD64，并将原生架构绑入 run-context；不接受 ARM64 上的 x64 Node 仿真、环境中的 `SystemRoot` 重定向或伪造单一信号。

## 7. 完成度审查

| 任务 | 状态 |
|---|---|
| Frozen Core 精确获取/零 patch | 完成 |
| base + Office 只读切片、许可、SBOM、实时 audit、可达图 | 完成 |
| macOS 15 GVP-0 | 阻塞：当前主机为 macOS 26.6.2，最新公共路由 exit `2`、无 receipt |
| Windows GVP-0 | 未实现：先实现 Windows 隔离构建和独立 win32/x64 baseline，再于 Windows 11 x64 真机运行 |
| GVP-1–5 | 未完成，按权威保持 `RESEARCH_REQUIRED` |
| 89 条格式准入 | 未完成，不从 GVP-0 推断 |
| 正式 SuperWagie 前后端/UI 集成 | 未完成；仓库当前只有原型、合同、测试 harness 和 PoC |
| 签名/打包/发布 | 未完成，不得宣称生产就绪 |

## 8. 准入边界与下一步

1. 在 macOS 15 arm64 真机使用锁定发行树运行 GVP-0；Windows 路径须先实现并审查 Windows 隔离构建器、生成独立 win32/x64 baseline，再在原生 Windows 11 x64 真机上产生 receipt。不得复用 darwin/arm64 baseline。
2. 逐一完成 GVP-1–5，不将 parser smoke 当成性能、恢复、下载或签名门的替代证据。
3. 为目标格式累积双平台 corpus receipt；只有 ledger 更新后才能宣称格式支持。
4. 正式实施仍必须保持 handle-only、read-only、无 path/网络/子进程/写回；WpsComposer 仅保留生成、编辑和显式终验职责。
