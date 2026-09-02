# 视频课件、OpenMontage 与 Remotion 技术可行性

> 状态：研究记录；直接集成路径已放弃，生产架构由 `07-轻量视频制作内核-五场景.md` 取代  
> 基准日期：2026-08-29  
> 适用范围：保留 OpenMontage、Remotion 的技术与许可证证据，不再作为生产依赖方案

> **后续确认：** SuperWagie 将独立重写轻量视频制作内核，不复制或集成 OpenMontage/Remotion 代码。首发按优先级固定为网站 Demo、教学课件、PPT 讲解、图片绘本和照片动态五个场景。当前生产定义见[轻量视频制作内核与五个首发场景](07-轻量视频制作内核-五场景.md)。

> **架构更新（2026-09-01）：** 本报告中的 OpenMontage/Remotion 研究结论仍有效；生产架构已被 BCRA 与 `07-轻量视频制作内核-五场景.md` 取代。产品不探测系统 Chrome、不首次下载 Headless Shell，也不采用 Tauri/System WebView；帧渲染进入独立 Electron Render Worker Host，再交给 FFmpeg/Media Worker。

## 1. 历史研究结论与当前采用边界

制作视频课件可以作为 SuperWagie 的第四类正式交付物，与 PPT、长文档、HTML 一样从智能工作区的 Content Baseline 出发，进入独立 Delivery Project 和 Durable Workflow。

以下是从两个项目中提炼出的流程结构，不代表集成其源码或运行时。当前采用边界是：

```text
Markdown 内容与来源
        ↓
Video Courseware Private Workflow
        ↓
课程方案 → 讲稿 → 分镜 → 代表样片 → 素材 → 合成 → QA
        ↓
SuperWagie 自有 Scene Renderer + Chromium/FFmpeg 媒体层
        ↓
MP4 + 字幕 + 封面 + 来源与 QA 报告
```

- OpenMontage 只提供可研究的视频生产管线、阶段 Director、Artifact、检查点和质量门思路；
- Remotion 只提供帧驱动合成、浏览器预览和本地渲染方面的研究参照；
- SuperWagie 提供唯一用户界面、Agent Composer、文件事务、Durable Workflow、Credits、Managed AI、权限和 Review；
- 用户不看到 OpenMontage Backlot、Remotion Studio、Remotion Editor Starter、代码编辑器、Provider 面板或 Skill 自带表单；
- 生产包不集成、分发或动态调用 OpenMontage/Remotion 代码；视频能力是 SuperWagie 自研的系统内置能力，不出现在设置、扩展列表或独立工具入口中。

功能结论为 `FEASIBLE_CONDITIONAL`，不是无条件可发布。对 OpenMontage/Remotion 的许可证研究用于解释为何放弃直接集成；生产代码仍必须通过 clean-room provenance、Chromium、FFmpeg/codec、字体和素材许可证审查。

## 2. 产品范围

### 2.1 V1 课程类型

V1 聚焦知识工作和教学交付，不把 OpenMontage 的全部视频管线暴露成产品菜单：

- 动画讲解课：概念、方法、知识点、数据和流程的旁白式讲解；
- 屏幕演示课：软件、网页、终端和操作流程演示；
- 图文讲授课：Markdown、PPT、图表、图片、录屏和旁白的混合课件；
- 有素材的讲师课：对用户提供的讲师视频进行剪辑、字幕、插图和章节包装。

数字人、复杂角色动画、电影预告、社交媒体批量切片和多语种配音可以复用同一底层能力，但不作为 V1 视频课件闭环的前置条件。

### 2.2 Agent-only 交互

用户通过自然语言提出“把这些内容做成一节视频课”，或在“制作交付物”中选择“视频课件”。之后始终在 SuperWagie 的交付引导视图中完成：

- 右侧是统一 Agent Composer、问题、选择、确认和运行状态；
- 中间是课程方案、讲稿、分镜、素材、代表样片和最终视频 Review；
- 左侧是来源与视频交付目录；
- 播放/停止沿用全局 Agent 交互，不出现 Skill 自有运行按钮；
- 可以展示结构化卡片、媒体选择器、视频播放器和时间点批注，但这些都是 SuperWagie 原生 Guided Workflow 组件，不是被嵌入的 OpenMontage/Remotion UI。

用户不直接编辑 React/Remotion 代码，也不直接操作多轨时间线。修改通过 Agent 语义完成，例如“第 3 段慢一点”“这一幕换成流程图”“字幕太密”“保留旁白但替换画面”。系统把这些修改绑定到稳定的 scene、asset、narration 和 revision ID。

## 3. 与当前八阶段的研究映射

本研究不再定义另一套产品阶段。当前唯一阶段定义与主规范 §20.5 一致：

1. **内容就绪**：检查目标、受众、知识范围、事实来源和必要素材；不足时先回到 Markdown 补充。
2. **制作场景与设定**：确认 Video Profile、课程/展示方案、时长、画幅、讲授方式、语气、字幕、品牌要求、章节与节奏。
3. **内容脚本**：形成按时间分段的旁白与屏幕文字，校验事实、术语、时长和口语可听性。
4. **分镜、素材计划与 Credits 估算**：把脚本映射为 scene plan，明确画面、动画、图表、录屏、素材来源、转场和成本。
5. **代表样片**：用 10–15 秒代表内容制作真实画面、旁白、字幕和运动样片；通过后锁定视觉与运动语言。
6. **素材生产**：生成或整理图片、视频、图表、录屏、语音、音乐、音效和字幕，并形成可恢复的编辑决策。
7. **完整合成与媒体 QA**：自有 Scene Renderer 与 Chromium/FFmpeg 完成渲染；执行黑帧、静音、字幕越界、音量、素材缺失、时长和抽帧视觉检查，只返工受影响场景。
8. **最终 Review 与导出**：在 SuperWagie 中播放、按时间点批注、接受或返工，最终导出视频、字幕、封面、章节和来源说明。

必经人工门包括：制作设定与成本、内容脚本、分镜、代表样片和最终 Review。低成本、可逆的内部步骤由 Agent 连续执行，不要求用户逐步点击。

## 4. 目录与 Artifact

```text
交付物/AI入门-视频课件/
├── 项目状态.md
├── 来源清单.md
├── 课程方案.md
├── 讲稿.md
├── 分镜.md
├── scene-plan.json
├── 素材清单.md
├── 素材清单.json
├── 素材/
│   ├── 图片/
│   ├── 视频/
│   ├── 图表/
│   └── 录屏/
├── 音频/
│   ├── 旁白/
│   ├── 音乐/
│   └── 音效/
├── 字幕/
├── 样片/
├── 渲染/
├── 审查/
│   ├── QA报告.md
│   └── 时间点批注.json
├── 输出/
│   ├── 课程.mp4
│   ├── 课程.srt
│   ├── 课程.vtt
│   ├── 封面.png
│   ├── 章节.md
│   └── 来源与授权.md
└── .superwagie/
```

Markdown 文件是人类可读的过程真相；JSON 是可验证、可重建的生产结构；MP4、字幕、封面和报告是版本化 Artifact。Remotion 临时 bundle、浏览器 profile、逐帧缓存和未完成编码只能位于能力 staging/cache，不进入项目的语义真相。

## 5. OpenMontage 适配

OpenMontage 当前架构的有价值部分是“Agent 读取 pipeline manifest，逐阶段执行 Director，生成结构化 Artifact，在人工门暂停，并在合成前后执行 QA”。这与 SuperWagie 的 Durable Workflow 方向一致，但不能把其运行时原样嵌入：

| OpenMontage 机制 | SuperWagie 对应实现 |
|---|---|
| YAML pipeline | Private Workflow IR / 版本化 Workflow Definition |
| stage director Skill | Agent Semantic Step + Capability Contract |
| checkpoint JSON | App Data SQLite durable state + 项目 checkpoint manifest |
| provider registry / `.env` | Managed AI Runtime + Credential Broker，Provider 对用户不可见 |
| Python tools | Reference Capability；成熟后按价值保留 Worker 或迁移 Rust |
| `video_compose` | SuperWagie Scene Renderer / Chromium / FFmpeg 高层 Capability |
| Backlot UI | 不采用；由 SuperWagie 原生引导、任务和 Review 替代 |
| CLI 运行和日志 | 封闭 Agent Runtime + 结构化事件 + 用户可理解的任务状态 |

第一阶段可以用独立、可读的 Skill、Schema 和脚本验证流程，但必须从第一天使用 SuperWagie 的 Managed AI、Artifact、权限、Credits 和 Workflow Contract。第二阶段不能把 OpenMontage 源码直接改名后闭源打包。

## 6. Remotion 适配

Remotion 适合承担帧级、可重复、数据驱动的视频合成：

- Composition 由 `fps`、画幅、总帧数和版本化 props 决定；
- 旁白时长、scene time range 和字幕时间统一换算为帧；
- 视频素材使用离线友好的帧提取路径，图片、字幕、图表和过渡使用确定性组件；
- 动画由当前帧派生，避免依赖 CSS 动画或实时计时器造成渲染不一致；
- 外部素材加载必须进入延迟渲染/超时/失败机制，不能产生静默缺帧；
- 渲染任务绑定 `workflow_revision`、composition hash、props hash、依赖版本和浏览器身份，保证缓存、重试和结果回执可验证。

本段是早期 Remotion 候选结论，已经废止。生产版不使用 Remotion 库、Renderer 或 Player；代表样片和最终视频使用 SuperWagie 原生播放器 Review，自有有限 Scene IR 由 Electron Render Worker Host 求值。

### 6.1 浏览器与 FFmpeg

Remotion 的本地服务端渲染会打开 Chrome/Chromium。该事实说明视频渲染需要固定浏览器身份，但 SuperWagie 不采用其“探测或下载浏览器”的默认分发逻辑。已确认路径是：

- Electron/Chromium 作为基础安装必装兼容单元；
- 视频使用独立 Electron Render Worker Host，不复用 app_ui、diagram_editor、artifact_preview 的 session、cache、网络、Resource Handle 或权限；
- 组件不能读取系统 Chrome profile、Cookies、扩展或用户浏览数据；
- 不探测系统 Chrome，不首次下载 Headless Shell，不把浏览器降为可选能力组件；
- FFmpeg/ffprobe 与内置能力所需 codec 随基础安装包并由 Runtime Manifest 锁定；
- 编码器、字体、色彩管理和媒体解码差异必须进入 macOS/Windows golden render 测试。

这项浏览器复用只共享已签名 Runtime 版本，不共享 renderer 状态或 Agent 环境；Rust 仍是 render job、Artifact、权限、取消、回执和恢复的唯一权威。

## 7. Managed AI、Credits 与安全

OpenMontage 中面向用户的 Provider 选择和 API Key 配置不进入 SuperWagie。视频生产只表达能力档位：

```text
ai.research(...)
ai.reason(...)
ai.generate_image(...)
ai.generate_video(...)
ai.text_to_speech(...)
ai.transcribe(...)
ai.generate_music(...)
ai.review_visual(...)
```

内部 Model Router 决定实际 Provider。用户只看到制作路线、质量、预计时长和 Credits 区间，不看到模型、Base URL 或 Key。

视频是高成本长任务，必须使用 `reserve → execute → settle`：

- 课程方案阶段给出区间估算；
- 代表样片单独结算，避免未经确认直接批量生成；
- 每个素材、scene、旁白和 render 使用稳定请求 ID；
- 成功 Artifact 不因重试重新生成或重复扣费；
- 余额不足在场景边界或渲染检查点暂停；
- 外部素材必须记录来源、许可证、授权状态和派生关系；
- 项目文档、用户视频和未发布课件不得被上传到未声明服务。

## 8. 许可证与发行边界

### 8.1 OpenMontage

当前 `calesthio/OpenMontage` 主仓库的 `LICENSE` 是 GNU AGPLv3。基于该源码修改、组合并作为 SuperWagie 闭源系统能力发行，会触发必须由专业法律审查判断的强 copyleft 和网络交互义务，不能按普通 MIT/Apache 依赖处理。

当前推荐路径：

1. 将公开的产品概念、阶段划分和 Artifact 思路作为研究输入；
2. 由 SuperWagie 独立定义 Workflow IR、Schema、Prompt、工具契约和实现，不复制 OpenMontage 代码、Prompt、模板或受版权保护的具体表达；
3. 建立 provenance 记录和 clean-room 边界；
4. 如果希望直接复用 OpenMontage 代码，则必须先取得权利人的独立商业许可，并由法律审查确认。

在商业许可或 clean-room 方案确认前，`OpenMontage direct bundling = NO_GO`。

### 8.2 Remotion

Remotion 官方明确说明其并非 OSI 意义上的开源软件。个人和不超过 3 人的组织有 Free License；4 人及以上的协作或公司需要 Company License。官方当前还把视频编辑器、prompt-to-video 应用和嵌入 Remotion Player 等自动化产品列为 “Remotion for Automators”。

SuperWagie 属于面向最终用户的自动化视频创建产品，应在发布前向 Remotion 确认具体授权档位，并把 render 计量、许可证凭证、升级和离线行为纳入设计。Remotion 许可证也不自动解决 H.264/AAC 等编解码专利或第三方媒体授权问题。

在取得适用授权前，`Remotion commercial release = RESEARCH_REQUIRED`。

## 9. 必做 PoC

| PoC | 验证内容 | 通过标准 |
|---|---|---|
| VID-P1 | Markdown → 讲稿 → scene plan → 30 秒课件 | 断点恢复后结果与请求不重复，过程 Artifact 可读 |
| VID-P2 | 代表样片确认后局部返工 | 修改单一 scene 只失效其下游，不重做已验收素材 |
| VID-P3 | 自有 Scene IR 跨平台渲染 | Electron Render Worker Host 在 macOS 与 Windows 11 均成功，字体、字幕、色彩和时长达到阈值 |
| VID-P4 | Signed Runtime Image 与 Job 隔离 | 不读取用户 profile；Chromium 版本固定、随安装完备；Job session/cache/ResourceHandle 可回收 |
| VID-P5 | 视频 Review | 流畅播放、逐帧/逐秒定位、时间点批注和 revision 过期检测 |
| VID-P6 | 媒体 QA | 黑帧、静音、字幕越界、资源缺失和音量异常均有可复现检测 |
| VID-P7 | Credits | 样片、素材和渲染 reserve/settle 幂等，失败与取消不重复扣费 |
| VID-P8 | UI 隔离 | 生产包无法进入 Backlot、Remotion Studio 或 Skill 自带 UI |
| VID-P9 | 许可证准入 | OpenMontage 路径、Remotion 授权、FFmpeg/codec、字体和素材形成签字结论 |

## 10. 参考来源

- [OpenMontage 仓库](https://github.com/calesthio/OpenMontage)
- [OpenMontage Agent Guide](https://github.com/calesthio/OpenMontage/blob/main/AGENT_GUIDE.md)
- [OpenMontage Architecture](https://github.com/calesthio/OpenMontage/blob/main/docs/ARCHITECTURE.md)
- [OpenMontage GNU AGPLv3 License](https://github.com/calesthio/OpenMontage/blob/main/LICENSE)
- [Remotion 仓库](https://github.com/remotion-dev/remotion)
- [Remotion openBrowser API](https://www.remotion.dev/docs/renderer/open-browser)
- [Remotion License & Pricing](https://www.remotion.dev/docs/license/pricing)
- [Remotion License FAQ](https://www.remotion.dev/docs/license/faq)
