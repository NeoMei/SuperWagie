# G3-WRITER-001 — 小型真实长文档

本 fixture 用固定 Markdown 和仓库内图片验证 SuperWriter → WPSComposer 的
DOCX/PDF 交付边界。通过条件同时包括：

- 七个业务阶段的可恢复 checkpoint 与三个关键人工门回执；
- 来源绑定、标题编号、目录、表格和插图；
- kill/restart 后不重复或丢失 Artifact；
- DOCX/PDF 结构与正文覆盖检查；
- 在真实 WPS 受控副本中完成打开、临时编辑、撤销、放弃、关闭和重开。

静态脚本、OOXML 包检查或另一个仓库的历史示例不能单独让本 Gate 通过。

## 人工回执导入边界

只有 `superwagie.g3-writer-human-receipt.v2` 才能关闭人工事实；旧 v1 仍可审计，
但不能产生 GO。collector 必须同时导入由实际生成流程产生的
`--generation-receipt <ABS_JSON>` 和可选的 `--human-receipt <ABS_JSON>`。
trusted collection 只接受 `superwagie.g3-writer-generation-receipt.v2`。该
exact-key schema 绑定 clean detached 的 SuperWriter/WPSComposer commit + tree、
生成 capability/version/参数 hash，以及按顺序列出的双仓执行闭包：
SuperWriter 入口和 WPSComposer runtime 都必须绑定 Git blob OID 与 SHA-256。
collector 直接从声明的不可变 Git tree 读取字节，并在所有 receipt/Artifact
读取后再次校验两个 snapshot；dirty、untracked、attached、中途变更或
worktree 替换均失败关闭。

WPS automation observation 必须是 v2，并绑定固定 WPS app 路径、bundle/version/build、
executable hash、codesign identifier、Team ID 和本次 session/run。WPS 版本不再接受
CLI 字符串声明；collector 会从已签名应用包独立读取并验证。human receipt v2 再将
renderer identity hash、session 与逐页 exact image evidence 绑定。PNG 必须通过
chunk 顺序、CRC、解压 scanline 和 IEND 完整性校验。trusted Writer
页面证据不接受 JPEG：当前没有纳入固定 Runtime 的可跨平台完整 JPEG decoder，
因此收集端必须先生成并提交完整校验的 PNG。声明的 media type/
width/height 必须与真实字节一致，WPS/页面截图还必须达到最小尺寸，
不同页不得复用同一张截图；文本、损坏或微型容器骨架会被拒绝。

七个 stage ID 依次为 `writer.content_ready`、`writer.requirements`、
`writer.top_outline`、`writer.chapter_writing`、`writer.illustrations`、
`writer.wps_composition`、`writer.rendered_review`；三个关键 Human Gate 是前
三个对应的稳定 ID。逐页视觉结论只承认与 PDF 页数一致的真实
WPS Office 回执；放弃、关闭、重开三项必须绑定同一受控副本 hash。
这些事实由 validator 逐项推导，不存在 CLI boolean 或 `owner_signed`
快捷方式；无回执时四项人工结果始终为 false，本 fixture 保持
`CONDITIONAL_GO`。只有 `superwagie.g3-writer-evaluation.v4` 及其 exact
`superwagie.g3-writer-collector-receipt.v5`、现场 clean source roots、generation v2
执行闭包与当前已签名 WPS identity 能进入 trusted 路径。collector receipt
只携带 signer ID 和 Ed25519 签名；公钥、平台范围与 active/revoked 授权固定在
`trusted-collector-signers.json` 的 gate 配置中，不得从 evaluation/receipt 注入。
当前配置没有已授权 signer；在有权主机签名材料正式配置前，真实运行只能
保持 `CONDITIONAL_GO`，不能猜测或自签提升为 GO。手写 v3 链不能产生 GO。
Gate 输出按 Artifact 文件、目录及父目录 fsync 顺序持久化，使用可恢复 transaction
marker、staging rename 和原子 result commit marker。Writer GO 必须列出全部已发布
Artifact 的相对路径与 SHA-256；状态审计在计算每个平台的 `platforms_go`、
`platforms_signed` 和最终 `signed_go` 前，必须分别重验该平台候选的 gate/fixture/
schema 与完整 Artifact 绑定；缺失、symlink、额外或 hash 漂移均失败关闭。
重复、并发、崩溃或重放写入不会覆盖既有 evidence。Owner 签署仍按统一 Gate
决策链独立完成，不属于本回执。
