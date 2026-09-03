# macOS Markdown Editor PoC

这个 PoC 验证 `G1-MARKDOWN-001` 过去没有覆盖的一层：SuperWagie 自己的
Electron/Chromium + CodeMirror 6 界面能否提供接近 Obsidian 的 Markdown 编辑与阅读
体验。它是编码前技术验证资产，不是正式客户端实现。

## 已验证范围

- Live Preview、Reading View、Source Mode；
- 中文组合输入、emoji、保存后关闭重开；
- Properties、WikiLink/别名/标题锚点/块引用；
- 文档、PNG 与 `.excalidraw.md` 嵌入；
- Callout、脚注、数学、Mermaid 和未知插件 fenced block；
- 自动保存、原子写入、外部修改通知、过期 revision 拒绝；
- 未知 frontmatter、HTML 注释和未知插件语法原文保留；
- 同名 WikiLink/附件优先按当前文档目录解析，避免误命中 Vault 根目录文件。

Backlinks、全库搜索、重命名事务、大型 Vault 增量索引、完整崩溃恢复和完整
Obsidian 插件 API 不由本 PoC 声明通过。

## 本地复现

```bash
cd scripts/poc/gate-1/markdown-editor-poc
npm ci
npm test
```

本仓库使用的 npm 策略可能禁止第三方包自动执行 `postinstall`。`npm test` 会通过
`prepare:electron` 显式准备 lockfile 固定的 Electron 版本，避免测试偷偷依赖机器上
残留的 Electron 缓存；该动作只属于验证环境，不是产品运行时动态安装依赖。

测试默认复制仓库内 `G1-MARKDOWN-001` torture fixture 到临时 Vault，并启动真实
Electron。也可以让 Electron 自测打开已经准备到真实 Obsidian Vault 的文件：

```bash
npm run build
./node_modules/.bin/electron src/main.mjs \
  --self-test \
  --vault /absolute/path/to/vault \
  --obsidian-vault-root /absolute/path/to/vault \
  --file relative/path/to/torture-edited.md \
  --output /absolute/path/to/evidence-dir/results.json \
  --screenshots /absolute/path/to/evidence-dir/screenshots
```

真实 Obsidian 交叉回读仍按
`fixtures/gate-1/G1-MARKDOWN-001/fixtures/checklist.md` 执行；PoC 的自动结果不能冒充
Owner 人工签署。
