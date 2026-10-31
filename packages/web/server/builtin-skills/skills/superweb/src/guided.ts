import type { BlueprintSection, Direction } from './directions.js';
import type { Route } from './schema.js';

export const PAGE_GUIDED_OUTPUTS = [
  '页面大纲',
  'Hero 文案',
  'Benefits',
  'How it works',
  'Proof',
  'FAQ',
  'SEO / AEO',
  '布局选择',
] as const;

function renderBlueprint(blueprint: BlueprintSection): string {
  return `- ${blueprint.title}：${blueprint.proves}。${blueprint.content}`;
}

function renderVisualContract(): string[] {
  return [
    '- 一套主字体，优先 Geist、Manrope 或 Poppins；不使用斜体和 900 黑体。数据或代码才使用等宽字体。',
    '- 字号落在 Tailwind 默认阶梯，间距只使用 0、2、4、8、12、16、24、32、40、48、64、80、96px。',
    '- 圆角使用 Tailwind 值，嵌套形状按“外圆角减间距”处理；卡片边框必须完整闭合。',
    '- 背景使用纯色，不使用背景渐变；Hero 标题可以使用从主题前景色到次级前景色的文字渐变。',
    '- 图标使用 Phosphor、Solar 或 Iconamoon；不使用 Emoji 或默认 Material 图标。',
    '- 动效只改变 transform 和 opacity，使用有重量感的 cubic-bezier(0.22,1,0.36,1)，并尊重 prefers-reduced-motion。',
    '- 滚动揭示使用 IntersectionObserver，每个区块只揭示一次；Tagline reveal 的词语按阅读顺序逐词出现。',
  ];
}

function renderInteractionContract(): string[] {
  return [
    '- 交互控件覆盖适用的 hover、active、focus、loading、empty、error 状态，focus 必须有可见焦点环。',
    '- 表单提供客户端校验，错误信息说明失败原因和下一步；不使用 window.alert。',
    '- 不编造数据、Logo、评价、截图或产品图；缺少素材时写出明确占位符。',
    '- 页面使用语义 HTML、可访问的 alt 文本、跳过导航链接、标题和 meta；没有死链接。',
    '- 交付前检查桌面、平板、手机三档布局，确认没有横向滚动、文字裁切、坏图片和控制台错误。',
  ];
}

export function renderGuidedBuildContract(options: {
  route: Route;
  blueprint: BlueprintSection[];
  selectedDirection?: Direction;
}): string {
  const lines: string[] = [
    '## 引导式构建输入',
    '',
    '开始写样页前先补齐这组输入。缺少答案时写出一行明确假设，再继续构建，不要用泛化文案掩盖未知信息。',
    '',
    '- 主要行动：用户完成什么动作才算转化（试用、预约、购买、报名或下载）？',
    '- 产品和受众：具体提供什么，目标用户是谁，他们正在解决什么问题？',
    '- 反对理由：用户为什么今天不会行动？列出前三个真实顾虑。',
    '- 流量上下文：用户从哪里来，落地时已经知道什么？',
    '- 证据和素材：有哪些可核对的客户、评价、数字、截图、视频或本地图片？',
    '- 约束：品牌语气、语言、移动端优先级和必须保留的链接是什么？',
    '',
    ...(options.selectedDirection
      ? [
          '### 已确认方向',
          '',
          `- ${options.selectedDirection.nameZh}（${options.selectedDirection.id}）：${options.selectedDirection.concept}`,
          `- 构图：${options.selectedDirection.composition}`,
          `- 字体：${options.selectedDirection.type}`,
          `- 配色：${options.selectedDirection.palette}`,
          `- 动效：${options.selectedDirection.motion}`,
          '',
        ]
      : []),
  ];

  if (options.route === 'page') {
    lines.push(
      '## 页面输出顺序',
      '',
      '在写 HTML 前先按下面顺序写出真实内容。这份清单是引导式构建的输入，不是最终页面的占位文案。',
      '',
      ...PAGE_GUIDED_OUTPUTS.map((item, index) => `${index + 1}. **${item}**`),
      '',
      '页面必须只有一个主要行动。Hero 要说清楚结果、受众和下一步；中段必须有独立的 tagline reveal，至少两行，滚动时逐词显现。',
      '',
      '## 分段构建顺序',
      '',
      ...options.blueprint.map((section, index) => `${index + 1}. ${section.title}：${section.proves}`),
      '',
      '每完成一段就用真实文案、最终 token 和真实素材或明确占位符验证；不要每轮重写整页。',
    );
  } else {
    lines.push(
      '## 应用结构与任务路径',
      '',
      '工作型界面沿用现有应用蓝图。先说明用户从当前屏幕到主要任务需要几步，再决定导航、工作区和反馈状态。不要把营销页 Hero 或 Benefit 卡片套进后台。',
      '',
      ...options.blueprint.map(renderBlueprint),
      '',
      '## 分段构建顺序',
      '',
      ...options.blueprint.map((section, index) => `${index + 1}. ${section.title}：${section.proves}`),
      '',
      '每一段都使用真实字段、真实操作和可解释的空数据；没有来源的指标写“尚无数据”，不要编造数字。',
    );
  }

  lines.push(
    '',
    '## 视觉系统契约',
    '',
    ...renderVisualContract(),
    '',
    '## 交互与交付检查',
    '',
    ...renderInteractionContract(),
    '',
    '## SuperWeb 引导式节奏',
    '',
    '1. 先让用户从当前三个方向中选一个，不能混合方向。',
    '2. 方向确认后生成样页，只做首屏和一个代表区块；样页确认前不展开整页。',
    '3. 样页确认后按上面的分段顺序完成整页，再运行 `superweb inspect`。',
    '4. 用户看到三档截图和问题清单后，接受或返工；接受才生成交付目录。',
  );

  return lines.join('\n');
}

export function renderGuidedBuildDocument(options: {
  route: Route;
  blueprint: BlueprintSection[];
  selectedDirection?: Direction;
}): string {
  const intro = options.selectedDirection
    ? '这份文件是样页前的设计契约。按它准备内容和视觉系统，再进入 SuperWeb 的样页门。'
    : '这份文件把 SuperWeb 的统一设计策略、视觉系统和分段构建规则写成可执行契约。它不增加用户确认次数。';
  return [
    '# 设计引导',
    '',
    intro,
    '',
    renderGuidedBuildContract(options),
    '',
    '来源：SuperWeb 内置的统一引导规则，参考 elayadesign/ai-design-skills 的 landing-page-design 思路并已合并到本 skill；执行时只以本文件和 SKILL.md 为准。',
    '',
  ].join('\n');
}
