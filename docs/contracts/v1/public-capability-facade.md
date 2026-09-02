# Public Capability Facade v1

Public Capability Facade 是主 Agent 和已授权用户 Skill/MCP 共用的高层能力面。两者使用相同的方法语义、Schema、Artifact 和回执；差异只来自调用者身份、获授权范围和风险确认。

## 1. 统一调用形式

```text
call(ClientIntent<payload>)
→ method = ClientIntent.command_type
→ Trusted Gateway injects actor / caller / project / grants / billing / gate / audit
→ AuthorizedCommand<payload>
→ CommandResultEnvelope<result> | ErrorEnvelope
→ optional ordered EventEnvelope stream
```

- 方法名是稳定业务 ABI，不含 Skill 路径、Python 模块、Rust crate、COM 对象、Provider 或模型名；
- 所有写操作使用 `request_id` 幂等，且返回 revision 或 receipt；
- 调用者只能请求权限，不能自报 actor、caller、effective grant、project binding、wallet、billing reservation、Gate Receipt 或审计上下文；
- 已授权普通操作不重复确认；`scope_expansion|external_effect|destructive|high_cost_billing` 进入统一 Risk Gate，扩展安装另走 Install Gate，内容阶段选择走 Workflow Gate；
- 每个方法的 payload/result 必须由 Capability Manifest 引用版本化 JSON Schema。

## 2. V1 方法目录

机器权威目录为 [public-capability-methods.json](./public-capability-methods.json)，目录结构由 [public-capability-methods.schema.json](./public-capability-methods.schema.json) 校验。下表是便于阅读的投影；`required_gate` 与 `risk_kind` 不得混成一个含糊的 risk 字段。独立手写 [method-contract-inventory.json](./public-method-schemas/method-contract-inventory.json) 锁定每个方法的核心 input/output required 字段、类型、Gate、risk 和安全约束，它不从 Schema/fixture 生成器产生，Contract Foundation 会将 inventory、catalog、Schema、fixture 四方对照并执行占位变异。当前 `schema_resolution_status=resolved`：35 个方法的 70 个 URI 均可由 [public-method-schemas/resolve.mjs](./public-method-schemas/resolve.mjs) 离线确定性加载。真实领域 handler、产品 Worker 与 Managed AI 输出清洗/Secret scanner 尚未实现和垂直切片验收；Network Broker 的 DNS/IP/redirect/localhost 每跳校验尚未实现和垂直验收。因此 Facade 父 Gate 仍为 `CONDITIONAL_GO`，不能因 Schema 完成升级为 `GO`。

| 方法 | 用途 | 核心输入 | 核心输出 | required_gate / risk_kind |
|---|---|---|---|---|
| `workspace.read` | 读取 Content Scope 内文件/片段 | logical path、range、expected revision | content、workspace revision、hash | normal |
| `workspace.search` | 全文、标题、标签、链接和任务查询 | query、scope、limit、cursor | stable result refs、cursor | normal |
| `workspace.propose_change` | 生成可审查语义修改 | base revision、Working Set、operations | proposal、diff、impact | normal |
| `workspace.apply_change` | 通过 CAS 提交已授权修改 | proposal ID、expected revision | Workspace Revision、receipt | 触发时 Risk Gate / destructive |
| `task.query` | 查询项目任务和日历投影 | project、filter、cursor | Task refs、cursor | normal |
| `task.create` | 在指定或项目默认 Markdown 中创建普通任务 | project、target file?、task fields、base revision | task ID、Workspace Revision、receipt | normal |
| `task.update` | 修改任务状态/时间/文本 | task ID、patch、base revision | task projection、Workspace Revision | normal |
| `task.start_execution` | 创建或恢复任务关联的 Agent Task Thread | task ID、content scope、working set? | task thread ID、state | 触发时 Risk Gate / high_cost_billing |
| `task.open_source` | 定位任务的 Markdown 源块 | task ID | workspace/file/block ref、revision | normal |
| `diagram.create` | 创建 Excalidraw 或 draw.io 原生文件 | format、semantic plan、target path | ArtifactRef、Workspace Revision | normal |
| `diagram.render` | 渲染原生图表 | source ref、format、size | preview ArtifactRef | normal |
| `diagram.export` | 导出 SVG/PNG/PDF | source ref、format、target | ArtifactRef、receipt | normal |
| `artifact.get` | 获取 Artifact 元数据和修订 | artifact ID/revision | ArtifactRef、revision graph | normal |
| `artifact.register` | 验证并登记新 Artifact | staged ref、owner、provenance | canonical ArtifactRef | normal |
| `artifact.preview` | 创建真实或兼容预览 | ArtifactRef、target renderer | Preview Revision、status | normal |
| `runtime.probe` | 查询声明的产品 Runtime 或外部宿主能力 | dependency ID、required features | opaque runtime identity、version、features、health（不向扩展暴露任意真实路径） | normal |
| `wps.generate` | 按高层 WpsPlan 生成 Office 制品 | WpsPlan、staging owner | ArtifactRef、receipt | 触发时 Risk Gate / high_cost_billing |
| `wps.apply_plan` | 在受控副本中修改 Office 制品 | source revision、WpsPlan | new ArtifactRef、receipt | normal |
| `wps.render_preview` | 使用目标 WPS/Office 渲染审阅页 | ArtifactRef、renderer target | Preview Revision、page refs | normal |
| `wps.smoke_acceptance` | 对受控副本做编辑/撤销/保存或放弃/重开验收 | ArtifactRef、acceptance script | acceptance receipt、evidence refs | Risk Gate / external_effect |
| `browser.fetch` | 通过 Network Broker 获取已授权网络资源 | URL、method、declared purpose | response ArtifactRef/metadata | Risk Gate / external_effect |
| `browser.review_site` | 在隔离浏览器检查静态站点 | site ArtifactRef、viewports、checks | report、screenshots、receipt | normal |
| `publish.prepare` | 上传到 Official Host 预览环境 | static ArtifactRef、share policy | deployment ID、preview URL、impact | Risk Gate / external_effect |
| `publish.promote` | 将已确认预览发布到稳定链接 | deployment ID | stable URL、publish receipt | Risk Gate / external_effect |
| `publish.rollback` | 回到已有 deployment revision | deployment ID、target revision | stable URL、rollback receipt | Risk Gate / external_effect |
| `publish.revoke` | 停止分享 | deployment ID | revoke receipt | Risk Gate / destructive |
| `workflow.get` | 获取调用者已授权 Run | workflow run ID | state、stage、checkpoint、next actions | normal |
| `workflow.resume` | 恢复已授权 Run | workflow run ID、expected revision | accepted result | normal |
| `workflow.stop` | 安全暂停 Run | workflow run ID、expected revision | checkpoint、state | normal |
| `ai.chat` | 快速对话/文本生成 | messages、scope refs、output schema | text/structured result、usage receipt | 触发时 Risk Gate / high_cost_billing |
| `ai.reason` | 复杂推理 | problem、scope refs、output schema | structured result、usage receipt | 触发时 Risk Gate / high_cost_billing |
| `ai.vision` | 图像/页面/视频帧理解 | ArtifactRefs、questions、output schema | structured result、usage receipt | 触发时 Risk Gate / high_cost_billing |
| `ai.ocr` | 文字与布局识别 | image/page refs、language hint | text/layout ArtifactRef、usage receipt | 触发时 Risk Gate / high_cost_billing |
| `ai.generate_image` | 宿主路由图像生成/编辑 | prompt、input refs、size/style profile | image ArtifactRefs、usage receipt | Risk Gate / high_cost_billing |
| `ai.generate_audio` | TTS/音频生成 | text/script、voice profile、timing | audio ArtifactRef、usage receipt | Risk Gate / high_cost_billing |

Workflow/Risk/Install Gate 决定只允许经认证的 `app_ui` 产品命令提交；它们不是 Public Capability Facade 方法，官方 Agent 或用户扩展都不能冒充用户提交决定。Trusted Gateway 校验决定后，按 [human-gates.schema.json](./human-gates.schema.json) 生成并注入与候选、动作、范围或安装清单精确绑定的回执。

## 3. 明确禁止的公开接口

- 枚举、读取或启动 Private Workflow 定义；
- 读取 Private Prompt、Provider、模型、API Key、Secret 明文或 Codex App Server 原始协议；
- `wps.raw_execute`、任意 COM/JSAPI 对象访问、任意 shell、`shell -c`、PowerShell `-Command`；
- 跳过 Workspace API 读写真实路径，或跳过 Network/Credential Broker 访问网络和凭证；
- 让用户选择第三方 HTML Publisher；`publish.*` 只指向 Official Host。
- 伪造 `origin=project_milestone`、调用内部 Milestone reconciliation，或把 Workflow Stage 批量物化为用户任务。
- 调用产品内部 UI Query、枚举其他 Project 的 Projection，或把 `ResourceHandle` 当作长期 Artifact 身份保存和转交。

## 4. 等价性验收

每个公开方法必须用同一 fixture 分别从官方 Agent 和用户 Skill 调用，比较 Schema、Artifact、revision、receipt、错误码和权限结果。用户 Skill 不得获得功能残缺的替代 API；权限不同必须通过标准 `SW_PERMISSION_DENIED` 和可理解的下一步表达。伪造可信上下文的 fixture 必须在进入领域处理器前失败。
