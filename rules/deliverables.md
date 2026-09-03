# 规则包：PPT / Word / HTML 交付（deliverables）

适用范围：SuperPPT、SuperWriter、HTML 三类交付物的阶段语义与验收底线。视频见 video.md。

## R-DL-01 SuperPPT 七阶段

唯一阶段定义为 WD §20.2 的七阶段；默认图片型高保真，仅对用户指定页做可编辑重建；大纲、逐页规划、代表样张是必经确认点。[WD §20.2] [PPT-01]

## R-DL-02 风格阶段真实效果图

视觉风格阶段必须用同一代表内容实际生成效果图，不能只给色板、字体或文字描述；风格预览存“风格预览”目录，选择写入“风格方案.md”。[WD §20.2] [PPT-01]

## R-DL-03 图像与绘图分工

普通插图默认用 ai-image-to-ppt 图像能力，精确图解用 Excalidraw；图像能力按版本化 Capability 管理，Host 生图优先、API fallback、不重生成已成功页。[WD §20.3] [PPT-02]

## R-DL-04 可编辑重建与混合组装

image-to-editable-pptx 只对指定页做单页可编辑重建，按 1280×720 规范处理；编辑性边界不夸大；图片型与可编辑页混合组装保持顺序、尺寸与资源正确。[WD §20.2] [PPT-03] [PPT-04]

## R-DL-05 真实 Office 验收

PPT 交付必须通过真实 WPS/PowerPoint smoke：受控副本、临时编辑、撤销、保存/放弃与重开证据；结构检查不能代替真实验收。[WD §20.2] [PPT-05]

## R-DL-06 SuperWriter 七阶段

唯一阶段定义为 WD §20.3 的七阶段；章节、来源、引用和插图都有可见中间文件；逐章写作绑定来源。[WD §20.3] [DOC-01]

## R-DL-07 WPSComposer 与平台边界

DOCX 格式化走 WPSComposer；Windows 用 COM、macOS 用 JSAPI/UI adapter，不假称两平台能力对等；未过 PoC 时在 WPS 受控副本中完成编辑与重开验收。[WD §20.3] [V1RS §3] [DOC-02]

## R-DL-08 内置查看与最终宿主验收分离

DOCX/PDF 的日常打开、检查、批注与 Review 由 Universal Viewer 完成，严格报告 `ready/partial`；交付前对编号、表格、分页、字体、图片和目标应用兼容性的真实 WPS/Office smoke 仍是独立验收，不为 Viewer 供页面。[WD §20.3] [VIEWER §6.4] [DOC-03]

## R-DL-09 Universal Viewer / ReviewBridge 边界

Universal Viewer 是文件的正式内置显示面，ViewerShell 提供通用/格式专属交互，ReviewBridge 把页、Slide、Sheet、记录和元素锚点转为产品 Review Intent；批注、Diff、Agent 修改请求与版本确认由 Rust Product Core 持久化。打开路径只允许已签名 Viewer Chunk 与内部契约，不启动外部宿主或生成能力。[WD §21.1] [CAC §2.4] [VIEWER §3.5–3.6] [DOC-04] [DOC-05] [DOC-06]

## R-DL-10 HTML 七阶段与 Taste 内置

唯一阶段定义为 WD §20.4 的七阶段；HtmlTastePolicy 内置于 HTML Workflow，在视觉方向、本地构建、浏览器 Review 三阶段执行质量规则；不暴露 Skill 名称、路径或技术旋钮。[WD §8.4] [TASTE §1] [HTML-01]

## R-DL-11 官方 Host 唯一发布目标

HTML 只发布到官网官方 Host：默认知道链接即可访问的稳定链接、更新保持同一链接、支持停止分享与回滚；只上传最终静态 bundle，不上传项目文档、Agent 对话或日志。[WD §20.4] [TASTE §5] [HTML-02]

## R-DL-12 Taste 冻结与升级

生产使用审查过的冻结快照（固定 commit、capability version、许可文本与 SBOM）；上游更新只进独立评估，不自动改变已发布客户端与历史 Run；禁止运行未固定版本的 npx/npm 全局安装或远程脚本。[TASTE §2] [TASTE §5]

## R-DL-13 设计与依赖原则

交付目标优先，简单静态页不强制引入 Next.js/React/Tailwind；动效等可选依赖缺失时降级不阻断；使用真实素材，不用装饰 div 假装产品截图。[TASTE §5] [TASTE §6]
