# 超级牛马（SuperWagie）HTML Taste 内置能力设计

> 状态：已确认产品方向的实施级补充  
> 日期：2026-08-29  
> 上游参考：`https://github.com/leonxlnx/taste-skill`  
> 审查快照：commit `ccbc15639c97057cbfcf32ecebc38ef716e4bb37`  
> 许可证：MIT，生产分发必须保留版权与许可声明

## 1. 目标与边界

SuperWagie 将 Taste Skill 的设计判断与质量规则吸收到 HTML Delivery Workflow，使 Agent 生成的页面具有明确的受众、视觉语言、版式节奏、真实素材、响应式行为、动效动机和交付前检查，不再依赖常见的 AI 模板化页面。

该能力只服务 HTML 交付物：landing page、产品介绍、活动页、作品集、编辑型长页和适合静态发布的内容页面。它不用于 SuperWagie 客户端、Tasks、Markdown 编辑器、设置、数据表、复杂后台或多步产品工作流。客户端继续使用已经确认的暖调、清晰、克制视觉基线。

## 2. 为什么不能直接运行上游 Skill

上游默认 `design-taste-frontend` 当前仍标记为 v2 experimental，并包含按场景选择 React/Next.js、Tailwind、Motion、GSAP 和第三方设计系统的建议。SuperWagie 不能在用户任务执行时通过 `npx skills add` 获取最新内容，也不能把建议命令当作可直接执行的授权。

生产版使用经过审查的冻结快照和 SuperWagie 适配层：

- 固定 source commit、内部 capability version、许可文本和 SBOM 记录；
- 把设计判断、禁止模式和 pre-flight checklist 转译为版本化 Policy IR；
- 把外部包建议转换为 Dependency Resolver 请求，只有已锁定、许可允许、通过安全检查的依赖才能进入构建；
- 上游更新只进入独立评估，不自动改变已发布客户端和历史 Delivery Run；
- 用户不看到 Taste Skill 名称、路径、Prompt、技术旋钮或上游安装方式。

## 3. 内部架构

```text
HTML Delivery Workflow
├── Brief Interpreter
│   └── page kind / audience / brand / constraints
├── HtmlTastePolicy
│   ├── design read
│   ├── variance / motion / density policy
│   ├── design-system and stack recommendations
│   ├── anti-template rules
│   └── pre-flight checklist
├── Asset Planner
│   └── user assets / managed image generation / licensed assets
├── Site Builder
│   └── approved locked dependencies + static output
├── Browser Review
│   └── desktop / tablet / mobile / accessibility / performance
└── Official Publisher
    └── static bundle / stable share URL / update / rollback / revoke
```

`HtmlTastePolicy` 是 Private Policy Pack，不属于 Public Capability Facade。用户 Skill 可以调用公开的 HTML/Artifact/Browser 等高层能力，但不能读取或覆盖官方 Workflow 的私有规则。

## 4. 七阶段接入

| HTML 阶段 | Taste 能力职责 | 用户可见结果 |
|---|---|---|
| `html.content_ready` | 检查内容、品牌资产和真实素材缺口 | 缺口清单与补充引导 |
| `html.publish_goal` | 识别页面类型、受众、目标与约束 | 发布目标确认 |
| `html.information_architecture` | 检查信息层级和版式重复风险 | 信息架构与组件计划 |
| `html.visual_direction` | 形成 design read、视觉密度和动效方向 | 代表性页面真实效果图 |
| `html.local_build` | 对构建栈、素材、字体、动效和组件执行规则 | 可运行本地静态站点 |
| `html.browser_review` | 执行三断点、可访问性、性能和 anti-template pre-flight | 问题清单、修复回执和最终预览 |
| `html.official_publish` | 不参与发布权限，只把通过验收的 bundle 交给 Publisher | 官方 Host 链接与版本回执 |

用户通过“更克制”“更活泼”“信息密一点”等自然语言调整方向。内部可以维护 variance、motion、density 等数值，但 UI 不提供面向普通用户的工程旋钮。

## 5. 技术栈与依赖原则

- HTML 交付目标优先，框架只是实现选择；简单静态页面不得因规则默认而强制引入 Next.js。
- 只有在页面确实需要组件状态、复杂交互或动效时才引入相应 Runtime。
- Motion、GSAP、设计系统和字体包均属于可选锁定依赖；缺失或不兼容时降低动效或改用原生 Web 能力，不阻止 HTML 基础交付。
- 生产任务禁止运行未固定版本的全局 `npm install`、`npx` 或远程脚本。
- 官方 Host 只接收最终静态 bundle、manifest 和发布元数据，不接收 Skill、Prompt、项目源文档或 Agent 对话。

## 6. 必须保留的质量规则

- 先判断页面类型、受众、品牌资产和安静约束，再选择设计语言；
- 同一页面保持色彩、圆角、字体层级和主题一致；
- 避免连续重复的三卡片、左右交替和无内容 bento 等模板化结构；
- 使用用户素材、Managed Image 或许可明确的真实素材，不用装饰性 div 假装产品截图；
- 动效必须解释层级、叙事、反馈或状态变化，并提供减少动效路径；
- 桌面、平板、移动端都必须真实浏览器验收；
- CTA 对比度、键盘焦点、语义结构、替代文本和错误恢复进入发布前检查；
- 检查 LCP、CLS、资源体积、断链和控制台错误；
- 不把 Taste 的写作偏好当作用户内容规范，用户原文、品牌术语和法务文本优先。

## 7. 两阶段产品化

第一阶段以冻结的 `SKILL.md + Policy Adapter + Evaluation Suite` 调试，保留来源映射和可读规则，便于比较上游行为与 SuperWagie 适配行为。

第二阶段把稳定规则转译为签名的 Private Policy Pack。适合确定性执行的 HTML lint、依赖检查、响应式探测、断链和性能预算可以 Rust 化；设计推理和自然语言判断继续由 Managed AI 与 Workflow 承担，不为追求 Rust 化而把判断规则硬编码成脆弱的 if/else。

## 8. 验收

1. 同一内容针对企业采购、普通消费者和活动宣传生成不同且合理的设计方向；
2. 视觉方向阶段展示真实代表页面，不只展示色板或文字描述；
3. 简单静态页不被强制升级为 Next.js；复杂交互页的依赖均有锁文件、许可证和构建回执；
4. 三断点没有横向溢出、裁切、不可见 CTA 或破坏阅读顺序；
5. 键盘、读屏标签、对比度和减少动效检查通过；
6. 页面没有重复模板结构、假产品截图、无意义动效或随机主题切换；
7. 上游仓库变化不会改变已发布客户端，升级必须重新跑 golden pages 与 browser review；
8. 静态包通过 Official Publisher 发布、同链接更新、回滚和停止分享，且不包含私有 Policy、Prompt 或项目源文档。
