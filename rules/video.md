# 规则包：视频交付（video）

适用范围：视频 Workflow、五个 Profile、素材链、合成与验收。

## R-VD-01 单一入口自动路由

只有一个“制作视频”入口；Agent 按用户目标与素材在网站 Demo、教学课件、PPT 讲解、图片绘本、照片动态五个 Profile 中自动判断，用紧凑卡片说明识别结果并轻量确认；仅不明确时追问，不展示五张场景选择卡。[WD §20.5] [VID-01]

## R-VD-02 Clean-room 边界

SuperWagie 独立实现 Workflow、Scene IR、Timeline IR 和帧渲染器；OpenMontage 与 Remotion 只作研究参考，不复制源码、Prompt、模板或 Schema，不进入生产依赖。[WD §8.5] [VID-02] [VID-10]

## R-VD-03 确定性渲染内核

有限原语的 Scene IR 与 Timeline IR、frame/fps 确定性求值、scene ID、字幕、缓存、取消与局部重渲染按轻量视频内核定义实现。[WD §20.5] [VID-03]

## R-VD-04 帧渲染与媒体层

使用随基础安装包分发、与 Electron 同版本身份的独立 Electron Render Worker Host 按绝对帧号输出帧流，再交给独立 FFmpeg/Media Worker 编码与 QA；每个 Job 使用 ephemeral session/cache/network policy 与资源上限，版本、字体、Scene/Timeline/Asset hash 一起进入 Render Manifest。不得占用 App UI Renderer、探测系统 Chrome 或首次使用时下载浏览器组件。[WD §20.5] [BCRA §4] [BCRA §13] [VID-04]

## R-VD-05 统一素材链

图片、视频、录屏、TTS、音乐、音效、字幕走统一素材链与 Managed AI 路由；素材来源与授权必须可追溯，失败可恢复。[WD §20.5] [VID-05]

## R-VD-06 原生视频 Review

制作台以中央播放器为主、底部紧凑场景导航；逐帧/逐秒定位、时间点批注绑定 revision；返工通过 Agent 关联到 scene、asset、narration ID，不开放多轨编辑器。[WD §20.5] [VID-06]

## R-VD-07 Agent-only 边界

不提供代码编辑或多轨时间线，不打包 Remotion Studio、Backlot、Editor Starter、Provider 或 Skill 自带 UI；用户只经 Agent 驱动流程。[WD §8.5] [VID-07]

## R-VD-08 Credits 与长任务

分镜阶段给出 Credits 估算；样片、素材、TTS、生成视频与本地渲染的 reserve/settle 必须幂等，重复请求不重复扣费。[WD §20.5] [VID-08]

## R-VD-09 媒体 QA 与交付物

完整合成后执行黑帧、静音、字幕越界、音量、缺帧、色彩、编码 QA；场景级需确认项处理完毕才开放导出；最终交付 MP4、SRT/VTT 字幕、封面和来源说明。[WD §20.5] [VID-09]

## R-VD-10 PPT 讲解事实源

PPT 讲解以真实 WPS/PowerPoint 渲染页为视觉事实源，不由视频内核重新排版；需修改页面正文时返回 PPT Workflow，重渲染后再进入视频。[WD §20.5] [VID-11]
