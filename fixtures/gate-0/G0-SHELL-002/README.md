# G0-SHELL-002：Electron / bundled Chromium 桌面壳准入

> 状态：权威 fixture 与 fail-closed 预检 runner 已定义；签名构建和功能 runner 尚未实现，当前只能 `BLOCKED_ENVIRONMENT`，不得以旧 `G0-SHELL-001` 代签  
> Gate：gate-0  
> 所有者：Desktop Runtime + Security + Release Engineering  
> 平台：macos-15-arm64、windows-11-x64

## 1. 验证目标

证明 Electron + 随包 Chromium 能作为 SuperWagie 唯一桌面壳；Electron Main 是受审计但不拥有业务真相的 Shell Controller，Rust Product Core
是唯一业务、数据与策略权威，并在离线安装结束后具备 UI、绘图、Preview 与渲染 Worker 的全部
内置依赖。该 fixture 只建立架构准入证据，不进入生产模块。

## 2. 固定构建与输入

- 签名/公证的目标平台安装包与 Runtime Manifest；
- 固定 Electron/Chromium/Node/Rust Product Core/私有 App Server/FFmpeg/字体/静态资源身份；
- 中文 IME、emoji、中英混排、剪贴板、md/png/pdf 拖放固定语料；
- Markdown、Excalidraw、draw.io、PDF/Office page surface、HTML 与视频 Scene IR fixture；
- `app_ui`、`diagram_editor`、`artifact_preview`、`render_worker` 的固定权限、origin、Session 生命周期、CSP 与 IPC schema；
- 路径穿越、恶意导航、弹窗、下载、权限请求、IPC sender/replay、ASAR/fuse 篡改语料；
- 离线干净 macOS/Windows 机器，不预装 Python/Node/Chrome/Chromium/Codex Desktop；WPS 分有/无两组。

## 3. 必做场景

### A. 安装与身份

1. 断网安装、启动、退出、卸载和重新安装；
2. 校验 OS → Electron Main → Rust Product Core → 私有 App Server/隔离 Worker 的固定进程树、父进程死亡语义与一次性 IPC endpoint；V1 不增加 Native Launcher；
3. 验证基础安装已包含 Chromium、编辑器、`artifact_preview`、`render_worker`、App Server、FFmpeg/codec、必要字体和内置能力 Runtime；
4. 首次打开 Markdown、绘图、Review 和视频代表样片时不得产生安装、包管理器或浏览器下载动作；
5. 篡改任一必装制品必须触发安装修复/回滚，不得伪装为普通能力 unavailable；
6. WPS 缺失只禁用 Office authoritative truth 路径，工作台、Markdown、绘图与其他能力仍可启动。

### B. 交互与恢复

1. CodeMirror 中文组合输入不丢字、不重复，emoji/中英混排、撤销/重做、剪贴板往返正确；
2. md/png/pdf 外部拖入走授权提案，不能把真实路径直接交给 renderer；
3. 100%/125%/150%/200% 缩放、多标签、分栏、焦点、快捷键、VoiceOver/Narrator 与窗口恢复；
4. Excalidraw/draw.io 离线打开、编辑、保存、导出；
5. `artifact_preview` 打开 PDF、图片、HTML 和 WPS authoritative pages；
6. 分别杀死 `app_ui`、`diagram_editor`、`artifact_preview`、`render_worker`，恢复只重建对应 Surface/Job，文件、Artifact、Annotation、Workflow 与 Credits 不损坏；
7. 杀死 Rust Product Core 后 UI 进入 disconnected/recovering，旧 handle/nonce 失效，恢复后不重放未确认副作用。

### C. Surface 隔离

1. `app_ui` 使用应用级受控 Session，`diagram_editor` 使用关闭即清理的内存 Session，`artifact_preview` 使用 revision-scoped 内存 Session，`render_worker` 使用 Job 级 ephemeral Session；不得为每个 Tab/Project 创建永久 Profile；
2. 领域数据不得存入 cookie、localStorage、IndexedDB、Cache Storage、service worker、浏览历史或下载记录；Render Worker 与 UI/绘图/预览之间零共享；
3. `render_worker` 每 Job 使用 ephemeral Session，不读取 UI 登录态、Cookie、缓存或系统 Chrome profile；
4. 外部登录/支付/OAuth 只打开系统浏览器，一次性回调由 Rust 校验；
5. 所有 renderer `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`、`webSecurity=true`；
6. Electron Main 不读写 Workspace，不执行 WPS/FFmpeg/扩展，不持有 Provider Key、支付凭证或业务数据库。

### D. IPC、资源与生产包安全

1. preload 只暴露生成的版本化方法；未知方法、未知字段、超限消息、伪造 sender/frame/origin/surface、过期 nonce、重放和越权 project/revision 全部拒绝；
2. 本地私有通道不监听 TCP；Unix socket/FD 或 named pipe 权限只允许当前进程树/用户；
3. renderer 只获得 logical URI、受限 handle 或 bounded stream，不获得真实路径；`file://`、任意 `fs`、`child_process`、`shell`、`http/net` 和通用 Electron bridge 不存在；
4. navigation、new-window、permission、download、external protocol、远程脚本和活动 HTML/Markdown 默认拒绝；
5. 生产 fuses 禁用 RunAsNode、NODE_OPTIONS 和 Node CLI inspect，启用 ASAR integrity 与 OnlyLoadAppFromAsar；
6. 修改 ASAR、preload、静态资源、Runtime Manifest 或 Rust Product Core 后应用必须拒绝启动或进入签名修复，不能继续运行被篡改内容。

### E. 视频 renderer 冒烟

1. 同一 Scene/Timeline/Asset/Font/Chromium identity 连续渲染三次，输出帧数、尺寸和逐帧 hash 一致；
2. `render_worker` 不使用墙钟或 CSS 自播放，由 Rust Product Core 发送绝对 frame index；
3. renderer crash 后从 checkpoint 恢复，已完成帧不重复提交，UI renderer 不受影响；
4. 本场景只验证壳层/隔离/传输冒烟；完整色彩、字体、透明度、Canvas/SVG、并发与 golden render 由 Gate 4 签署。

## 4. 证据与阈值

- 所有功能与安全断言必须 100% 通过；任何数据损坏、权限旁路、跨 surface 状态泄漏、首次使用动态安装或 Electron Main 获得可信业务权限均为 `NO_GO`；
- macOS 与 Windows 必须各自产生签名构建、进程树、Runtime Manifest、网络记录、surface/partition 清单、IPC 拒绝记录、篡改测试、screenshots 和人工无障碍记录；一端未运行只能 `BLOCKED_ENVIRONMENT`；
- 记录安装包体积、冷启动、空闲/编辑/Preview/`render_worker` 峰值内存、GPU 状态、renderer/子进程数量和崩溃恢复时间；本轮数值由 Desktop Runtime 与 Release Engineering Owner 在 `decision.md` 明确接受或拒绝，不允许无记录升级为 GO；
- `GO` 仍需 Owner 签署；自动检查通过但人工 IME/无障碍/体积性能未签署时最多 `CONDITIONAL_GO`；
- 失败不触发 Tauri/System WebView fallback，而是保持 Production Implementation Admission `NO_GO` 并重新裁决架构。

## 5. 与其他 Gate 的边界

- G0-SHELL-002 证明桌面壳、安装完整性、Surface 和最小视频冒烟；
- Gate 4 证明五个视频 Profile 的确定性、视觉质量、编码与媒体 QA；
- Gate 5 证明用户 Skill/MCP 通过 Public Capability Facade 调用系统能力且不能绕过 Electron/Rust 边界；
- Gate 6 证明正式签名安装、升级、回滚、SBOM、许可证、CVE 响应与发布性能预算。
