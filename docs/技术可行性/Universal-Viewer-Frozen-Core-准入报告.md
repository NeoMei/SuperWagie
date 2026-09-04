# Universal Viewer Frozen Core 准入报告

> 日期：2026-09-04
> 当前结论：Frozen Core 窄切片候选 `GO`，macOS GVP-0 `GO`；但 Windows GVP-0、GVP-1–5、89 条格式双平台准入、签名 Chunk 和正式应用集成尚未完成，因此 Production Implementation Admission 和 Universal Viewer 发布仍为 `NO_GO`。

## 1. 决策摘要

| 决策层 | 当前结果 | 边界 |
|---|---|---|
| 产品方向 | 已确认 | 内部 Viewer 承担默认只读打开；WpsComposer/WPS 保留生成、编辑和终验职责 |
| 权威迁移 | 完成 | Viewer 当前权威唯一，历史 WPS-authoritative Viewer 证据已排除 |
| Frozen Core 候选 | `GO` | 零 patch、零禁用运行时边、零可达 moderate-or-higher 漏洞 |
| GVP-0 macOS | `GO` | 已产生 schema-valid、hash-bound、platform-scoped receipt |
| GVP-0 Windows | 未执行 | 已锁定官方 Node/npm Windows 发行树哈希，仍需 Windows 11 x64 真机 receipt |
| GVP-1–5 | `RESEARCH_REQUIRED` | 不得由 GVP-0 或 parser smoke 抵扣 |
| 格式准入 | 0 条 | 89/89 记录仍需双平台完整 receipt |
| 生产实施/发布 | `NO_GO` | PoC Chunk 未签名且 `production_loadable=false`，正式前后端应用尚不存在 |

`GVP-0 GO` 只证明可以继续后续准入研究，不是生产发布授权。

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
| build provenance SHA-256 | `12030a57d80df8fdb31f059b3a37cad84dec6308705f7b9bd5e144dc225c1fa1` |
| built source policy SHA-256 | `732b181c78cfe45fca079474a853cd2fe8e8e0960841dde617c26a3e54832a7d` |
| module graph SHA-256 | `3d1a91e909e60b591ebf043a71df06d866d0072dbb96a67312404f33c39cdc46` |
| 14-artifact index SHA-256 | `6ed3f38848b790e684ffe5665417c0e363402ff2e3e733b944d89381377352e6` |
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

构建、SBOM 和 audit 全部由内容定址的 Node 执行绝对 npm CLI，执行前后重算身份。macOS 候选测试/构建运行在 Seatbelt default-deny 内，禁止网络、主机 Home 和兄弟临时目录访问。子进程收容使用 OS 继承的 sandbox 指纹，而非环境 token；“立即孤儿化 + 清空环境 + 新 session”子进程无存活，且无关进程未被误杀。

`dist` 和 `baseline-evidence` 先写 staging，完整校验后再使用多根事务提升；异常重命名会回滚，持久化 journal 用于下次运行恢复 SIGKILL/断电留下的 prepared/committed 状态。

## 5. Office 和恶意输入表征

| fixture | 字节 / SHA-256 | 观察结果 |
|---|---|---|
| `smoke.docx` | `1,624` / `7d2ea45e...3b1e` | mount `ready`，DOM 含 `Universal Viewer DOCX Smoke` |
| `smoke.pptx` | `2,448` / `488ccfd0...6821` | parse `ok`，1 slide / 1 element，mount `slides` |

这仅证明命名 PoC fixtures 在记录限额下被解析，不等于对外宣称已支持 DOCX/PPTX 全格式。恶意 corpus 真实子 worker 验证网络尝试、外部进程、源修改、路径暴露、超界写入均为 0；挂起 worker 会被硬截止。

## 6. GVP-0 macOS 最新实际结果

```bash
./scripts/poc/run-gate.sh gvp-0 \
  --platform macos-15-arm64 \
  --fixture GVP-0-CORE-001 \
  --candidate-root "$PWD/scripts/poc/universal-viewer/.candidate/source"
```

- run id：`20260904T142432300Z-59012-8f913b9e4c94f94d4ddce647`；
- CLI：`GVP0_ACCEPTED`，verdict `GO`，exit `0`；
- receipt id：`gvp0-core-macos-15-arm64-44fb94dc1c8ba695`；
- receipt SHA-256：`47b5086c28d157e3bb3a4bf6c2c684b91b3949253cd885084f8b5d3e746cd001`；
- evidence SHA-256：`44fb94dc1c8ba695600a275a503373ec861b40f09166745551ad1c974cdb0978`。

`acceptance-summary.json` 仍明确 `production_registry_admitted=false`、`production_chunk_signed=false`、`release_admission=NO_GO`、remaining gates = GVP-1–5。

## 7. 完成度审查

| 任务 | 状态 |
|---|---|
| Frozen Core 精确获取/零 patch | 完成 |
| base + Office 只读切片、许可、SBOM、实时 audit、可达图 | 完成 |
| macOS GVP-0 | 完成，`GO` receipt |
| Windows GVP-0 | 阻塞：需 Windows 11 x64 真机运行 |
| GVP-1–5 | 未完成，按权威保持 `RESEARCH_REQUIRED` |
| 89 条格式准入 | 未完成，不从 GVP-0 推断 |
| 正式 SuperWagie 前后端/UI 集成 | 未完成；仓库当前只有原型、合同、测试 harness 和 PoC |
| 签名/打包/发布 | 未完成，不得宣称生产就绪 |

## 8. 准入边界与下一步

1. 在 Windows 11 x64 使用官方 Node 24.18.0/npm 11.16.0 发行树运行同一 GVP-0，产生 Windows receipt。
2. 逐一完成 GVP-1–5，不将 parser smoke 当成性能、恢复、下载或签名门的替代证据。
3. 为目标格式累积双平台 corpus receipt；只有 ledger 更新后才能宣称格式支持。
4. 正式实施仍必须保持 handle-only、read-only、无 path/网络/子进程/写回；WpsComposer 仅保留生成、编辑和显式终验职责。
