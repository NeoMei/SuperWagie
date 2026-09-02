# G3-PPT-WPS-MACOS-SMOKE-001

这是 `G3-PPT-001` 的 macOS 真实 WPS 子验证，不是新的发布 Gate，也不进入 31 项权威 fixture 计数。

## 固定输入

- Artifact：`evidence/gate-3/presentation-runtime-bundle-20260901T091243Z/artifacts/three-slide-bundled.pptx`
- SHA-256：`853f89c05733671a6351bcbb7f1df2d0a7e55bec9c84ed56c4e78417ca3aa9e3`
- 结构：三页、16:9；第 1/3 页为图片型页面，第 2 页包含原生 `TITLE EDIT` 文本对象。

## 真实 WPS 步骤

只操作两个受控副本，不修改固定输入。

1. 在 WPS 打开副本，分别选中第 1/2/3 页并检查顺序与清晰度；记录缩放请求值和 WPS
   实际显示值。本机选择 100% 后状态栏按设备缩放显示 101%，证据不得把两者混写。
2. 第 2 页把 `TITLE EDIT` 改成临时文字，再撤销；必须恢复 `TITLE EDIT`。
3. 保存分支把标题改成 `TITLE SAVED`，保存、关闭、从磁盘重开；标题必须保留。
4. 放弃分支把标题改成 `TITLE DISCARD`，关闭时选择“不保存”，从磁盘重开；标题与文件哈希必须恢复。
5. 记录 WPS 绝对 app/executable 路径、bundle id、version、build、TeamIdentifier、
   codesign 结果、可执行文件哈希、UTC 时间、操作者角色及全部截图。

通用恢复提示不等同于文件修复提示；若 WPS 报告当前 PPTX 损坏、修复或字体替换，则本子验证失败。

## 自动校验

```bash
./scripts/poc/run-gate.sh gate-3 \
  --platform macos-15-arm64 \
  --fixture G3-PPT-WPS-MACOS-SMOKE-001 \
  --evaluation-result /absolute/path/to/evaluation.json
```

Evaluation 及其所有证据必须位于同一目录树内，并逐文件提供 SHA-256。验证器拒绝绝对
证据路径、`..`、symlink、TOCTOU 替换、哈希漂移、缺截图、不可解码或尺寸异常截图、
ZIP/OOXML 损坏、非精确三页/页序、错误保存/放弃标题；同时现场探测固定 WPS 绝对路径、
Info.plist、codesign、TeamIdentifier、可执行文件哈希和正在运行的主进程。人工 UI 布尔值
及截图语义在所有者签署前只能产生 `CONDITIONAL_GO`，自填全 true 不能自动产生 `GO`。

## 裁决边界

本子验证当前为未签署的 `CONDITIONAL_GO`：机器证据已证明固定 WPS 宿主身份、证据完整性、
精确三页结构、保存/放弃后的 OOXML 与哈希语义；清晰度、编辑和撤销等人工 UI 事实仍等待
所有者把签署绑定到证据包后才能成为该子验证的 `GO`。

不得据此升级 `G3-PPT-001`、Gate 3 或 Production Implementation Admission。实际 SuperPPT 接入、七阶段与三个 Human Gates、稳定 slide ID 与局部失效、Signed Runtime、Windows WPS/PowerPoint 仍需各自证据。

依据：R-DL-04、R-DL-05、R-QS-02、R-RI-05。
