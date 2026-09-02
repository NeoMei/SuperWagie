# 规则包：Rust 化与打包发布（rust-packaging）

适用范围：第二阶段 Rust 迁移范围、迁移方式、安装签名升级、按需下载、SBOM 与闭源保护。

## R-RP-01 必须 Rust 化清单

Rust Product Core、Agent Runtime Adapter、Worker Supervisor、Durable Workflow/Effect Journal、Capability Router、权限/沙箱/Credential/Network/Host Broker、四层 Dependency Resolver、Workspace 文件事务与 CAS、Markdown 监听/索引/任务/SQLite、Artifact Registry、Checkpoint/Lease/幂等/Credits、Connector 生命周期与制品校验属于必须 Rust 化范围，不因迁移难度擅自降级为脚本形态。[WD §11.1] [BCRA §4] [RUST-01]

## R-RP-02 优先 Rust 化与等价闸门

SessionReviewer 核算、AgentWiki 同步核、SuperPPT/SuperWriter 状态机、图片处理、可编辑 PPTX 预处理、WPSComposer 解析与校验、绘图结构化操作优先迁移；迁移遵循冻结 Reference → 相同 Contract 实现 Rust Executor → 双跑 → 比较状态/文件/Artifact/视觉/恢复 → 等价后切换默认执行器 → 移除多余 Runtime，附差分测试与回滚方案。[WD §11.2] [WD §11.4] [RUST-02]

## R-RP-03 生态层保留

Excalidraw 与 draw.io 编辑器保留签名静态 Web 实现，经隔离 `diagram_editor` Surface 运行；renderer 不暴露 Node、任意文件系统或进程能力。Electron Main 只管理窗口、生命周期与窄 IPC；Rust Product Core 保持数据/策略权威，WPS/Office/COM/macOS JSAPI、FFmpeg、扩展和浏览器渲染分别留在隔离 Worker。Prompt、角色、阶段说明与评价标准保留为签名 Private Workflow IR，不硬编码进 Rust；质量达不到的专业格式库可暂留 Worker 逐步替换。[WD §11.3] [BCRA §4] [BCRA §7] [RUST-03]

## R-RP-04 收益必须用数据证明

不得仅凭语言替换宣称包体积或效率改善；发布报告必须记录安装包体积、冷启动、峰值内存、子进程数量与真实任务耗时的前后数据，并有可重复硬件、数据集与阈值。[WD §11.4] [RUST-04]

## R-RP-05 安装、签名与升级

macOS 与 Windows 安装、notarization、code signing、Electron/Chromium/Node/Rust 兼容单元、Signed Runtime Image/Manifest、ASAR integrity/fuses、差分升级与回滚是发布工程必做项；升级失败必须能回滚到上一签名版本。[V1RS §5] [BCRA §12] [BCRA §17] [PKG-01]

## R-RP-06 大能力按需下载

只有明确标为 V1 可选、且不属于系统内置能力运行前提的大型能力可以走签名按需下载：断点续传、离线包、代理环境与版本兼容是验收项；下载产物校验通过后才启用对应能力。Electron/Chromium、编辑器、Electron Render Worker Host、内置 App Server、FFmpeg/codec、必要字体与内置能力 Runtime 不得套用本条，必须进入安装时 Signed Runtime Image。[V1RS §5] [BCRA §12] [PKG-02]

## R-RP-07 SBOM 与许可证合规

随包发布 SBOM 与第三方许可证清单，覆盖 Apache、MIT、GPL/AGPL、source-available 研究来源；NOTICE 与源码义务留档；HTML Taste 冻结快照保留上游 MIT 版权与许可文本，商用边界有结论后才能进生产。[TASTE §2] [PKG-03]

## R-RP-08 闭源保护边界

私有能力以资源加密与签名保护，但不承诺绝对不可逆；泄露模型与密钥管理的可接受边界写入发布文档；上游 Taste Skill 不以原始形态分发，只以转译后的 Policy IR 与冻结快照存在，用户不可见上游名称、路径与 Prompt。[TASTE §2] [TASTE §7] [PKG-04]
