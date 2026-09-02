# G6-PACKAGE-001 — 双平台安装、升级与完整性

必须使用签名的 macOS 与 Windows 11 安装包，在干净机完成安装、首启动、签名/公证、
Electron/Chromium/Node/Rust 兼容单元、ASAR integrity/fuses、自动升级、失败回滚、卸载保留
Workspace、SBOM、第三方许可证和完整性校验，并记录包体积、冷启动、内存、GPU、renderer/
子进程和代表任务基线。断网安装结束必须已包含 Chromium、编辑器、`artifact_preview`/`render_worker`、
App Server、FFmpeg/codec、必要字体和内置能力 Runtime；首次使用不得动态下载这些依赖。

PKG-02 的按需下载只适用于不构成 V1 系统能力前提的明确可选包，不能用于规避上述完整安装要求。

当前没有签名可安装构建、发布证书、更新服务或双平台干净机，本 fixture 只能准确记为
`BLOCKED_ENVIRONMENT`，不能用开发目录、单元测试或未签名壳代替。
