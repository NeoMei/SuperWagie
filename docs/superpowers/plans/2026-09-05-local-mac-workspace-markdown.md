# 当前 MacBook：Project → Markdown → 恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 MacBook 上交付一个可持续维护的桌面开发应用，从授权本地项目、打开 Markdown、三模式编辑与自动保存，到外部冲突、关闭重开和崩溃恢复形成真实闭环。

**Architecture:** Electron Main 只负责窗口、目录选择器、Surface 与认证转发；Rust Product Core 持有挂载授权、文件身份、事务、恢复和 UI Query。CodeMirror 6 位于沙箱化 app_ui，用户原文无损保存；所有文件访问经 Core，不复用 PoC 中 Main 直接写 Workspace 的路径。

**Tech Stack:** Electron 44.1.0、CodeMirror 6、Rust edition 2024、版本化 NDJSON/IPC、SQLite Operational Store、Node 内置测试与真实 Electron UI 测试。依赖准确版本以任务 1 生成并审核的 lock 为运行依据。

**Spec:** `docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md` §5.1；`docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md` §1、§5、§7、§8、§14.1；`docs/superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md`；`docs/superpowers/specs/2026-08-29-superwagie-ui-implementation-contract.md`；WD §5–6、§15–18。

## Global Constraints

- “Rust Product Core 是唯一业务、数据与策略权威”。R-RP-01 / R-SE-09；Main 不读写 Workspace 或业务 SQLite。
- “默认单信封上限 1 MiB”。CAC §5；按 UTF-8 字节计数，超限正文使用受限资源传输，不能截断后保存。
- “sandbox: true”、“contextIsolation: true”、“nodeIntegration: false”、“webSecurity: true”。BCRA §15；禁用任意网络/导航/新窗口/下载和通用 IPC。
- “一个逻辑文件在一个 window 内只有一个 tab identity”。UIC §4；使用 workspace_id + file_identity，不使用可变路径。
- “冲突处理始终保留双方原始内容和 Base”。WD §18；禁止旧全文覆盖外部编辑，不能把读后 rename 的时间窗口当作严格 CAS 已被证明。
- “日常输入和 Agent patch 自动保存，不提供手动保存负担”。WD §18；写失败和未持久草稿必须可见，正常关闭须等待安全落盘或明确保留恢复点。
- “当前优先目标是在用户现有 MacBook 上完成整个产品的本地开发与真实端到端闭环”。V1RS §5.1；记录真实 OS/build/arch，Windows/macOS 15 不阻塞本片。不得修改发布 Ledger 或伪造 GVP receipt。
- “最小窗口：960 × 680”；GlobalRail 48px；使用确认原型，不重新设计首页。布局按 UIC §3 精确实施；快捷键与 WD §17.4 的冲突按 CAC §1 先澄清到 UIC 再实现，不让实现者自行任选。
- 不连接机器已有 Codex，不引入 WPS/LibreOffice 给 Markdown 或 Viewer 供页，不对外发布，不发起真实计费。
- 本计划只是 LOCAL-01 的 Project/Markdown 子切片；Tasks、绘图、全文索引、文件移动/删除、Agent、Viewer、账户等仍保留后续任务，未实现入口不展示虚假成功。

## 仓库现状与复用决定

| 已存在路径 | 本片决定 |
|---|---|
| `scripts/poc/solution-b-spike/src/core-client.mjs`、`core-supervisor.mjs` | 参考握手、超限、超时、单次重启和关闭测试；生产模块独立落到 apps/desktop，不能保留测试命令或临时协议 |
| `scripts/poc/solution-b-spike/core/src/main.rs` | 参考认证与 descriptor-relative 安全读取；不整体复制千行 PoC 主程序，不延用其 query_snapshot 测试消息替代 ui-query.schema.json |
| `scripts/poc/gate-1/markdown-editor-poc/src/markdown-model.mjs`、`document-switch.mjs` | 对纯编辑模型、无损渲染和保存队列做受测迁移；DOM/资源加载重新绑定 Core Handle |
| `scripts/poc/gate-1/markdown-editor-poc/src/main.mjs` | 不复用其 readText/atomicWrite/自测注入到正式 Main；其路径字符串检查不构成产品授权边界 |
| `scripts/poc/gate-1/workspace-gate.mjs` 与对应测试 | 复用恶意输入/崩溃用例，事务重新由 Rust 实现；不把 JS 检查器作为文件服务 |
| `docs/contracts/v1/{envelopes,ui-query,resource-handle}.schema.json` | 保留已有信封；本片增加产品内部 payload Schema，不更改 Public Capability Facade 目录 |

## 文件结构与接口归属

```text
apps/desktop/
  package.json, package-lock.json
  scripts/{build,dev,test-ui}.mjs
  src/main/{main,core-client,core-supervisor,surface-policy,resource-protocol}.mjs
  src/preload/bridge.cjs
  src/renderer/{index.html,app.mjs,styles.css,query-store.mjs}
  src/renderer/workspace/{project-shell,file-explorer,document-tabs}.mjs
  src/renderer/editor/{markdown-model,document-switch,editor-host}.mjs
  tests/{bridge,query-store,document-switch,app-ui}.test.mjs
crates/product-core/
  Cargo.toml, Cargo.lock
  src/{main,lib,protocol,gateway,query,store}.rs
  src/workspace/{mod,grant,identity,secure_fs,transaction,recovery}.rs
  tests/{protocol,workspace,crash_recovery}.rs
  tests/support/mod.rs
docs/contracts/v1/product-ui-workspace.schema.json
fixtures/local-mac-workspace/{contracts,documents}/
```

职责：secure_fs 只做 descriptor-relative OS 操作；transaction 实现 CAS/恢复；store 只持 Operational 映射/草稿/事务，不取代 Markdown；gateway 注入可信上下文；renderer 只持临时编辑状态。没有任何 app 运行时 import 指向 scripts/poc、evidence 或用户全局依赖。

## Task 1：产品内部协议与可构建边界

**Files:** 创建上述 package/Cargo 清单、protocol.rs/lib.rs、product-ui-workspace.schema.json、fixtures/local-mac-workspace/contracts/、tests/protocol.rs；只修改需要的 Contract Foundation 测试注册，不改变公开方法数。

**Interfaces:** 内部产品命令为 `project.open_selected`（仅 Shell 认证通道）、`project.activate`、`project.revoke`、`document.open`、`document.save`、`document.resolve_conflict`、`document.close`。产品查询为 `project.list`、`workspace.tree`、`document.snapshot`。所有命令使用 ClientIntent → Gateway → AuthorizedCommand；查询使用现有 QueryRequest/QuerySnapshot/Subscription 结构。目录绝对路径只在 Shell→Core 选择结果中传递，不进入 UI Snapshot。

- [ ] 写正反 fixture：合法选目录、取消、伪造 actor/grant/path/surface、未知字段、未知版本、1 MiB+1、未注册 query_id；添加协议测试，先断言不存在实现时失败。

```rust
#[test]
fn renderer_cannot_supply_selected_root() {
    let value = serde_json::json!({"command_type":"project.open_selected",
        "payload":{"selected_root":"/tmp/not-authorized"}});
    assert!(superwagie_product_core::protocol::validate_renderer_payload(&value).is_err());
}
```

- [ ] 定义完整 serde 类型和 Schema，全部 payload 禁止未知字段；在内部接口上区分 ShellSelection 与 RendererIntent，不能以 payload 自报来源切换。定义 `validate_renderer_payload(&serde_json::Value) -> Result<(), ProtocolError>`，这里只校验结构/来源可用性，权限最终由 Gateway 判断。

```rust
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveDocument {
    pub document_id: String,
    pub base_revision: String,
    pub draft_handle_id: String,
    pub change_generation: u64,
}
```

- [ ] 锁定依赖：Electron/CodeMirror 与现有候选相同版本；Rust serde/sha2/hmac/libc 沿用现有锁定版本，SQLite 依赖先核对官方文档/许可证与工具链再精确锁定。不通过 `latest` 或全局 npmrc 安装。
- [ ] 运行 `cargo test --manifest-path crates/product-core/Cargo.toml protocol` 与 Contract Foundation；正反 fixture 两端结论一致。提交 `feat: define local workspace product protocol`。

## Task 2：真实授权根、稳定身份与文件读取

**Files:** 创建 grant.rs、identity.rs、secure_fs.rs、store.rs、workspace/mod.rs、tests/workspace.rs、tests/support/mod.rs。

**Interfaces:** `Workspace::open_for_test(root: &Path, state: &Path) -> Result<Workspace, WorkspaceError>` 仅编入测试；生产由 Gateway 的已批准 ShellSelection 创建。`read(logical_path: &str) -> Result<DocumentSnapshot, WorkspaceError>`；Snapshot 字段 `document_id, file_identity, revision, content` 为 Rust 内部结果，跨 Renderer 正文通过 Handle，不能暴露 root。同根重复授权返回同一 Project，撤销立即使请求/Handle 失败。

- [ ] tests/support 创建 TestWorkspace：使用随机临时目录、Drop 只清理自己创建的目录；包含 `new()`、`write(relative, bytes)`、`read(relative)`、`core()` 方法，不访问真实用户 Vault。写失败测试。

```rust
#[test]
fn symlink_outside_grant_is_never_read() {
    let fixture = support::TestWorkspace::new();
    fixture.symlink_outside("逃逸.md", b"private");
    assert!(fixture.core().read("逃逸.md").is_err());
}
```

- [ ] 实现 root fd + openat/O_NOFOLLOW 逐段约束、非普通文件拒绝、大小/UTF-8 检查；不得仅 canonicalize 后再按路径 open。APFS 文件身份与逻辑 ID 分离，应用原子替换后保持 document_id，外部 rename 经 reconciliation 更新映射。
- [ ] SQLite Operational Store 放应用私有 user/device namespace，文件 mode 0600；Workspace 根身份漂移、权限撤销、root 被替换后失败关闭；不静默创建用户项目内业务数据库。
- [ ] 测试绝对路径、`..`、NUL、symlink、父目录替换、硬链接别名策略、中文/NFC/NFD、根撤销、重启重复挂载与身份稳定；运行 `cargo test --manifest-path crates/product-core/Cargo.toml workspace`，提交 `feat: add authorized Rust workspace reads`。

## Task 3：自动保存事务、草稿与冲突恢复

**Files:** 创建 transaction.rs、recovery.rs、tests/crash_recovery.rs；扩展 store.rs 和 workspace.rs。

**Interfaces:** `save(document_id, base_revision, proposed_bytes, change_generation) -> Result<SaveOutcome, WorkspaceError>`；`SaveOutcome::Committed { revision, change_generation }` 或 `Conflict { conflict_id }`。Core 保留 Base/Current/Proposed 与哈希；UI 仅取得 scoped Handle。`recover()` 只恢复当前 grant 内自身 journal，不能盲目覆盖新外部 revision。

- [ ] 写旧 revision 与外部编辑测试；fixture 的 `save/read_document/restart/recover` 是同一 Rust Workspace 实现的测试适配，不是另写 mock。

```rust
#[test]
fn external_edit_survives_stale_save() {
    let fixture = support::TestWorkspace::new();
    fixture.write("正文.md", b"base");
    let base = fixture.core().read("正文.md").unwrap();
    fixture.write("正文.md", b"external");
    let outcome = fixture.core().save(&base.document_id, &base.revision, b"local", 1).unwrap();
    assert!(matches!(outcome, superwagie_product_core::workspace::SaveOutcome::Conflict { .. }));
    assert_eq!(fixture.read("正文.md"), b"external");
}
```

- [ ] 实现“持久草稿 → prepared journal → 重新核对身份/hash → 原子发布 → committed → revision event”；同目录 staging、flush、父目录同步；并发外部写窗口必须有平台安全交换/保留旧 inode 的冲突证据，检测到不一致保留两份并停止，不能把 rename 本身称为 CAS。
- [ ] 逐 mutation point 注入退出、满盘、权限撤销、外部 write/rename；重启后只能 committed/recovering/conflicted。未完成草稿与失败 evidence 不作为缓存删除；正常退出先确认草稿 durable，没确认前 UI 不显示已保存。
- [ ] 三种冲突动作都绑定 conflict_id 与最新 revision：“合并两份内容”“保留当前版本”“使用磁盘版本”；再次外部变化重新冲突，不能用旧确认覆盖。
- [ ] `cargo test --manifest-path crates/product-core/Cargo.toml` 全绿后提交 `feat: persist workspace drafts and recover conflicts`。平台 CAS 行为若不能得到充分证据，保持写路径禁用并报告，不削弱契约。

## Task 4：Electron/Rust 真正启动、授权与 Query 恢复

**Files:** 创建 main/、preload/、query-store.mjs、gateway.rs、query.rs、scripts/build.mjs、scripts/dev.mjs；tests/bridge.test.mjs、query-store.test.mjs。

**Interfaces:** `startDesktop({runtimeRoot, stateRoot})` 返回可关闭的应用实例，仅开发/测试启动器使用；Preload 提供具名 `chooseProject()`、`activateProject(projectId)`、`query(request)`、`command(intent)`、`subscribe(request, listener)`，最后两者仍限固定目录与 Schema，不能任意转发。Core 注册 Surface 后返回不可由 Renderer 指定的 session identity。

- [ ] 先用 Node 内置测试覆盖拒绝子 frame、错误 origin、已销毁 Surface、伪造字段和未知方法，以及 Core 重启后的 Snapshot 重读。

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceQueryState } from '../src/renderer/query-store.mjs';
test('core restart invalidates the old snapshot', () => {
  const state = reduceQueryState({ status: 'ready', snapshot: { snapshot_revision: 4 } }, {
    message_type: 'subscription.resync_required', reason: 'core_restarted', next_action: 'query.execute'
  });
  assert.equal(state.status, 'resync_required');
  assert.equal(state.canWrite, false);
});
```

- [ ] 使用现有候选握手/超时测试指导拆分 core-client/supervisor；传输含 1 MiB 限制、私有 channel nonce、序号/replay 拒绝、双方身份和 parent-death。移除 PoC 专属 terminate/crash/self-test 权限；测试注入仅测试构建可用。
- [ ] Core 握手成功才创建 app_ui；目录选择器取消无挂载，选择结果仅 Shell→Core；Main 不保留 Workspace 路径、不直接访问正文。资源协议校验 audience、revision、TTL、size/range、撤销；静态资源只来自固定构建目录，禁止 file://。
- [ ] 正常退出 checkpoint；Core 首次崩溃受控重启一次，第二次只读与修复提示；Renderer 重建重订阅；旧请求回包不得覆盖新 Project。
- [ ] `npm --prefix apps/desktop run test:unit`；`npm --prefix apps/desktop run dev` 实际启动并检查进程退出无残留，提交 `feat: connect desktop shell to Rust workspace core`。

## Task 5：确认外框与 CodeMirror 三模式编辑

**Files:** 创建 renderer/workspace/、editor/、app.mjs、index.html、styles.css；迁移对应纯模型测试。

**Interfaces:** `createEditorHost({element, readDocument, saveDraft, requestAsset})` 返回 `{open(documentId), flush(), destroy()}`；`readDocument` 返回身份/revision 与受限正文；`saveDraft` 使用任务 3 的 generation 和冲突结果。只在受测迁移后移动纯模型，不在运行时 import PoC。

- [ ] 将 document-switch/save-queue 的竞态测试先迁到正式路径，确认不存在模块时失败；覆盖输入中切换、旧回包、保存中继续输入、冲突阻止关闭和 Project 切换。

```javascript
test('a conflicted draft prevents tab replacement', async () => {
  let opened = false;
  const result = await persistPendingBeforeSwitch({
    hasPendingChanges: () => true,
    persistPending: async () => ({ ok: false, code: 'SW_WORKSPACE_REVISION_CONFLICT' }),
    loadTarget: async () => { opened = true; }
  });
  assert.equal(result.opened, false);
  assert.equal(opened, false);
});
```

- [ ] 对照 confirmed-i2-original-replay.html、workspace-layout.html、document-tabs-refined-v4.html 建设工作台项目入口与三栏；保留暖色 token，未实现功能明确不可用，不伪造任务/Agent 成功。先修正文档中的快捷键冲突，按 CAC §1 保留 WD 的 ⌘O 快速打开 / ⌘P 命令模式。
- [ ] 迁移 CodeMirror 模型与三模式，无损 Frontmatter/WikiLink/Callout/未知语法；资源使用 Handle，HTML 通过白名单/Trusted Types，不执行活动内容或远程请求。
- [ ] 输入后 debounce 保存与持久草稿分开，显示“保存中/已保存/冲突/恢复待处理”；IME composition 中不提交中间组合文本。无本地修改时 reconciliation 更新编辑器，有修改时保留三方。单文件单 tab，不通过路径维持身份。
- [ ] 加载、权限、断开、失败、恢复与 stale 有明确动作；最小窗/缩放、键盘/ARIA、面板折叠和 focus 恢复回归；`npm --prefix apps/desktop run test:unit` 通过后提交 `feat: add persistent Markdown workspace UI`。

## Task 6：真实 UI 验收与当前机器证据

**Files:** 创建 scripts/test-ui.mjs、tests/app-ui.test.mjs 与 fixtures/local-mac-workspace/documents/；更新本机任务清单中本片状态，不能勾选全部 LOCAL-01。

**Interfaces:** `npm --prefix apps/desktop run test:ui` 启动实际构建的 Electron/Rust 与专属临时项目，输出 JSON、截图、进程退出结果；UI 通过正常 Preload/Product 命令，不得执行另一套仅测试文件写入路径。

- [ ] 建立独立测试驱动：原生选择器取消/授权通过真实 UI 至少人工或 CUA 验证一次；自动用测试配置的选择器返回值仅测试构建支持。编辑通过键盘/点击控件；测试不得直接改组件内部状态替代用户操作。

```javascript
// test-ui.mjs 输出结构；所有布尔值由真实断言生成，不预填通过。
const result = {
  schema_version: 1, scope: 'local-mac-workspace-markdown',
  platform: { os_version, build, arch }, candidate_sha256,
  checks, screenshots, limitations,
  admission_effect: 'none'
};
```

- [ ] 执行：启动 → 授权临时 Project → 打开“正文.md” → 中文/emoji → 三模式 → 自动保存 → 关闭重开 → 外部改动 → 冲突三动作 → Renderer/Core 崩溃 → 草稿恢复 → 撤销授权。检查实际文件字节与未知语法，而不只看截图。
- [ ] 安全链：活动 HTML、路径逃逸、跨 Project Handle、超限、过期回包、同名/改名与依赖污染；性能记录冷启动、首次打开、输入延迟、保存耗时/峰值内存，不把未定量项写成“快”。
- [ ] 在 1280×720、1440×900、1920×1080、125%/150% 缩放和最小窗口检查；本机原生中文输入/剪贴/焦点、Obsidian 往返人工事实与自动合成事件分别记载。
- [ ] 全量运行 Rust、本片 Node/UI、被迁移 PoC 回归、`node scripts/check-spec-refs.mjs`、现有 validation-status-audit 和 `git diff --check`。新 evidence 不自动改写平台 receipt、Format Ledger 或 signed_go。
- [ ] 使用 verification-before-completion 逐项核验后提交 `test: verify local Mac workspace editing lifecycle`；只有本片真实功能全通过才标记子切片完成，并列出剩余 Tasks/绘图/Agent/Viewer/服务任务。

## 自审与执行边界

- 需求映射：授权/身份→Task 2；文件事实/CAS/恢复→Task 3；认证/查询/进程故障→Task 4；CM6/外框/无损/异步状态→Task 5；真实用户链→Task 6。Task 1 提供所有后续消费者共用的结构边界。
- 此计划没有声称已有桌面产品、没有删除后续能力，也没有改变平台发布范围。
- 必须先完成 Task 1 的 payload 与测试，再接写权限；Task 3 无可靠 CAS/恢复证据不得靠 UI 勾选绕过。需要新依赖时只做开发安装，不使用用户全局环境或运行时联网补装。
- 当前状态：计划已编写，六个实施任务均未开始；本文件不是本机产品验收报告。
