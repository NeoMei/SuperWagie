# Universal Viewer main 整合与技术债清理报告（2026-09-05）

## 结论

`codex/universal-viewer-admission` 已在本地吸收 `origin/main@823ac801b5c4350e6d19ea84febcbbcd642012e9` 的 Windows 验证成果，并保持当前 Viewer 权威不变：Viewer 是 SuperWagie 内部只读能力，Office 预览走冻结、可审计、按格式准入的轻量运行时；WPS 仅保留在交付 Review/权威验收边界，不重新成为 Viewer 的运行时依赖；未引入 LibreOffice 或同等大体量组件。

本轮不改变 Production Implementation Admission。`GVP-0` 仍是无 receipt 的 `BLOCKED_ENVIRONMENT`，`GVP-1` 至 `GVP-5` 仍为 `RESEARCH_REQUIRED`，总体保持 `NO_GO`。这符合 R-DE-04、R-RI-01、R-RI-03、R-QS-01、R-QS-02、R-QS-04 与 R-QS-08。

## 已清理的整合债务

1. 合并冲突按双向保留解决：保留 Viewer 的六个 GVP、格式账本与严格限制，同时吸收 Windows 平台探测、Electron 44、Rust/原生边界和 Windows 证据逻辑；技术状态汇总重新从 37 个条目派生，未沿用不一致的旧数字。
2. Electron 44 npm 包不再被误认为自动准备好可执行文件。Solution B 增加显式、锁版本、校验和受 Electron 包约束的运行时准备步骤；缺少 npm 包或下载/解包失败会明确失败。
3. macOS 原生 `secure-fs` 模块在进入候选前移除 Mach-O 调试符号表，消除构建机绝对路径泄露；隐私扫描继续 fail-closed，没有添加放行项。
4. WPS Worker 修复短命进程在 `try_wait` 与进程组终止之间的 ESRCH/EPERM 竞态；只有在受管子进程于 50 ms 有界窗口内确已可回收时才接受，其他失败仍 fail-closed。
5. 进程树隔离测试不再把 `NODE_OPTIONS` 递归传给子 Node 形成进程爆炸；Unix 捕获器绑定 PID 启动身份，并在组长先退出后继续按固定 PGID 排空同组后代，避免漏检仍持有禁止路径的子进程，同时避免 PID 复用后误扫或误杀无关进程。
6. Workspace 10 万文件用例的外层 harness 时限扩为 300 秒，但 Gate 内部 60 秒冷启动阈值完全未放宽，避免繁忙主机上的夹具创建/清理开销制造假失败。
7. Windows Gate 3 系统探针统一绑定固定系统 PowerShell、最小环境和有界超时，Known Folder 从系统 API 读取；owned-tree 从仅记 PID 改为绑定 `PID + CreationDate`，超时终止前再次校验启动身份，消除环境重定向伪造、PID 复用误探测/误终止以及 PowerShell 卡死导致 Gate 永久悬挂的窗口。

## 验证结果

- Contract Foundation：355/355；Viewer authority/history/ledger：21/21。
- Universal Viewer：178/178，包含真实 DOCX/PPTX mount、恶意 OOXML/ZIP、网络/子进程隔离、取消与资源上限。
- Gate 3 UI：214/214，生产构建成功；Gate 3 Node 回归 169/169（另 1 项仅 Windows 原生执行项按平台跳过）；Markdown：14/14 单元测试、构建成功、1/1 真实 Electron 三模式交互。
- Solution B：21/21；Task 5：5/5；Task 6：13/13；Task 7：27/27；Presentation Service：8/8。
- Rust：四个 manifest 均通过 `cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings` 和 `cargo test --locked`；Reviewer Shell 为 25/25 + 91/91，Solution B Core 协议测试为 4/4。
- Python WPS worker：27/27；规格引用与 CRLF 回归：通过；技术状态审计：通过；Shell 语法与 Windows 静态合同：通过。
- 全仓松散 Node 测试：292 项中 289 通过、2 项按平台明确跳过、1 项因外部 SuperPPT checkout 不等于锁定 commit 而正确 fail-closed；该文件其余 17 项独立测试全部通过。
- 生产依赖审计：Viewer、Solution B、Markdown、Gate 3 均为 0 漏洞。Presentation 构建闭包仍被 npm 报告 `image-size` 两项 High DoS 且无非破坏性上游修复；已验证发布 Runtime bundle 不包含 `image-size`，不得把该构建依赖复制进产品 Runtime。

## 未被伪装成“已完成”的外部边界

- `/Users/neomei/项目/codexprojects/SuperPPT` 当前 HEAD 为 `1329a50239d24f2a0688bee1cacb9c378663e0e2`，而 G3-PPT 固定验证要求 `d7b2b1c515f6b385a41246d19fa74be99010dfb9`。本轮没有改锁、没有回退外部仓库，也没有让新旧实现静默混用。
- Exact macOS 15 arm64、签名安装候选、干净机矩阵、Owner/WPS/PowerPoint 人工真值以及外部正式服务仍需各自证据；这些是准入阻碍，不是可以用代码伪造的本地缺陷。

因此，本轮结论是“本地可修的整合技术债已清理并回归通过”，不是“Universal Viewer 已获生产准入”。
