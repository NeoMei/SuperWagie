# G4-VIDEO-001 — 网站 Demo 视频

固定目标：真实页面来源、30 秒成片、10–15 秒样片、受控运动、旁白、字幕、
局部重渲染、取消恢复和媒体 QA。产品级帧渲染必须使用随 Electron 安装的独立
`render_worker` Chromium Job Surface，不得借用 Codex Desktop 或系统 Chrome，不得与其他 Surface 共享 Session/cache/权限。

当前 macOS PoC 使用 G3-HTML-001 的真实 Chromium 截图验证 FFmpeg 媒体层；
由于签名隔离的 SuperWagie `render_worker` 帧渲染路径尚不存在，本 fixture 必须保持
`NO_GO`，不能把静态截图加 zoompan 当成完整网站录制能力。
