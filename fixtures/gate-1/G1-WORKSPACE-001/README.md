# G1-WORKSPACE-001 — Workspace 核心对抗与规模基线

- Owner role: Workspace Core
- 平台: macos-15-arm64（Windows 基线待 Windows 侧复跑后补充）
- 执行器: scripts/poc/gate-1/workspace-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-1 --fixture G1-WORKSPACE-001 --platform macos-15-arm64

## 固定输入

全部由执行器在系统临时目录生成的确定内容，不含用户数据：

- root containment / 绝对路径 / 路径穿越探针
- symlink 外指、合法内指与 publish 前换链（TOCTOU）探针
- 大小写冲突与 Unicode NFC/NFD 身份探针
- 长路径（CJK 目录段）与长文件名探针
- 1k / 10k / 100k 规模目录（测量后清理）

## 阈值

- 越界读写 100% 拒绝，无静默覆盖
- 外部修改事件 2s 内全部到达且索引内容一致
- 100k 冷扫描 < 60s；增量索引 p95 < 1000ms；取消响应 < 1500ms

## 证据

results.json 的 checks 与 metrics；scale 明细写入 artifacts/scale-metrics.json。
