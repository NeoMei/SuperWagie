# 规则包：验收基线与范围纪律（quality-scope）

适用范围：差分验收、真实宿主验收、安全回归、故障注入、性能基准、V1 暂缓项与范围变更。

## R-QS-01 差分验收

Reference 与 Private Capability 用同一差分 runner 验收：非确定性结果给容差、视觉差异量化、fixture 可重复；不一致即阻止发版。[WD §10.2] [TEST-01]

## R-QS-02 Viewer Gate 与目标应用 smoke 分离

Universal Viewer 按每格式 Corpus、Office 差分、恶意样例、独立性、包体/性能和恢复证据通过 GVP-0–5；研发差分可使用目标 Office 截图参考，但运行路径不依赖该宿主。最终 PPT/DOCX 仍按用户选定的 WPS/PowerPoint 执行可选编辑、撤销、保存/放弃和重开 smoke；HTML/Markdown 仍用真实浏览器/Obsidian 对照验收。[WD §13.4] [VIEWER §12] [V1RS §2] [TEST-02]

## R-QS-03 安全回归

沙箱逃逸、恶意文件、越权路径、非授权网络、Prompt 注入与 Artifact 投毒样例进入回归集；每次发布前全部通过。[TEST-03]

## R-QS-04 故障注入恢复

崩溃、断电、外部编辑、同步冲突与部分成功用 fault injection 验证 journal 与恢复语义；恢复后不得重复扣费、覆盖已验收 Artifact 或静默丢内容。[WD §12] [TEST-04]

## R-QS-05 性能基准回归

包体积、启动、内存与长任务基准在可重复硬件与数据集上回归，阈值超标必须给出解释或回归修复，不允许无记录劣化。[TEST-05]

## R-QS-06 暂缓项纪律

云同步/实时协作/CRDT、完整知识图谱与高级向量检索、Skill Store 生态、完整 Obsidian Plugin API、draw.io 在线协作、复杂企业预算治理、本地模型、系统日历双向同步、全量历史 Rust 重写共九项 V1 明确暂缓；实施中不得以任何形式搭车引入。[V1RS §4] [DEF-01] [DEF-02] [DEF-03] [DEF-04] [DEF-05] [DEF-06] [DEF-07] [DEF-08] [DEF-09]

## R-QS-07 范围变更规则

把 V1_REQUIRED 改为 DEFERRED 属产品范围变更，必须获得明确产品确认；DEFERRED 重新纳入必须补技术矩阵 ID、风险、PoC、fallback 与发布影响；V1_REQUIRED 可以同时是 RESEARCH_REQUIRED，含义是阻止发布而非技术已被证明。[V1RS §1] [V1RS §6]

## R-QS-08 Viewer 不达标阻止发布

Viewer 格式或 GVP Gate 不达标时必须阻止对应支持模式与 V1 聚合发布，只能降级为已声明的安全文本/十六进制/元数据或 `unsupported`，不能启动外部转换器补位。WPS 受控副本和真实目标应用 smoke 只保留为交付闭环；Electron 壳 Gate 失败仍阻止发布并重新裁决架构。[V1RS §3] [BCRA §18] [VIEWER §12.5]

## R-QS-09 可选平台不反向塑造架构

V1 必须平台只有现代 macOS 与 Windows 11。Ubuntu/Linux 只是 V1 后的 best-effort 可选打包目标；不得为它引入第二桌面壳、System WebView fallback、第二 Product Core、额外 Runtime 发现分支，也不得降低 macOS/Windows 的安全与验收门槛。Ubuntu/Linux 不支持不阻塞 V1。[V1RS §1.1] [BCRA §1]
