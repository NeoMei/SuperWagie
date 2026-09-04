# Universal Viewer Frozen Core 准入报告

> 日期：2026-09-04
> 结论：Frozen Core 候选 `NO_GO`；GVP-0 macOS `BLOCKED_ENVIRONMENT`、无 receipt；Windows 缺失；GVP-1–5 和 89 条格式记录均为 `RESEARCH_REQUIRED`；生产实施和 Universal Viewer 发布均 `NO_GO`。

## 1. 决策摘要

| 决策层 | 当前结果 | 含义 |
|---|---|---|
| 产品决策 | 已确认 | 保持“冻结 Core + SuperWagie 自有宿主”设计，不等于技术准入 |
| 权威迁移 | 完成 | Viewer 当前权威唯一，历史 WPS-authoritative Viewer 证据被排除 |
| Frozen Core 候选 | `NO_GO` | PPT mount 静态到达 PDF fallback 中 8 个 write/save/file-pick 禁止引用 |
| GVP-0 macOS | `BLOCKED_ENVIRONMENT` | 仓库审查后的环境失败观测记录 exit `2`；无 receipt，不独立证明 wall clock |
| GVP-0 Windows | 缺失 | 无 `windows-11-x64` 运行或 receipt |
| GVP-1–5 | `RESEARCH_REQUIRED` | 未执行，不可由 GVP-0 或 parser smoke 抵扣 |
| 格式准入 | 无 | 89/89 记录 `RESEARCH_REQUIRED`，0 条完整 receipt 引用 |
| 生产 Viewer 实施 | 禁止／未开始 | Production Implementation Admission = `NO_GO` |
| Universal Viewer 发布 | `NO_GO` | 无格式或 GVP 聚合可发布 |

Completion Definition 第 4 项和第 6 项明确未满足：候选不是零禁止边，GVP-0 也未产生 schema-valid、hash-bound、platform-scoped receipt。下一份计划应是修订后的 Frozen Core 整改计划：在上游或受审查的候选切片中移除／隔离 PDF fallback 及写权限闭包，再重跑 GVP-0；不得假设已准入而进入 Viewer Foundation。

## 2. 冻结来源与可复现性

| 项目 | 精确值 |
|---|---|
| upstream | `https://github.com/battlecook/omni-viewer-core.git` |
| version / commit | `0.16.0` / `ffdcda3eea83527380996ac935605f1422e43d3b` |
| Git tree | `37ed0235fb0da0124d51e5815def4f832b3724d2` |
| archive/source tree SHA-256 | `1e0681afd02d7b6887bb373d5256eabcab69f8ac3015aa8372dd5e0754cc698d` |
| materialized tree SHA-256 | `3723711a6c59fecd24a48e7d5abb031809e8532f12e7d68d21a5bc1b25dd95cc` |
| source lock SHA-256 | `ad893a131981d9842e6eb751bf24513e123f357530f6d6ade51e3261eace6ed6` |
| patch ledger SHA-256 | `7c13a791a8cf1c58263d5c4c3b84ba8a899c1042177c7b311c98bb5b99bc265f` |
| patch 结果 | `patches: []`；pre/post tree 均为 `1e0681...698d` |
| PoC lock | lockfile v3，SHA-256 `d03ef959af78bb3ed2348cf402a83ddc9d63463acb68370ff9c98246a6993f9f` |
| dependency inventory | SHA-256 `e0e5233f02f06cad26af1eedf7b9b076925a1112a79122033422eb056a53848e` |
| toolchain | Node `24.18.0`，npm `11.16.0`，Git `2.50.1 (Apple Git-155)`，darwin/arm64，`rolldown@1.1.5` |

冻结源目录的 `git status --porcelain=v1` 无输出，当前 tree 仍为上表值。候选仅从精确 commit 获取，拒绝 tag/branch 漂移、symlink、submodule、脏树、remote 替换和 lock 漂移。

## 3. 所选切片、许可证、SBOM 和包体

只构建 `viewer-base` 和 `viewer-office`；`viewer-media`、`viewer-data`、`viewer-specialized` 均未构建。可执行闭包审计 33 个 Frozen Core 源模块。

| Chunk | installed bytes | gzip bytes |
|---|---:|---:|
| `viewer-base` | 7,588 | 3,535 |
| `viewer-office` | 699,897 | 197,053 |
| 合计 | 707,485 | 200,588 |

合计低于 base+office 20 MiB 和全 Chunk 50 MiB 上限。Chunk audit 为 `GO`，但两个 manifest 均是 `poc_unsigned_not_loadable`、`production_loadable=false`，signature 是保留 sentinel，不能伪装成生产 Chunk。

CycloneDX 1.5 SBOM 由 npm `11.16.0` 执行 `npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx` 生成；SHA-256 为 `69bc02cb9cee011d2fb7ba5849b46787bbe5da49eee2baafd87e57bbc0d73746`。其 17 个精确 runtime 组件均有非空许可证证据：`base64-js@1.5.1`、`buffer@6.0.3`、`core-util-is@1.0.3`、`docx-preview@0.3.7`、`ieee754@1.2.1`、`immediate@3.0.6`、`inherits@2.0.4`、`isarray@1.0.0`、`jszip@3.10.1`、`lie@3.3.0`、`pako@1.0.11`、`process-nextick-args@2.0.1`、`readable-stream@2.3.8`、`safe-buffer@5.1.2`、`setimmediate@1.0.5`、`string_decoder@1.1.1`、`util-deprecate@1.0.2`。JSZip 按 MIT 选项准入；无 unknown/GPL/AGPL 组件被当成允许项。Office manifest 另绑定 Core MIT 和 runtime license inventory，因此 `license_refs` 为 19。

许可证标识精确为：13 个 MIT，`docx-preview` 为 Apache-2.0，`ieee754` 为 BSD-3-Clause，`inherits` 为 ISC，`pako` 为 MIT AND Zlib；`jszip` 的二选一表达式按 MIT 路径履约。

对 Office Chunk，直接 runtime 身份为 `buffer@6.0.3`、`docx-preview@0.3.7`、`jszip@3.10.1`；其余 14 个为 lock/SBOM 内的精确传递闭包。

固定 baseline 的两份生产依赖审计均记录 info/low/moderate/high/critical/total = `0`，原始 JSON 哈希为 `c1103db1b24f40720b44abdd22591cd934f6e3f8c2824c39b0ee811c08c5cf93` 和 `6c7cd94ccc096ab3e36d401d06349a4d9e9f2872c02680c67f918accd80dda8e`。它们是固定候选的表征证据，不替代最新 GVP-0 的实时公告 freshness；后者本次超时，因此无当前有效 receipt。Obsidian host commit `1db3137806dc4047513f6abd2ec010030e5029a2` 中 DOMPurify `GHSA-55q2-fjhq-7xh7` 和 Mermaid 5 条公告以 `host_not_imported`/`reachable: false` 排除；后续 Diagram Gate 义务仍保留。

## 4. 负向准入结果

`mountPptViewer` 的 PPT mount 路径静态 import 并调用 PDF fallback，使 `src/viewers/pdf/index.ts` 和 `editing.ts` 进入可达图。策略在 `src/viewers/pdf/index.ts` 录得 8 个禁止引用：`pickFile` 1 个、`saveFile` 1 个、`writeback` 6 个。因此：

- admission decision `NO_GO`，SHA-256 `3218b137b6cf8efa8804edf8935c5f20e0be9488f654ff9117490a136e3a98da`；
- built policy SHA-256 `9acdd9301d57bc435e0f917f45041946680fcf082b1282fbc7612b0a33034c41`，module graph `884a4933f22142cd752cd324a3942baacd4a5b3ae387447b579cd14067d18980`；
- 14-artifact evidence index SHA-256 `254128be2c3530f208306c284c6baf3727d8169842ce0efd93f4a8d0db4a932a`；
- build provenance `bf344e38f013f0e8d45bb29b3a5d34cc3a1133a63a9f207c36daf19cb412e30a`；base/office manifests `984aab89146ae4f217bbc07e8ee341d676fb6d276ec291a9e9fa1be2c487ad17` / `128efd075a45550eab6aa4c89ef46e67f664d26c1d2294ed390e03fb37e255e3`；Chunk audit `5558c5149b912bb91f40f728ff4a9aa14f3fbb82e5e7051693975c7efbb82ae9`。

包体、许可证和固定审计合格都不能覆盖“禁止能力可达”的拒绝规则。

## 5. 解析、Host Adapter 与恶意输入的边界

本报告的精确声明是：**the pinned candidate parsed the named PoC DOCX/PPTX fixtures under the recorded limits**。这不是“支持 DOCX/PPTX”的对外声明：

| fixture | 字节 / SHA-256 | 观察结果 |
|---|---|---|
| `smoke.docx` | 1,624 / `7d2ea45e5397ac32da8929559067040c928b37cd8823845b46a08b9e89e43b1e` | mount `ready`，DOM 含 `Universal Viewer DOCX Smoke` |
| `smoke.pptx` | 2,448 / `488ccfd0ba8df0be57d7640d27e38954f7369359bb46716084d69646d5506821` | parse `ok`，1 slide / 1 element，mount `slides`，文本 `Universal Viewer PPTX Smoke` |

Host Adapter 只表征 handle-only/read-only 窄缝：输入无 path，可枚举面为 `open/readAll/readRange/isCancelled/reportDiagnostic/createEphemeralAssetUrl/revokeEphemeralAssetUrl`，对未处理特性、fallback font 和不可验证字段强制 `partial`，不允许 `ready`。它不消除候选图中的 8 个禁止引用。

六个本地恶意 fixtures 的单项行为均通过：观察到 Viewer 外部子进程 `0`、网络尝试 `0`、新建路径 `0`、路径暴露 `0`、源变更 `0`、可达 moderate-or-higher 漏洞 `0`、未预期结果 `0`；但聚合结论仍是 `NO_GO / forbidden_runtime_edges=8`。截止探针记录 `timed_out=true`、`killed=true`、子进程和已知后代存活数均为 0。macOS `/bin/ps` 采样不能证明一个在首次观察前已脱离并退出的进程从未存在；Windows 仍需 CIM/Job Object 证据。

表征限额：检测 1 MiB，输入 256 MiB，单条目 128 MiB，总解压 512 MiB，10,000 entries，嵌套 8，压缩比 100:1，XML 深度 128 / 250,000 nodes，页/幻灯片 5,000，sheets 1,024，图像 100 MP，动画帧 10,000，表格 50,000 cells，单行/XML text 8 MiB，worker RSS 768 MiB，首内容 15 s，解析 60 s。PoC corpus 对 hung worker 使用 250 ms startup-inclusive hard deadline。常量和 in-process adapter 不能证明 RSS、inflate-time 或首内容的生产硬上限；这些仍是 GVP-3/4 缺口。

## 6. 最新 GVP-0 macOS 仓库审查观测

```bash
./scripts/poc/run-gate.sh gvp-0 --platform macos-15-arm64 --fixture GVP-0-CORE-001 --candidate-root "$PWD/scripts/poc/universal-viewer/.candidate/source"
```

观测 run id 为 `20260904T035944401Z-76821-7c4310d8b16abc8f39a59241`，记录时间戳 `2026-09-04T03:59:44.402Z`–`03:59:59.560Z`，exit `2`，原因精确为 `GVP0_LIVE_AUDIT_UNAVAILABLE: poc-production-audit did not complete within the bounded environment contract`。脱敏后的 9-artifact bundle 已收录到 `fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/20260904T035944401Z-76821-7c4310d8b16abc8f39a59241/`，其 `index.json` SHA-256 为 `34863bd531a7d6c081f4b80f4222634b5687d2ae9be3d473e1f758d6ac716c49`。这是 repository-reviewed observation：用于表示 `BLOCKED_ENVIRONMENT`，不是验收失败，不是 GO，也不是 receipt。

| artifact | SHA-256 |
|---|---|
| `manifest.json` | `dc8dd65268a5816f26ae864e9850361aeba72626f6baf5089134559224e20ba8` |
| `environment.json` | `4edba82a7eaa02e037da067d376db9042d0943d2a5646a01c35c140ac50968f4` |
| `command.txt` | `e87f0c1156934e2254d4b5d150fddab497e13728ee35f7f62cdd41f81fe73f49` |
| `stderr.log` | `946561dc1d1c9f243b6c371e5069df2232d879d8b08d0f59d48635f380508b1d` |
| `decision.md` | `5be0fd692ede5df712b2cc4e04884edf9b66df0051553a32f134e3cfb51cef23` |
| `stdout.log`、`results.json`、`artifacts/evidence-manifest.json`、`artifacts/acceptance-summary.json` | 空文件 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

空 `results.json` 不是 receipt；状态中 `receipt` 为 `null`。更新器只消费上述受版本控制的 reviewed bundle，并校验 index 自身哈希、逐文件哈希，schema/gate/fixture/run-id、`macos-15-arm64`↔`darwin/arm64` 身份、精确命令、exit-2 原因、draft decision 和空 receipt 保留文件。它不扫描 ignored `evidence/` 来升级状态；新 runner 观测必须先脱敏、复制、生成 index 并经仓库审查。记录的时间戳不能独立证明 wall-clock 耗时，更新器不再以自报时长区分真实与 synthetic。

目录 inventory 同时 fail closed：所有 Git-tracked 直接子 bundle 候选都必须有安全时间戳 run-id 并通过全量校验。任一新旧候选的类型、index、哈希、schema 或 identity 无效都会以 `INVALID_TRACKED_GVP0_ENVIRONMENT_ATTEMPT` 阻断审计，且状态不写入；不会过滤无效新包后回退到旧包。根目录普通 README/文档不是候选，symlink、嵌套和非时闳命名别名均被拒绝；当前未定义 superseded marker。

因为本次没有 receipt，receipt SHA-256 也不存在；上表是环境尝试的 artifact 哈希，不是 receipt 哈希。

## 7. 新鲜验证和边界保留

- Contract Foundation `npm ci`：7 packages / 0 vulnerability；`npm test` = 355/355。
- Universal Viewer reviewer-round-1 fresh offline `npm ci`：90 packages，0 vulnerability；这不是生产闭包 audit，不替代 GVP-0 的两份生产 audit 或 receipt。
- `npm_config_offline=true`、Node `--test-concurrency=1`、Vitest min/max worker = 1 的最终 UV 全套 = 111/111，62.333 s。
- evidence runner/status 集成 = 47/47；status updater 聚焦 = 32/32；authority 聚焦 = 7/7。
- authority `current=29 historical=4`；ledger `records=89 extensions=96`；history markers `4`；Contract 内 Viewer 相关套件 19/19。
- Public Capability Facade 仍是 34 个 active methods / 68 个 schema URI；没有新增内部 Viewer Open/Query，`wps.render_preview` 仍是不可调用的退役记录。
- 状态投影：37 expected / 11 GO / 12 CONDITIONAL_GO / 0 NO_GO / 9 BLOCKED_ENVIRONMENT / 5 RESEARCH_REQUIRED / 0 invalid / 0 missing / 0 signed GO。Frozen Core 自身的 `NO_GO` 保留在候选 admission artifact，GVP 技术状态仍 `RESEARCH_REQUIRED`。

Format Admission Ledger 未改，SHA-256 仍为 `45dbac3e7160828f1221f318f7230bc703e7743d71b54b3227665160037d8c38`。无 LibreOffice/WPS/WpsComposer Viewer fallback。WpsComposer 的 DOCX/PPTX 生成、格式化和结构化修改职责保留；最终目标应用 smoke 仍是用户显式授权的独立交付验收，不返回 Viewer 打开热路径。

## 8. 下一步

1. 先确认 Frozen Core 整改边界：移除 PPT→PDF fallback 的静态可达性，或将 PDF 只读渲染与 write/save/file-pick 编辑能力分割为不可达闭包。
2. 对整改后的精确 commit/patch 重做源、许可证、SBOM、实时公告、可达图、Chunk 和恶意输入审计，不继承本次 `NO_GO`。
3. macOS 网络可用时重跑公开 GVP-0，Windows 11 x64 按交接清单运行同一整改候选。
4. 只有 GVP-0 产生双平台完整绑定 receipt 后，才能重新选择设计 §15.3 的后续切片；GVP-1–5、格式双平台准入、签名包和发布门仍需各自证据。
