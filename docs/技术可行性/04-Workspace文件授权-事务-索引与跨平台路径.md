# 技术可行性 04：Workspace 文件授权、事务、索引与跨平台路径

> 状态：macOS Workspace/Crash/Markdown 固定 fixture 已执行；Windows 真机仍待补跑  
> 日期：2026-09-01  
> 范围：`WS-01`～`WS-10`，以及它们对 `MD-03`、`MD-07`、`MD-08`、`MD-09`、`WF-05`、`WF-08`、`WF-09` 的基础约束  
> 结论等级：十项要求均为 `FEASIBLE_CONDITIONAL`，但没有任何一项可以只靠普通路径字符串和文件监听器完成。

## 1. 本轮结论

Workspace 层技术可行，但必须把它作为 Rust Core 的安全和一致性边界，而不是前端文件工具集合。

推荐结构：

```text
Chromium renderer / Agent / Capability
        │
        │ typed semantic operations
        ▼
Rust Workspace Manager
├── Grant Registry
├── Logical Mount Table
├── Root-handle Path Resolver
├── Revision / CAS Service
├── File Transaction Journal
├── Reference Rewrite Planner
├── Watcher + Reconciler
└── Incremental Indexer
        │
        ▼
APFS / NTFS / local files
```

必须同时成立的原则：

1. **文件是内容真相**：Markdown、Excalidraw、draw.io、Office 和媒体文件仍归用户所有；
2. **SQLite 是可重建索引**：删除数据库后可以重新扫描恢复；
3. **事件不是事实**：FSEvents、ReadDirectoryChangesW 和 `notify` 只提示“可能发生了变化”；
4. **路径不是授权**：授权绑定 root identity、访问模式和 OS locator，不能仅保存字符串前缀；
5. **写入不是覆盖**：所有写入都带 base revision，优先语义 patch，冲突时保留 Base/Current/Proposed；
6. **单文件原子不等于多文件原子**：多文件修改必须有 journal、staging、恢复和补偿；
7. **机器状态不成为第二份语义真相**：隐藏 ledger 只保存 revision、receipt、transaction、index 和恢复信息；
8. **WebView 和 Skill 永远不拿任意真实路径文件 API**。

### 1.1 关键技术判断

| 问题 | 结论 |
|---|---|
| 能否持久授权用户选择的目录 | 可以；公证直装版用产品 Grant Registry，macOS App Sandbox 形态另加 security-scoped bookmark |
| 能否让 Worker 看见统一 `/workspace` | 可以，但推荐使用逻辑 URI/Host API，不创建 FUSE，不把真实路径暴露给普通 Capability |
| `canonicalize + starts_with` 是否足够 | 不足；有 symlink/reparse point 和检查后替换的 TOCTOU 风险 |
| 能否实现安全的单文件替换 | 可以；同目录 staging、刷盘、handle-relative replace、父目录同步/Windows write-through |
| 能否让多个普通文件拥有真正 OS 级原子事务 | 一般不可以；用 journal + staging + revision + crash recovery 实现应用级原子语义 |
| 文件监听能否准确还原 rename | 不能保证；必须用 file identity、digest 和对账扫描补足 |
| 能否无损更新重命名后的 WikiLink | 可以，但前提是 lossless parser、反向引用索引、revision recheck 和事务 journal |
| 大型 Vault 能否打开 | 可以；分阶段元数据扫描、按需 hash/parse、增量 FTS、取消和后台对账 |
| 是否需要引入 Git | 不需要；Git 可以作为用户可选能力，不应成为 Workspace 正确性的依赖 |

## 2. 授权与虚拟挂载

### 2.1 Grant 不是路径字符串

每次用户选择 Workspace 或附加来源目录，Rust Product Core 创建一条 `WorkspaceGrant`：

```text
WorkspaceGrant
├── grant_id
├── root_id
├── role                  primary | source | asset | delivery-external
├── access                read | read-write
├── display_name
├── user_selected_path_hint
├── os_locator            bookmark or platform locator
├── root_file_identity
├── volume_identity
├── created_at
├── last_verified_at
├── policy_origin         user | organization
└── state                 active | stale | missing | revoked
```

`user_selected_path_hint` 只用于显示和重新定位。真正访问前要重新打开 root、取得文件/卷身份并核对授权记录。

授权撤销必须：

1. 将 grant 标记为 revoked；
2. 关闭该 root 的目录句柄与 watcher；
3. 取消或暂停依赖该 root 的扫描和任务；
4. 使未执行的 Host Request 失效；
5. 重建 Agent/Worker 的会话级策略；
6. 保留已经提交的用户文件，不做隐式删除；
7. 把 staging 中尚未归属的输出转入有界 quarantine。

### 2.2 macOS 的两种发行边界

Apple 官方说明：采用 macOS App Sandbox 的应用可以通过系统选择面板获得目录访问；若希望退出重开后继续访问，需要保存 security-scoped bookmark，解析后调用 `startAccessingSecurityScopedResource`，结束时调用 stop。目录授权递归覆盖子项，但 POSIX 权限、ACL 和其他强制访问控制仍可能拒绝访问。

这证明持久目录授权可行，但 SuperWagie 还有 Signed Runtime Image 中的 Python/Node（若保留）、Codex App Server Worker、WPS Host Worker 与受控外部工具。Apple 的 App Sandbox 文档同时指出，子进程继承的静态权利不等于主进程运行时通过 PowerBox 增加的所有权利；用户选择目录也不能任意执行其中程序。

因此 V1 推荐：

- 使用 Developer ID 签名、公证和直接分发；
- 主应用不依赖 Mac App Store App Sandbox 才能工作；
- 用 SuperWagie Grant Registry、Rust Broker、Seatbelt Worker profile 和 Capability Manifest 实施产品权限；
- 对受 TCC 保护的目录仍由系统提示用户授权；
- 把 App Sandbox + security-scoped bookmark 作为后续独立发行模式 PoC，不把两种模式混为一谈。

如果未来要求 Mac App Store 发行，必须重新验证：

- security-scoped bookmark 向每个 Worker 的传递和生命周期；
- 系统 Runtime 和外部可执行文件能否在 entitlement 下运行；
- WPS 自动化、浏览器渲染和本地 sidecar 是否通过审核与运行限制；
- bookmark stale、目录移动、卷卸载和重新授权。

历史 Tauri PoC 的 `persisted-scope` / `plugin-fs` 只作为“前端命令 scope”研究证据。当前 Electron 架构不依赖这些插件；preload 只暴露生成的窄 IPC，Rust Grant Registry、OS bookmark、组织策略、root identity、Worker 重启与审计仍是唯一权限模型。

### 2.3 Windows 授权

Windows 桌面程序通常不需要像 App Sandbox 一样为普通用户目录保存 security-scoped bookmark。V1 仍必须坚持“用户选择才授权”的产品策略：

- Folder Picker 取得初始路径；
- Rust Product Core 打开 root handle 并记录 volume/file identity；
- 后续任务只通过 grant ID 访问；
- ACL、Controlled Folder Access、OneDrive Files On-Demand 或文件占用错误正常上报；
- 不因为进程本身拥有用户权限就向 Agent 暴露全部磁盘。

Windows 官方 `GetFileInformationByHandleEx(FileIdInfo)` 可从已打开 handle 取得 file ID；reparse point 可以通过属性检测，并用 `FILE_FLAG_OPEN_REPARSE_POINT` 在不跟随目标的情况下打开。这些 API 足以构成 Windows root identity 和 no-follow 解析的底层基础。

### 2.4 逻辑挂载不等于 OS 挂载

推荐对 Capability 暴露：

```text
workspace://primary/内容/方案.md
source://<grant-id>/调研/数据.xlsx
delivery://<delivery-id>/output/方案.pptx
artifact://<artifact-id>/<revision-id>
temp://<run-id>/...
```

协议内部也可以映射为 `/workspace`、`/sources/<id>` 等展示路径，但它们是逻辑名字，不创建 FUSE/WinFsp 挂载。

普通 Capability 调用：

```text
workspace.read_text(uri, expected_revision?)
workspace.apply_patch(uri, semantic_patch, base_revision)
workspace.move(from_uri, to_uri, rewrite_references=true)
workspace.list(scope_uri, cursor)
```

只有 Rust Product Core 在明确授权的 effect 中解析逻辑 URI，并向特定 Worker 签发 audience-bound Resource Handle；Renderer、Wasm 和普通 Worker 不接收无限制 absolute path。

## 3. Root containment 与链接攻击

### 3.1 为什么字符串检查不安全

以下流程有竞争窗口：

```text
canonicalize(path)
→ 确认 starts_with(root)
→ 稍后按原路径 open/write
```

攻击者或并发进程可以在“检查”和“使用”之间把某一级目录替换为 symlink、junction 或其他 reparse point，使后续 open 越出 root。大小写、Unicode normalization、Windows 路径别名和短文件名还会让纯字符串比较更加脆弱。

### 3.2 推荐的 handle-relative resolver

每次操作从已经授权并验证的 root handle 开始：

1. 拒绝 absolute path、空组件、`.`、`..`、NUL 和平台设备路径；
2. 把逻辑相对路径拆为组件；
3. 从 root handle 逐级打开子目录；
4. 每一级使用 no-follow 语义，检查对象类型；
5. mutation 的父目录必须以 handle 保持打开；
6. 最终 create/replace/rename/delete 相对于该父目录 handle 执行；
7. 重新核对 volume/root identity；
8. 记录操作所见的 file identity 和 revision。

平台路径：

| 平台 | 方向 |
|---|---|
| macOS/Unix | directory fd + `openat`/`fstatat`/`renameat`，中间组件 no-follow；必要时用 `rustix` 封装 |
| Windows | directory/file handle + `CreateFileW`，检测 reparse attribute/tag，使用 `FILE_FLAG_OPEN_REPARSE_POINT` 与 handle 信息核验 |

可以参考 Rust `cap-std`/cap-primitives 的 capability-based filesystem 思路，但正式实现仍要对 macOS、NTFS、junction、symlink、cloud placeholder 和网络卷做自己的 adversarial tests，不能因使用了 crate 就自动宣称安全。

### 3.3 V1 链接策略

默认规则：

- 不跟随越出授权 root 的 symlink/reparse point；
- mutation 路径的任何中间组件出现链接时默认拒绝；
- 最终目标是 symlink 时，原子替换链接本身，不在原目标上原地写；
- 外部链接读取只能在其目标另有 grant 时通过对应 grant 访问；
- Windows junction、mount point、OneDrive reparse tag 必须分类，不把所有 reparse point 粗暴等同为普通目录；
- 任何不认识的 reparse tag fail closed；
- 不对用户原文件做 in-place truncate，原子替换会切断文件 hardlink，从而避免改写 root 外的同 inode 文件；
- 删除仅删除 root 内目录项，不追随目标递归删除。

这会牺牲一部分“Vault 中任意 symlink 都透明可写”的便利，但安全边界清晰。后续如要放宽，必须按 link 类型和 operation 单独授权。

## 4. Revision、CAS 与外部编辑冲突

### 4.1 FileRevision

建议把 revision 定义为：

```text
FileRevision
├── document_id
├── root_id
├── observed_file_id
├── observed_relative_path
├── size
├── modified_time_hint
├── content_hash
├── parser_version
├── semantic_index_hash
└── file_revision_id
```

- `mtime + size` 只用于快速判定“可能没变”；
- 正确性边界必须比较内容 hash；
- `file_id` 帮助识别同卷 rename，但复制、云同步、恢复和换卷后不能保证稳定；
- `document_id` 由索引层维护，可结合 file ID、旧/新 path、digest、watch correlation 和邻域重新识别；
- 不应为了内部身份自动给所有用户 Markdown 注入 UUID frontmatter；
- delivery/project 等 SuperWagie 自己创建的目录允许有显式 ownership marker。

内容 hash 可以在本地索引使用 BLAKE3 取得速度优势；对外 Artifact manifest 和签名包仍使用 SHA-256。若避免两套 hash，全部使用 SHA-256 也可，PoC 应实测大型文件成本后决定。

### 4.2 语义 patch 协议

Agent 或 UI 提交：

```text
SemanticPatch
├── target_document_id
├── base_file_revision_id
├── operation
├── semantic_anchor
├── expected_old_fragment_hash
└── proposed_change
```

提交时：

1. current revision 等于 base：直接在 lossless source ranges 上应用；
2. current 已变化：用 heading/block ID/task ID/上下文锚点重新定位；
3. 唯一定位且旧片段匹配：生成 rebased preview；
4. 多义、目标删除或语义改变：产生冲突；
5. 冲突 UI 展示 Base / Current / Proposed，不能整文件覆盖。

编辑器自己的短时输入可以用内存中的 transaction/CRDT-like buffer，但磁盘提交仍必须经过同一 revision 协议。V1 不需要为了单用户本地 Workspace 引入完整协同 CRDT。

### 4.3 文件身份不是路径身份

rename 识别按证据强度排序：

1. 同一 watcher batch 中成对 rename + 相同 native file ID；
2. 对账时旧 path 消失、新 path 出现 + 相同 native file ID；
3. 相同 digest、size、相近时间且候选唯一；
4. Markdown 内容和邻域结构相似；
5. 否则按 delete + create 处理，不猜测。

路径移动到其他卷通常是 copy + delete，file ID 会改变。系统可以保留文档连续性候选，但涉及链接重写和 Workflow binding 时应要求确认。

## 5. 单文件与多文件事务

### 5.1 单文件原子替换

同一目录创建 staging 文件：

```text
prepare temp in destination parent
→ write full bytes
→ flush file
→ validate size/hash/format
→ recheck base revision
→ atomic replace relative to open parent handle
→ flush/write-through namespace change where supported
→ append commit receipt
```

Rust `std::fs::rename` 在 Unix 对应 rename，在 Windows 对应 `MoveFileExW` 并有 handle-based fallback，但跨 mount 无法工作。`atomic-write-file` crate 展示了同目录临时文件、`fsync`、`renameat` 的参考做法，同时明确说明 ACL、xattr、时间戳等元数据并不会自动完整保留。因此可参考其实现和测试，不应直接把它当成完整 Workspace Transaction Layer。

Windows `MOVEFILE_REPLACE_EXISTING` 可以替换已有文件，`MOVEFILE_WRITE_THROUGH` 可等待移动完成；但跨卷时可能退化为 copy + delete，所以 SuperWagie 的原子提升必须要求 staging 与目标位于同一 volume。

替换前后需要明确处理：

- 权限 bits、ACL、xattr、Finder metadata、Windows alternate streams 是否需要保留；
- 文件被 WPS/Office/杀毒软件占用；
- 磁盘满、只读卷、云文件未下载；
- 目标在提交前被外部编辑；
- 原文件是 symlink/hardlink；
- 大小写-only rename。

### 5.2 多文件应用级事务

普通文件系统不提供任意多个用户文件的一般原子提交。SuperWagie 应提供可恢复的应用级语义：

```text
Transaction
├── tx_id
├── operation plan
├── base revisions
├── staged new files
├── original snapshots / object refs
├── ordered commit records
├── reverse/compensation plan
└── state: prepared | committing | committed | recovering | conflicted
```

流程：

1. 在 SQLite 事务中登记 `prepared` 和所有 base revisions；
2. 把新内容写到同目标卷的私有 staging，验证 hash/格式；
3. 提交前重新读取所有 current revisions；任一变化则整体停在 conflict；
4. 按稳定顺序逐文件原子替换，每一步写 receipt；
5. 全部成功后在 SQLite 中标记 committed；
6. 崩溃重启后根据 journal 和实际 hash 决定继续、完成或进入人工恢复；
7. 不在用户已经再次修改文件后自动用旧 snapshot 强行回滚。

“应用级原子”意味着 SuperWagie 自己和重启恢复不会把半完成状态误认为成功；不能承诺其他编辑器在提交窗口内绝对看不到部分文件变化。

### 5.3 SQLite 位置和版本

Workspace index/ledger 与 Durable Workflow 机器状态均放在 SuperWagie App Data 的本机目录，而不是用户可能位于 NAS、Dropbox 或 OneDrive 的 Vault 内。SQLite 官方明确说明 WAL 不适用于网络文件系统，并提醒网络锁实现可能不可靠。

项目可移植性不通过复制 SQLite 实现。项目目录只保存人类可读状态、Artifact 与 `.superwagie/checkpoints/*.json`；在另一台机器打开后，SuperWagie 校验项目相对路径、内容哈希、Capability 版本和外部 receipt，再创建新的本地 run binding。未完成的外部 effect 不因导入而自动重放。

如果使用 WAL：

- 只允许本机数据库；
- 使用一个写入协调器，限制长事务和长读 transaction；
- 做有界 checkpoint；
- 处理 `SQLITE_BUSY`；
- 数据库仍可由 Workspace 重建，transaction ledger 则需要独立备份/完整性检测；
- 必须使用修复 WAL-reset bug 的 SQLite 版本。官方当前说明 3.51.3+ 已修复，某些旧分支有 3.44.6/3.50.7 backport，因此不能无条件依赖操作系统自带旧 SQLite。

推荐通过 Rust SQLite binding 固定并审计 SQLite 版本，而不是在每台机器上动态链接未知系统版本。

### 5.4 Working Set 写 Lease

多个项目可以并行执行；同一项目允许只读任务并行，也允许 Working Set 不重叠的写任务并行。写 Lease 使用 canonical file/subtree identity，而不是用户可变路径字符串，并记录 base revision、owner run/step、expiry 与 fencing token。

父目录与子路径、rename 源与目标、多文件引用更新集合、大小写或 Unicode 等价路径均必须判定为重叠。重叠任务排队或在前序提交后重新基于最新 revision 生成 patch，不允许同时覆盖后再依赖自动合并。外部应用不遵守 Lease，因此最终文件替换前仍必须重新执行 CAS；Lease 只协调 SuperWagie 自身任务，不能代替文件事务。

## 6. Watcher 只是提示，Reconciler 才是正确性机制

### 6.1 事件归一化

`notify` 当前稳定文档覆盖：

- macOS：FSEvents/kqueue；
- Windows：ReadDirectoryChangesW；
- 所有平台：polling fallback；
- 网络文件系统可能根本不产生事件；
- 不同编辑器保存同一文件可能产生完全不同的 create/modify/delete/rename 序列。

因此内部事件只保留低承诺模型：

```text
WorkspaceHint
├── root_id
├── paths[]
├── possible_kind
├── backend_cookie?
├── timestamp
└── rescan_required
```

事件处理：

1. 对 path/root 做短窗口去抖和聚合；
2. 不直接据事件修改最终索引；
3. 打开当前对象并重新读取 metadata/file ID/hash；
4. 与索引比较后生成 canonical create/modify/delete/rename；
5. overflow、coalesced event、watch root rename、resume from sleep 或 volume remount 时标记 root dirty；
6. dirty root 进入有界 reconciliation scan；
7. 网络/云盘允许启用 polling 模式并在 UI 标注一致性延迟。

不应该把 watcher cookie 当作永久 file identity，也不应该因为没有事件就认为文件没变。

### 6.2 自身写入来源标记

Workspace Manager 为每次 commit 记录：

```text
tx_id + target path + before revision + after revision + process nonce + commit time
```

收到 watcher hint 后，如果实际 after hash 与最近 receipt 一致，可以标记为 `origin=superwagie`；否则按 external change 处理。不要仅按时间窗口吞掉事件，否则会遗漏用户恰好同时做出的修改。

## 7. Unicode、大小写与跨平台路径

### 7.1 不建立全局 lowercase key

Apple 官方说明 APFS 默认大小写不敏感，但可以配置为大小写敏感；APFS 保留文件名原始大小写和 normalization，同时对 normalization 变体不敏感。Windows/NTFS 通常大小写不敏感，但目录可以有不同策略。由此得到：

- 访问时使用 OS 返回的原始名称；
- 内部不能全局 `lowercase(path)` 作为唯一键；
- 不能强制把用户文件名转换成 NFC/NFD 后再访问；
- 索引同时保存 lossless OS path、display path 和 collision key；
- collision key 只用于目标目录的冲突检测，不作为实际 open path；
- 所有测试都要覆盖 case-insensitive 与 case-sensitive volume。

Unix 上 Rust `OsString` 可能包含非 UTF-8 字节；Windows 路径可能包含不能无损转为普通 Unicode scalar 的序列。底层索引应有 lossless platform path representation，UI 对不可显示名称做可逆转义，不能用 lossy string 再写回磁盘。

### 7.2 SuperWagie 生成文件的 portable-name profile

用户现有文件保持原名。SuperWagie 新建项目和交付物时使用跨平台安全命名：

- 禁止 `/`、`\\`、NUL、Windows 保留设备名和控制字符；
- 禁止尾随点/空格；
- 保留中文和其他正常 Unicode，不强制拼音化；
- 限制单组件和总相对路径长度，为 WPS/Office/压缩包留余量；
- 发生大小写或 normalization collision 时附加短稳定 ID；
- 文件扩展名显式保留；
- 生成前在实际目标父目录做真实碰撞探测，而不是只按字符串判断。

具体长度阈值要用 Windows 长路径、WPS、解压和 OneDrive PoC 决定，不在没有实测前写死为营销承诺。

### 7.3 大小写-only rename

在大小写不敏感卷上，`A.md → a.md` 可能需要：

```text
A.md → .superwagie-rename-<tx>.tmp → a.md
```

两步都在同一父目录、同一 journal 中完成，期间重新验证 file ID/hash；目标碰撞时停止。引用显示应使用最终磁盘返回的 spelling。

## 8. 人类目录与稳定语义 ID

### 8.1 项目目录

用户可以重命名 `内容`、`来源材料`、`交付物` 等目录，因此系统不能靠固定中文名判定角色。推荐：

```text
项目名/
├── 项目说明.md
├── 内容/
├── 来源材料/
├── 交付物/
│   ├── PPT-发布会方案/
│   ├── 长文档-白皮书/
│   └── HTML-专题页/
└── .superwagie/
    └── project.json
```

`project.json` 只保存：

- project ID；
- schema version；
- role directory 的相对路径/identity；
- delivery IDs；
- ownership 和兼容信息。

`.superwagie/checkpoints/` 保存可迁移的版本化恢复描述，不保存活跃数据库、凭证或 Credits 账本。它是导入材料，不是本机 Workflow 的并发/事务真相。

项目目标、背景、决策、风险和状态仍在 Markdown，不能只藏在 JSON/SQLite。

如果用户移动或重命名角色目录，按 native ID + watcher/reconcile 更新 marker。marker 丢失时可以从人类文件和目录重新导入；不能把整个项目变成不可理解的内部对象。

### 8.2 每个交付物独立目录

每个 delivery directory 有：

```text
交付物/PPT-发布会方案/
├── 项目状态.md
├── 来源清单.md
├── 内容基线.md              optional human projection
├── 编辑稿/
├── 预览/
├── 输出/
└── .superwagie-delivery.json
```

marker 至少包含 delivery ID、kind、schema、project ID、created_by 和 ownership nonce。删除/清理时必须同时核对：

1. 当前路径仍在授权 root；
2. marker 与数据库 ownership 一致；
3. native identity/expected revision 合理；
4. 展示将删除的用户文件清单；
5. 默认移动到系统废纸篓或项目恢复区，而非不可恢复删除。

用户复制带 marker 的交付目录会产生 duplicate delivery ID。发现重复时按“导入副本”处理，创建新 ID 和新 Workflow binding；不得让两个目录同时写同一个 run。

## 9. 附件移动与 Markdown 引用更新

### 9.1 Reference Graph

索引保存 source ranges 与解析语义：

```text
Reference
├── source_document_id
├── source_revision
├── syntax_kind          wikilink | markdown_link | embed | html | property
├── raw_target
├── resolved_target_id?
├── heading_or_block?
├── source_range
└── resolution_state
```

重命名/移动时：

1. 从 Backlink index 找所有真实解析到目标 ID 的引用；
2. 计算 Obsidian 兼容的新相对链接或最短 WikiLink；
3. 保留 alias、embed、heading、block ID、URL encoding 和原语法风格；
4. 只 patch 对应 source range；
5. 对每个源文件带 base revision；
6. 先生成完整 preview 和 transaction plan；
7. 任一源文件变化则重算或进入 conflict；
8. 文件移动和全部引用 patch 进入同一 application transaction journal。

未解析、同名多义或未知插件语法不应自动猜改。系统在 preview 中列出“已更新、无需更新、无法安全更新”三类结果。

### 9.2 与 Obsidian 往返验证

需要建立真实 Vault fixture：

- WikiLink、Markdown link、embed；
- 相对路径、绝对 Vault 路径；
- 标题锚点、block ID、alias；
- 中文、空格、括号、`#`、大小写-only rename；
- 同名文件和未解析链接；
- Excalidraw Markdown 容器；
- 未知插件代码块和 properties。

每次测试都要执行：SuperWagie rename/move → Obsidian 打开/重载 → 检查引用 → Obsidian 再 rename → SuperWagie 重开并对账。仅解析单元测试不足以证明 `MD-09`。

## 10. 大型 Vault 的渐进索引

### 10.1 分阶段启动

```text
Phase 0 载入上次 snapshot 和目录树缓存
Phase 1 快速枚举 path/size/mtime/file ID
Phase 2 只对新增或可疑变化文件计算 hash
Phase 3 解析变化 Markdown，更新 node/link/task/property
Phase 4 在 SQLite transaction 中更新 FTS5 和 projections
Phase 5 后台提取附件、Excalidraw、draw.io 元数据
Phase 6 idle reconciliation / optional embedding
```

Workspace 打开不应等待所有文件全文解析完成。文件树、最近文件和当前文档先可用，索引状态明确显示“可用/更新中/部分结果”。

### 10.2 扫描策略

- 使用可取消、有限并发的 walker；Rust `ignore::WalkBuilder` 可参考其并行遍历、follow-links 开关、最大文件大小和 ignore 规则；
- 默认不跟随 symlink；
- `.git`、`node_modules`、缓存、输出和 `.superwagie` 机器目录采用明确 ignore policy；
- 超大二进制只存 metadata，不读入内存全文；
- Markdown 解析按文件级任务隔离，单文件失败不阻止整个 Vault；
- hash/parse/FTS 队列有背压、优先当前打开文件；
- watcher 高峰合并后按 path 对账，不为每个原始事件启动任务；
- 睡眠恢复、切换用户、卷重连和 watcher overflow 后运行分片 reconciliation；
- SQLite FTS5 可以用 external-content 或 contentless-delete 方案，但应用必须保证索引与 content table 一致。

### 10.3 必须测量而不是猜测

建立 1k / 10k / 100k 文件 fixture，分别包含：

- 小 Markdown；
- 大 Markdown；
- 大量链接、任务和 properties；
- 图片/PDF/绘图附件；
- 深目录、中文和碰撞名称；
- Git、node_modules 和输出噪声；
- APFS、NTFS、OneDrive，以及一个只承诺 polling 的网络目录。

记录：

- 首屏文件树时间；
- 当前文件可编辑时间；
- 冷启动完整索引时间；
- 增量修改到查询可见的 p50/p95；
- 峰值 RSS、数据库大小、WAL 大小；
- CPU、磁盘读取量、电池影响；
- 取消响应时间；
- watcher overflow 后对账耗时；
- 删除数据库后的完整可重建性。

建议交互目标作为 PoC 门槛起点，而非已证实指标：

- 缓存存在时 2 秒内显示文件树和最近内容；
- 普通单文件外部修改 1 秒内反映到索引；
- 用户输入和滚动不被后台索引阻塞；
- 100k fixture 可以渐进打开、取消和继续，不因一次全量扫描耗尽内存。

具体完整索引时长和内存上限应根据实测硬件分档后再确定。

## 11. 推荐参考项目与采用边界

| 项目/资料 | 用途 | 采用方式 | 不应误解为 |
|---|---|---|---|
| 历史 Tauri `plugin-fs` / `persisted-scope` | renderer command permission、scope 保存的研究样例 | 仅保留历史参考；当前通过 Electron preload 生成式窄 IPC → Rust Grant Registry 收口 | 当前生产依赖、完整 OS 授权或 Workspace transaction |
| Apple security-scoped bookmarks | App Sandbox 下持久用户目录授权 | 未来 sandboxed macOS distribution adapter | 公证直装版必须依赖的唯一机制 |
| Windows handle/file ID/reparse APIs | root identity、no-follow、rename 识别 | 通过 `windows` crate 封装和测试 | 单凭路径字符串即可安全 |
| `cap-std` / cap-primitives | capability filesystem 设计 | 参考/复用经过审计的 root-relative primitives | 自动覆盖 Windows/macOS 所有攻击面 |
| `atomic-write-file` | 同目录 staging、handle-relative rename | 参考其 Unix 实现和 crash tests；补 ACL/xattr/Windows 语义 | 完整多文件事务 |
| `notify` + debouncer | 跨平台 watcher | 事件 hint 输入；固定稳定版并封装 backend 差异 | 可靠、无遗漏的事件日志 |
| `ignore` WalkBuilder | 大型目录并行扫描与过滤 | 增量 index walker 候选 | 扫描后无需 watcher/reconcile |
| SQLite + FTS5 | derived index、事务 ledger、全文检索 | 固定修复版本，本机 App Data，单写协调 | 用户内容 Source of Truth 或网络共享数据库 |
| SessionReviewer / agentwiki-sync | CAS、proposal/apply、journal、merge | 复用事务模式和 fixtures | 直接替代本地 Workspace Manager |

不建议 V1 引入：

- FUSE/WinFsp 虚拟文件系统；
- Git 作为所有文件操作的事务层；
- 全 Vault CRDT；
- 仅依赖 watcher 的 event sourcing；
- 把 SQLite 数据库放到 Vault/云盘中；
- 为所有普通 Markdown 注入隐藏 UUID；
- Chromium renderer 或 Electron Main 直接获得任意文件系统读写、真实路径或 shell。

## 12. 分项可行性结论

| ID | 状态 | 实现路径 | 转为已证明前的验收 |
|---|---|---|---|
| WS-01 | `FEASIBLE_CONDITIONAL` | Grant Registry + OS picker/locator + root identity + revoke lifecycle | macOS 目录移动/重启/撤销、Windows ACL/OneDrive、Worker 重启 PoC |
| WS-02 | `FEASIBLE_CONDITIONAL` | root handle + component no-follow + reparse policy + handle-relative mutation | symlink/junction/TOCTOU/hardlink/case/path alias adversarial suite |
| WS-03 | `FEASIBLE_CONDITIONAL` | same-dir atomic replace + SQLite/file journal + staging + recovery | 每个 commit point kill/crash/disk-full/locked-file fault injection |
| WS-04 | `FEASIBLE_CONDITIONAL` | content hash + native file ID hint + Working Set write lease/fencing + semantic patch + CAS/rebase | SuperWagie 重叠写任务被排队；Obsidian/WPS 外部并发编辑不丢修改，Base/Current/Proposed 可恢复 |
| WS-05 | `FEASIBLE_CONDITIONAL` | `notify` hints + debouncer + root dirty + reconciliation scanner | rename storm、editor-save variants、overflow、sleep/remount、network polling |
| WS-06 | `FEASIBLE_CONDITIONAL` | lossless OS path + preserve spelling + per-dir collision probe + portable generator | APFS case 两种模式、NTFS、NFC/NFD、中文、长路径/WPS fixture |
| WS-07 | `FEASIBLE_CONDITIONAL` | human dirs + stable IDs + minimal project marker + identity reconciliation | 本地化、rename/move/copy/marker loss/duplicate ID 全部可解释恢复 |
| WS-08 | `FEASIBLE_CONDITIONAL` | delivery marker + ownership + independent Workflow/Artifact tree | 复制、重命名、删除、恢复不会串 run 或删除其他目录 |
| WS-09 | `FEASIBLE_CONDITIONAL` | parsed reference graph + source-range patches + multi-file journal | Obsidian 双向 rename corpus；歧义/未知语法不被错误改写 |
| WS-10 | `FEASIBLE_CONDITIONAL` | phased walker + change detection + incremental parser/FTS + cancel/reconcile | 1k/10k/100k 跨平台基准、资源和重建报告 |

## 13. 必须执行的 Workspace Spike

### 13.1 Spike A：授权、root identity 与撤销

macOS 和 Windows 各实现一个最小 Host：

1. 用户选择目录；
2. 保存 grant；
3. 重启后重新打开；
4. 目录 rename/move 后重新定位或明确 stale；
5. 授权撤销时关闭 watcher、取消 worker request；
6. 越权 URI 永久拒绝；
7. 记录 OS 错误而不暴露底层沙箱参数给普通用户。

另外评估公证直装与 macOS App Sandbox 两种模式，若后者无法支持固定 sidecar/system runtime/WPS，就正式列为 V1 `NO_GO distribution mode`，而不是阻塞直装版本。

### 13.2 Spike B：Path Adversary

自动化构造：

- symlink 指向 root 外；
- 中间目录在 check/open 间被替换；
- Windows junction 与未知 reparse tag；
- hardlink；
- `..`、绝对路径、UNC/device path；
- case 和 normalization collision；
- 大小写-only rename；
- 超长、中文、emoji、不可正常显示路径；
- root 自身被 rename/unmount。

所有 write/delete/move 必须 fail closed 或只影响 root 内目录项。

### 13.3 Spike C：File Transaction Fault Injection

实现 2～5 个 Markdown 的 rename + backlink rewrite，在以下位置 kill：

- journal prepared 前后；
- staging 每个文件后；
- 第一个 replace 前后；
- SQLite committed 前后；
- cleanup 前后。

再注入磁盘满、目标锁定、外部编辑、进程双开。重启后只能出现：完整成功、完整未开始、或有明确 Base/Current/Proposed 的恢复态；不能静默丢文件或误报成功。

### 13.4 Spike D：Obsidian Round-trip

用真实 Obsidian 和 fixture Vault 验证链接、任务、properties、未知语法、Excalidraw container 与附件 rename。输出逐文件 hash/diff、UI 打开结果和无法安全更新清单。

### 13.5 Spike E：Large Vault

跑 1k/10k/100k fixture 的冷启动、增量、overflow reconcile、删除 DB 重建和取消。固定硬件/OS/文件系统/SQLite/notify 版本，产出可复现实验脚本与原始指标。

## 14. Go / No-Go 条件

### 14.1 进入实施的条件

- root-handle resolver 通过 symlink/reparse/TOCTOU 攻击测试；
- macOS/Windows 授权、撤销和重启恢复均通过；
- 单文件和多文件 fault injection 没有静默数据丢失；
- concurrent external edit 始终 CAS/rebase/conflict，不整文件覆盖；
- watcher overflow 和网络无事件都能靠 reconciliation 收敛；
- Obsidian 往返语料没有未知语法破坏；
- 100k fixture 能渐进打开、取消、继续和重建；
- delivery ownership 在 copy/rename/delete 后仍不会串 run；
- 固定的 SQLite 版本包含当前 WAL-reset 修复。

### 14.2 No-Go 条件

- WebView 或普通 Capability 仍能调用任意真实路径 fs API；
- containment 仍依赖 `canonicalize + starts_with` 后再按原字符串操作；
- 把 watcher 事件当作不可遗漏的事实日志；
- 把多文件逐个 rename 宣称为真正 OS 原子事务而没有 journal/recovery；
- 外部修改后仍用旧全文覆盖；
- SQLite index/ledger 放在网络或同步 Vault 内；
- 目录角色只靠固定中文名，用户 rename 后项目失去身份；
- 清理 delivery 只看 marker 文件就递归删除；
- 没有真实 Obsidian 与跨平台文件系统测试就宣称严格兼容。

## 15. 一手资料

- Apple, Accessing files from the macOS App Sandbox: <https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox>
- Apple, APFS FAQ / filenames and normalization: <https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html>
- Apple, Files and directories: <https://developer.apple.com/documentation/technologyoverviews/files-and-directories>
- Microsoft, `GetFileInformationByHandleEx`: <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex>
- Microsoft, Reparse Point Operations: <https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-operations>
- Microsoft, `CreateFileW`: <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew>
- Microsoft, `MoveFileEx`: <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw>
- Tauri, File System plugin: <https://v2.tauri.app/plugin/file-system/>
- Tauri, Persisted Scope: <https://v2.tauri.app/plugin/persisted-scope/>
- notify-rs official repository: <https://github.com/notify-rs/notify>
- notify current Rust documentation: <https://docs.rs/notify/latest/notify/>
- Rust `ignore::WalkBuilder`: <https://docs.rs/ignore/latest/ignore/struct.WalkBuilder.html>
- Rust `std::fs::rename`: <https://doc.rust-lang.org/std/fs/fn.rename.html>
- `atomic-write-file` documentation: <https://docs.rs/atomic-write-file/latest/atomic_write_file/>
- SQLite Atomic Commit: <https://www.sqlite.org/atomiccommit.html>
- SQLite WAL: <https://www.sqlite.org/wal.html>
- SQLite FTS5: <https://www.sqlite.org/fts5.html>
