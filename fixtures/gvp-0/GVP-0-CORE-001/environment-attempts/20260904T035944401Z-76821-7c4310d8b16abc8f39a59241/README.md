# macOS GVP-0 repository-reviewed observation

- `run_id`: `20260904T035944401Z-76821-7c4310d8b16abc8f39a59241`
- scope: 已脱敏的 exit-2 环境失败观测；operator 已替换为角色标识，不含绝对路径、凭据或 stack trace。
- integrity: `index.json` 逐项绑定 9 个 runner artifact；状态另绑定 `index.json` 自身哈希。
- limitation: 时间戳是被审查的观测内容，不能独立证明 wall-clock 时长。空 `results.json` 不是 receipt。
