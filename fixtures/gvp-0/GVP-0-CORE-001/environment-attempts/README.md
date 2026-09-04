# Reviewed environment-attempt bundles

此目录只收录经仓库审查、脱敏并提交的 GVP-0 环境失败观测。公开 runner 的原始 `evidence/` 运行不会自动进入状态；必须先复制到本目录、生成 `index.json`、审查身份／原因／脱敏／逐文件哈希，再使用状态更新器。

这些 bundle 是 repository-reviewed observation，不是 receipt，不能独立证明 wall-clock 时间或外部网络事实，也不提升 `RESEARCH_REQUIRED`。

本目录下每个受 Git 追踪的直接子候选都必须完整通过命名、类型、index、schema、逐文件哈希和平台身份校验。任一 tracked 候选无效都会阻断整个审计和状态写入，不得过滤后回退到更旧 bundle。当前没有 superseded marker；根目录普通 README/文档不是 bundle 候选，但 symlink、嵌套或非时间戳候选均为硬错误。
