# G0-DEPS-001：依赖 Resolver 探针 PoC

- Gate：gate-0（见 docs/技术可行性/技术验证执行计划.md §6）
- 所有者角色：Dependency Resolver + Security
- 平台：macos-15-arm64、windows-11-x64
- 证据修订：`solution-b-v1`
- 状态：四层 Resolver 模型与受控失败执行器已实现；签名候选 Runtime Image 和双平台真实探针仍未提供，因此自动结果最多 `CONDITIONAL_GO`

## 固定输入

依赖矩阵严格分为：

1. OS Baseline：系统稳定 API 与 feature probe，不继承随机环境；
2. Signed Runtime Image：Chromium、Node、Python、FFmpeg、字体等随安装签名分发，只允许候选镜像内相对路径；
3. External Host：Git、WPS 等只能返回绝对路径、身份、版本、架构和 feature；
4. User Extension Environment：独立安装、独立授权，绝不能补齐或替换产品 Runtime。

## 步骤

1. 验证四层均非空且归属不重叠；
2. 断言 Signed Runtime 不含系统绝对路径、PATH fallback 或用户扩展替代；
3. 断言 External Host 候选为目标平台绝对路径并声明身份与 feature probe；
4. 对 PATH 污染、缺失 Runtime、旧 External Host 和扩展冒充核心 Runtime 执行固定失败场景；
5. 提供 `--candidate-root` 时读取候选根内 `runtime-manifest.json`，逐项校验相对路径、真实路径不逃逸、无 symlink、唯一 ID 和实际内容哈希。普通文件直接计算 SHA-256；目录按 UTF-8 相对路径排序，将每个文件编码为 `relative-path + NUL + sha256:<file-digest> + LF` 后拼接并再次计算 SHA-256。Manifest 只有哈希字段但与内容不符时必须 `NO_GO`。

## 指标与阈值

- 模型检查与固定失败语义 100% 通过；
- 未提供签名候选根时不得超过 `CONDITIONAL_GO`；
- 两个平台各自产生候选 Runtime Manifest、OS/External Host probe 和决策签名后才可 GO。
