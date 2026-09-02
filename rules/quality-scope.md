# 规则包：验收基线与范围纪律（quality-scope）

适用范围：差分验收、真实宿主验收、安全回归、故障注入、性能基准、V1 暂缓项与范围变更。

## R-QS-01 差分验收

Reference 与 Private Capability 用同一差分 runner 验收：非确定性结果给容差、视觉差异量化、fixture 可重复；不一致即阻止发版。[WD §10.2] [TEST-01]

## R-QS-02 真实宿主验收

PPT 用真实 WPS/PowerPoint、文档用真实 WPS、HTML 用真实浏览器、Markdown 用 Obsidian 对照 Vault 验收；自动化覆盖不到的平台组合留下人工证据；不以近似渲染顶替视觉事实。[WD §13.4] [WD §13.5] [V1RS §2] [TEST-02]

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

## R-QS-08 fallback 不删闭环

已确认 fallback（并排 WPS Review、WPS 受控副本编辑、外部宿主缺失时禁用对应能力）只替换技术表现方式，不删除用户完成工作的闭环；Electron 已是唯一首选壳，不再是 fallback，也不允许静默切换 Tauri/System WebView；壳层 Gate 失败时阻止发布并重新裁决架构。启用其他 fallback 必须记录触发证据。[V1RS §3] [BCRA §18] [WD §13.5]
