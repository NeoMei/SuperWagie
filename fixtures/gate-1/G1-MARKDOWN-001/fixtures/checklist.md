# G1-MARKDOWN-001 人工验收清单（R-QS-02 真实宿主）

自动化已验证字节级往返与未知语法保留。以下由产品所有者用真实 Obsidian 执行：

- [ ] 1. 在 Obsidian 文件树打开 SuperWagie验收/G1-MARKDOWN-001/当前验收.md，点击其中的 torture-edited 链接；基础链接、别名链接、标题锚点和块引用都故意指向同一份 核心内容.md，用于分别验证四种语法；文档小节、图片素材.png 和 系统架构.excalidraw.md 均能正常嵌入
- [ ] 2. Reading View / Live Preview / Source Mode 三种模式切换无异常
- [ ] 3. 在 Obsidian 中对 torture-edited.md 做一处小编辑并保存，文件无损坏
- [ ] 4. HTML 注释、未知插件块、frontmatter 自定义字段仍然存在

准备命令：

    ./scripts/poc/run-gate.sh gate-1 --fixture G1-MARKDOWN-001 --platform macos-15-arm64 --obsidian-vault /Users/neomei/Obsidian/NeoMei-Docs

每次准备都会写入独立的 run 目录，并更新 当前验收.md 指向本次样本，避免覆盖以前的人工编辑。
