# 规则包：原生绘图（drawing）

适用范围：Excalidraw 与 draw.io 的一等文档、编辑、导出与 Agent 操作。

## R-DR-01 原生格式唯一事实源

不建立私有绘图格式；.excalidraw、.excalidraw.md、.drawio、含源数据的 .drawio.svg/.png 按原格式原位保存，不静默转换或迁移；SVG/PNG/PDF 预览是派生产物，不反向成为编辑真相。[WD §21.2] [DG-02] [DG-04]

## R-DR-02 离线内嵌编辑器

两个编辑器以固定、签名的静态资源离线内嵌，经 `diagram_editor` WebContentsView 运行；renderer 关闭 Node integration，只取得当前文档的 Resource Handle 和结构化保存/导出事件，不获得真实路径、进程或任意网络能力，也不依赖在线服务。[WD §9] [BCRA §6] [BCRA §7] [BCRA §8] [DG-01] [DG-03]

## R-DR-03 扩展名默认规则

普通项目新建 Excalidraw 默认使用 .excalidraw；Obsidian Vault 或已启用兼容模式的项目默认使用 .excalidraw.md。[WD §21.2]

## R-DR-04 统一命令层与专属能力

Agent 用统一结构化 Diagram 命令（创建、更新、连接、布局、导出）完成常规制图，不模拟鼠标；图层、页面、箭头绑定等格式专属能力通过 namespaced typed operation 保留，由各自 Adapter 修改原生模型；所有修改经结构校验、原子保存并支持 Review/Undo。[WD §21.2] [DG-05]

## R-DR-05 Headless 渲染与视觉 QA

SVG/PNG/PDF 导出与渲染 QA 使用独立 Electron Render Worker Host 完成，不占用交互编辑 Surface；版本、字体、输入 hash 与输出 hash 必须进入 Render Manifest，派生产物必须与源文件结构校验一致。[WD §9] [BCRA §10] [BCRA §13] [DG-06]

## R-DR-06 内容安全边界

禁止图表内容未授权联网和执行活动内容：URL、插件、模板、图片、脚本与本地文件访问按白名单校验。[WD §9] [DG-07]
