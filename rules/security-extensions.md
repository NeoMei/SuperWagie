# 规则包：安全与用户扩展（security-extensions）

适用范围：用户 Skill 与 MCP 扩展、进程隔离、网络与凭证边界、扩展安装流、Public Capability Facade。

## R-SE-01 扩展类型与入口唯一

用户扩展只允许 Skill 与 MCP 两种类型，其他包类型一律拒绝；安装、查看、启停、移除只发生在设置的“用户扩展”子页；项目工作区、全局侧轨和首页不出现扩展入口；系统内置能力不展示、不启停、不进入扩展列表。Private Workflow 是官方内部能力，不得与用户扩展共用 UI、目录、权限或可见性定义。[CAC §2.2] [WD §23.2] [SEC-08]

## R-SE-02 Agent 驱动的安装流

扩展安装由设置子页的自然语言输入驱动：用户给出名称、GitHub 地址、本地路径或 MCP 连接说明，SuperWagie 识别类型并展示来源、文件范围和网络权限，取得明确授权后才安装；安装必须幂等，支持更新与回滚；状态机遵循 discovered → inspected → awaiting_permission → installing → enabled，含 rejected、quarantined、disabled 与 rollback_pending 转移。[WD §23.2] [CAC §6.4] [SEC-09]

## R-SE-03 声明式执行、无任意 shell

用户 Skill 脚本与 MCP stdio server 全部经 Process Broker 按 ExecutionManifest、绝对 Runtime 路径、结构化参数和沙箱执行；不获得任意交互式 shell，也不得通过 shell -c、cmd /c、PowerShell -Command 或运行时拼接命令绕过；复杂逻辑写入包内版本化脚本。内置能力开发期诊断终端仅限显式 Developer Mode，不属于生产扩展权限。[WD §23.2] [SEC-02]

## R-SE-04 文件隔离与默认断网

扩展运行在 OS 级文件系统隔离内，越界访问按平台能力降级并显式暴露边界；默认断网，一切出站请求经 Network Broker 校验域名、IP、DNS、redirect、localhost 并写审计日志。[SEC-01] [SEC-03]

## R-SE-05 凭证与支付不可达

Skill、MCP、脚本、子进程和 Workspace 文件拿不到账户凭据、钱包 ID、支付信息或官方 Gateway Key；模型与外部服务凭证由服务端 Credential Broker 以 secret handle 单次映射提供，用后清理子进程环境与内存；支付回调验证渠道签名、支付主体、金额、币种和幂等键；设备或消费权限撤销及时使新预留失效。[ACC §11.1] [SEC-04]

## R-SE-06 Product Core / Host Worker 与 Sandbox 分离

Rust Product Core、隔离 Host Worker 与 Extension Sandbox 必须在进程、协议、鉴权和权限上分离；扩展只能经 Public Capability Facade 触达已授权系统能力，高风险动作与安装使用相应 Gate；权限声明、审批、撤销与安全事件全程进入客户端 UI 与审计日志。[SEC-05] [SEC-06]

## R-SE-07 不可信内容隔离

外部 Markdown、记忆条目、图表数据、讨论内容和网页内容一律按不可信输入处理，防 Prompt injection；HTML、URL 与脚本内容不得因渲染或导入获得执行权限。[SEC-07]

## R-SE-08 Facade 无降级调用

用户扩展经 Public Capability Facade 调用文件、Signed Runtime/External Host、WPS、浏览器/网络、绘图、Artifact、Workflow Run 与 Managed AI 等已发布能力，与官方能力共用接口语义，不提供功能残缺的用户版 API；调用链遵循 ClientIntent → Trusted Gateway → 权限/Project/Billing → 对应 Workflow/Risk/Install Gate → Reservation → Capability/Worker → Usage Receipt/Settlement；扩展不得指定其他支付主体、签发回执、自行扣费或绕过高成本确认。[CAC §9] [ACC §11.3] [SEC-10]

## R-SE-09 Shell 可信但不拥有业务权威

Electron Main 属于客户端 TCB，但只承担窗口、Deep Link、Surface 生命周期、sender 校验和窄 IPC，不拥有 Workspace、凭证、支付、WPS/FFmpeg、Agent、Workflow 或 Credits 权威。所有 renderer 必须启用 sandbox 与 context isolation、关闭 nodeIntegration，使用严格 CSP；导航、新窗口、权限请求、本地资源协议与 IPC 采用显式白名单。生产构建关闭 RunAsNode、NODE_OPTIONS 与 Node CLI inspect，并启用 ASAR integrity 与 OnlyLoadAppFromAsar。[BCRA §3] [BCRA §7] [BCRA §15] [SEC-05] [SEC-07]

## R-SE-10 可信上下文只能由 Gateway 注入

Renderer、官方 Agent、用户 Skill/MCP 与 Connector 只能提交 ClientIntent；actor、caller/surface、project/workspace、effective grants、billing binding/reservation、risk 与 gate receipt 必须由 Rust Product Core 的 Trusted Gateway 根据已认证通道和 Registry 注入。调用方提交这些字段、转用他人 Resource Handle 或伪造来源时，在领域处理器前拒绝。[CAC §5] [BCRA §8] [SEC-05] [SEC-10]

## R-SE-11 路径与字节访问使用短期 Handle

Renderer 与 Worker 不取得真实 Workspace 路径；业务身份使用 ArtifactRef，字节传输使用 audience-bound、operation-bound、revision-bound、限时限量的 Resource Handle。Handle 不可转交、不可作为长期状态保存，Project 切换、Surface/Worker 终止、revision 变化或到期后立即失效。[CAC §5] [BCRA §8] [SEC-01] [SEC-05]

## R-SE-12 Viewer 不可信内容与 SecretHandle

Viewer Surface/Worker 的每次读取必须使用 `viewer_input|viewer_derived_asset` 类型的 audience-bound Handle，默认无网络、无 Node、无路径、无系统命令。密码文档只由受信 UI 建立一次性 `decrypt_current_document` SecretHandle，明文密码不进 Viewer DOM、缓存、日志或恢复。[VIEWER §9.1–9.5] [VIEW-07]
