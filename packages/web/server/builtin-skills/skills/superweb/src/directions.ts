import type { Route } from './schema.js';

export interface Direction {
  id: string;
  nameZh: string;
  nameEn: string;
  routes: Route[];
  concept: string;
  composition: string;
  type: string;
  palette: string;
  motion: string;
  bestFor: string;
  avoid: string;
}

export interface BlueprintSection {
  id: string;
  title: string;
  proves: string;
  content: string;
  required: boolean;
}

export const DIRECTIONS: Direction[] = [
  {
    id: 'editorial-swiss',
    nameZh: '瑞士编辑',
    nameEn: 'Editorial Swiss',
    routes: ['page', 'app'],
    concept: '用严格网格和字号层级建立秩序，像一本专业杂志的专题页；装饰为零，信息本身是主角。',
    composition: '12 列网格，全部左对齐，超大标题压在正文与留白之间；图片只占网格单位，不越界。',
    type: '无衬线 Grotesk（Inter Tight / Helvetica Neue）；标题 64–120px，正文 16–18px，字重对比强烈。',
    palette: '纸白 #F7F7F5、墨黑 #111111，一个高饱和强调色（信号红或钴蓝），强调色不超过 5% 面积。',
    motion: '几乎无动效；仅 120ms 的链接下划线展开与清晰的焦点环。',
    bestFor: '作品集、设计工作室、出版物、需要可信度的产品介绍，以及内容型后台。',
    avoid: '插画、圆角卡片、渐变、Emoji、装饰性图标墙。',
  },
  {
    id: 'brutalist-raw',
    nameZh: '粗野主义',
    nameEn: 'Brutalist Raw',
    routes: ['page', 'app'],
    concept: '把结构直接暴露出来：粗边框、系统字体、原始表格，反精致但高度可读。',
    composition: '满幅分块，元素贴边，1px 或 4px 黑框，硬阴影错位 4px；拒绝居中与柔和容器。',
    type: '系统无衬线加等宽（ui-monospace），字号大、行距紧；标题可全大写，正文不用小号灰字。',
    palette: '纯白 #FFFFFF、纯黑 #000000，荧光黄 #E8FF00 或电蓝 #0000FF 只做单点强调。',
    motion: '瞬时状态切换，不做缓动；hover 直接反色，focus 用粗轮廓。',
    bestFor: '独立开发者、活动页、艺术家、想表达反叛姿态的产品。',
    avoid: '柔和阴影、圆角、衬线、渐变、玻璃拟态。',
  },
  {
    id: 'quiet-luxury',
    nameZh: '静奢',
    nameEn: 'Quiet Luxury',
    routes: ['page'],
    concept: '用留白、材质感和克制的衬线建立昂贵感，像高端酒店或建筑师事务所的页面。',
    composition: '大量上下留白，单一视觉焦点；图片全幅或极窄竖幅；正文宽度限制在 60ch。',
    type: '高对比衬线（Canela / Playfair / 思源宋体）做标题，字重轻；正文用小号无衬线。',
    palette: '骨白 #F4F1EA、深棕黑 #1C1A17、香槟金 #B79A6B 或鼠尾草绿，整体低饱和。',
    motion: '300–600ms 淡入与 8px 位移，缓慢；图片 hover 仅 scale 1.02。',
    bestFor: '酒店、建筑、珠宝、私人服务、高端咨询。',
    avoid: '高饱和色、粗黑边框、密集卡片、夸张 CTA。',
  },
  {
    id: 'technical-instrument',
    nameZh: '仪器面板',
    nameEn: 'Technical Instrument',
    routes: ['page', 'app'],
    concept: '像专业设备的控制面板：数据密度高、对齐精确、每个数字都有单位。',
    composition: '顶部状态条、主读数、次级网格；数字右对齐；严格 4px 基线，面板边界用发丝线。',
    type: '等宽或半等宽（IBM Plex Mono / JetBrains Mono）做数字，窄体无衬线做标签。',
    palette: '石墨 #14171A、面板灰 #1E2328、青绿 #4FE0B0，琥珀 #FFB020 只表示警告。',
    motion: '150ms 状态过渡，数字不做滚动动画；loading 用细进度条。',
    bestFor: '仪表盘、监控台、开发者工具、硬件产品。',
    avoid: '大圆角、营销插画、柔和渐变背景、装饰性动画。',
  },
  {
    id: 'warm-humanist',
    nameZh: '温暖人文',
    nameEn: 'Warm Humanist',
    routes: ['page'],
    concept: '像一封认真写的信：温和的字形、暖纸色、真实的语气，适合与人打交道的服务。',
    composition: '窄栏文本与宽幅真实照片交替；标题左对齐，段落之间用细线分隔，不用卡片包住一切。',
    type: '人文无衬线（Source Sans / 思源黑体）配少量衬线强调；正文 17–19px，行高 1.7。',
    palette: '暖米 #FAF6EF、可可 #3B2F2A、陶土 #C4664A、橄榄 #6B7A4F。',
    motion: '轻柔淡入 400ms；hover 只改变下划线颜色，不做位移。',
    bestFor: '教育、医疗、社区、心理咨询、餐饮。',
    avoid: '纯黑纯白、冷灰、机械等宽、锐利直角。',
  },
  {
    id: 'kinetic-poster',
    nameZh: '动感海报',
    nameEn: 'Kinetic Poster',
    routes: ['page'],
    concept: '把一个动作定格成整页：超大字号、斜切构图、强色块，滚动就是节奏。',
    composition: '非对称斜向布局，标题跨越视口，色块与文字互相压叠；每屏只讲一个主信息。',
    type: '超粗无衬线（Archivo Black / Anton），标题 12vw 起，行距 0.9；正文保持 16px 可读。',
    palette: '黑底加两个荧光色（酸性绿 #C6FF00、橙红 #FF4D00），不使用紫粉渐变。',
    motion: '滚动触发 translate/rotate，120–240ms fast-out；prefers-reduced-motion 时全部关闭。',
    bestFor: '音乐节、运动品牌、发布活动、年轻向产品。',
    avoid: '静态对称卡片、衬线正文、低对比、每屏堆三段文字。',
  },
  {
    id: 'terminal-green',
    nameZh: '终端',
    nameEn: 'Terminal Green',
    routes: ['page', 'app'],
    concept: '以命令行界面为视觉母题，信息像日志一样逐行出现，冷静、技术、可审计。',
    composition: '单列 72ch，左侧行号或时间戳，顶部路径面包屑；卡片只用于错误与空状态。',
    type: '全等宽（Berkeley Mono / SF Mono），13–15px，行高 1.6；标题用加粗而不是放大。',
    palette: '近黑 #0B0F0C、荧光绿 #33FF88、暗绿 #1E3A2A、错误红 #FF5F56。',
    motion: '打字机只在首屏出现一次；其余 80ms 闪烁；无弹跳、无视差。',
    bestFor: '开发者工具、CLI 产品、安全服务、技术文档。',
    avoid: '彩色插画、圆角、阴影、衬线、大段营销口号。',
  },
  {
    id: 'magazine-collage',
    nameZh: '杂志拼贴',
    nameEn: 'Magazine Collage',
    routes: ['page'],
    concept: '把不同来源的素材剪贴成叙事：图片比例不一、注释外置，像独立杂志的跨页。',
    composition: '三栏不规则网格，图片跨栏，图注用小号斜体贴近图片；允许留白断裂，不追求对齐。',
    type: '标题用窄体衬线，正文用无衬线，图注用等宽小字；全页控制在三种字号。',
    palette: '新闻纸 #EFE9DD、墨 #191714、印刷红 #C8352B、蓝 #2E4A7D。',
    motion: '图片进入时轻微上移 10px，180ms；不做视差与自动轮播。',
    bestFor: '文化项目、展览、人物报道、独立品牌。',
    avoid: '统一圆角卡片、居中对称、无图注的装饰图、自动播放视频。',
  },
  {
    id: 'japanese-ma',
    nameZh: '间',
    nameEn: 'Japanese Ma',
    routes: ['page'],
    concept: '用“间”组织页面：大量空白、细小文字、克制的自然色，让内容自己呼吸。',
    composition: '单栏窄幅（最大 720px），上下留白至少 120px，元素少而精；允许不对称留白。',
    type: '细字重无衬线（Noto Sans JP / 思源黑体 Light），正文 14–15px，行高 2.0；标题只比正文大 1.5 倍。',
    palette: '生成 #F5F4EF、墨 #22201D、苔绿 #7C8B6F，朱砂 #A6402D 只用于关键动作。',
    motion: '500ms 以上的缓慢淡入；hover 只改变透明度。',
    bestFor: '建筑、陶艺、茶室、摄影、安静的品牌。',
    avoid: '密集信息、强色块、粗体大标题、卡片阴影。',
  },
  {
    id: 'industrial-spec',
    nameZh: '工业规格',
    nameEn: 'Industrial Spec',
    routes: ['page', 'app'],
    concept: '像产品说明书：爆炸图、尺寸标注、参数表，用工程语言证明可靠性。',
    composition: '左侧大图或结构图，右侧参数表；标注线连接具体部件；所有数字按列对齐。',
    type: '窄体无衬线（DIN / Barlow Condensed）做标题，等宽做参数，正文 15px。',
    palette: '冷灰 #E7E9EA、机械黑 #17191B、安全橙 #F26A1B、钢蓝 #4A6572。',
    motion: '标注线绘制 300ms；hover 高亮对应参数行，不做弹跳。',
    bestFor: '硬件、工具、工业设备、汽车、户外装备。',
    avoid: '生活方式大图、手写字体、柔和粉彩、无标注的装饰图。',
  },
  {
    id: 'museum-label',
    nameZh: '博物馆标签',
    nameEn: 'Museum Label',
    routes: ['page'],
    concept: '像展厅墙上的作品标签：信息极简、层级清楚、距离感强，让对象被认真观看。',
    composition: '大量边缘留白，主视觉居中偏上，标签信息在左下角成组；细规则线分隔区块。',
    type: '衬线标题（Lora / 思源宋体）配无衬线标签；标签 12–13px，全大写字母间距 0.08em。',
    palette: '展厅白 #FBFBF9、炭黑 #202020、灰 #8A8A85，单一藏品色（赭石或靛蓝）。',
    motion: '无；页面切换只做 200ms 淡入。',
    bestFor: '美术馆、文化遗产、摄影集、研究项目。',
    avoid: '强 CTA 色块、动画、密集导航、促销语气。',
  },
  {
    id: 'data-narrative',
    nameZh: '数据叙事',
    nameEn: 'Data Narrative',
    routes: ['page', 'app'],
    concept: '让数字推动故事：每个区块回答一个问题，图表与结论并置，不堆仪表盘。',
    composition: '全宽图表配左侧结论短句；滚动逐段揭示；数字大、单位小；图表最多四色。',
    type: '无衬线正文加表格数字（tabular-nums）；结论句 32–48px 中粗，正文 17px。',
    palette: '深墨 #101418、纸 #F2F0EA、数据蓝 #2B6CB0、强调橙 #DD6B20。',
    motion: '数字 count-up 600ms 只播放一次；图表进入 300ms；reduced-motion 时直接显示。',
    bestFor: '研究报告、年度总结、ESG、产品数据页、仪表盘的叙事层。',
    avoid: '编造数据、3D 饼图、装饰性图表、没有来源的统计。',
  },
];

export const PAGE_BLUEPRINT: BlueprintSection[] = [
  {
    id: 'hero',
    title: '首屏',
    proves: '这是什么、为谁而做、下一步做什么',
    content: '一句具体价值主张、一个主要行动、一个真实视觉锚点；活动页必须含时间地点。',
    required: true,
  },
  {
    id: 'proof',
    title: '可信证据',
    proves: '为什么应该相信',
    content: '真实客户、作品、评价、资质或可核对的数字；没有就删除本节，不造假 logo 墙。',
    required: true,
  },
  {
    id: 'detail',
    title: '核心内容',
    proves: '它如何解决目标用户的问题',
    content: '完整的功能、作品或服务说明；真实截图优先，否则使用明确标记的占位符。',
    required: true,
  },
  {
    id: 'process',
    title: '开始方式',
    proves: '从看到页面到获得结果需要几步',
    content: '三步以内的真实流程；没有流程就不写。',
    required: false,
  },
  {
    id: 'offer',
    title: '价格或选项',
    proves: '要付多少钱、能选什么',
    content: '完整价格、套餐或报名信息，包含单位与限制，不省略关键条件。',
    required: false,
  },
  {
    id: 'faq',
    title: '常见问题',
    proves: '行动前的真实顾虑已被回答',
    content: '三到五条会阻止下单或报名的问题，不用虚构问答填充。',
    required: false,
  },
  {
    id: 'closing',
    title: '结尾行动',
    proves: '读完的人知道下一步去哪里',
    content: '重复主要行动，补上联系方式、时间地点或必要说明。',
    required: true,
  },
];

export const APP_BLUEPRINT: BlueprintSection[] = [
  {
    id: 'shell',
    title: '应用外壳',
    proves: '用户在哪里、能去哪里、当前身份是谁',
    content: '侧边或顶部导航、当前位置、账户入口；导航项使用真实模块名。',
    required: true,
  },
  {
    id: 'overview',
    title: '主屏概览',
    proves: '当前最重要的状态是什么',
    content: '三到五个有来源的关键指标或待办；没有数据时给出诚实的空状态。',
    required: true,
  },
  {
    id: 'workspace',
    title: '核心工作区',
    proves: '主要任务如何完成',
    content: '一张真实列表、详情面板或编辑器；字段、操作和状态完整。',
    required: true,
  },
  {
    id: 'actions',
    title: '操作与反馈',
    proves: '动作之后会发生什么',
    content: '主操作、次操作、禁用条件，以及成功/失败反馈。',
    required: false,
  },
  {
    id: 'states',
    title: '状态覆盖',
    proves: '异常与空数据也被认真设计',
    content: '适用的 empty、loading、error、disabled 状态，文案具体。',
    required: true,
  },
];

export function directionsForRoute(route: Route): Direction[] {
  return DIRECTIONS.filter((direction) => direction.routes.includes(route));
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickDirections(route: Route, seed: string, count = 3): Direction[] {
  const pool = directionsForRoute(route);
  if (count > pool.length) {
    throw new Error(`route ${route} only has ${pool.length} directions`);
  }
  const random = mulberry32(fnv1a(`${route}:${seed}`));
  const shuffled = [...pool];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = shuffled[index]!;
    shuffled[index] = shuffled[swap]!;
    shuffled[swap] = current;
  }
  return shuffled.slice(0, count);
}

export function assessBrief(text: string): { ok: boolean; visibleChars: number; reason?: string } {
  const visibleChars = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (visibleChars < 40) {
    return {
      ok: false,
      visibleChars,
      reason: `需求至少需要 40 个有效字符（当前 ${visibleChars} 个）。请补充目标、受众、必须内容与已有素材。`,
    };
  }
  return { ok: true, visibleChars };
}

const APP_KEYWORDS = [
  '管理后台',
  '后台管理',
  '仪表盘',
  '仪表板',
  '控制台',
  '工作台',
  '设置页',
  '设置界面',
  '用户列表',
  '数据表格',
  '编辑器',
  'dashboard',
  'admin',
  'console',
  'settings',
  'data table',
  'editor',
  'crm',
  'analytics',
  'kanban',
  'inbox',
];

const PAGE_KEYWORDS = [
  '落地页',
  '官网',
  '首页',
  '作品集',
  '活动页',
  '产品页',
  '介绍页',
  '宣传页',
  '单页',
  '展示页',
  'landing page',
  'landing',
  'portfolio',
  'marketing site',
  'event page',
  'one-pager',
  'showcase',
  'website',
];

function countKeywords(text: string, keywords: string[]): number {
  const haystack = text.toLowerCase();
  return keywords.reduce((total, keyword) => {
    let index = 0;
    let hits = 0;
    while ((index = haystack.indexOf(keyword, index)) !== -1) {
      hits += 1;
      index += keyword.length;
    }
    return total + hits;
  }, 0);
}

export function detectRoute(text: string): Route {
  return countKeywords(text, APP_KEYWORDS) > countKeywords(text, PAGE_KEYWORDS) ? 'app' : 'page';
}

export function renderDirectionsDoc(options: {
  taskId: string;
  route: Route;
  seed: string;
  revision: number;
  directions: Direction[];
  blueprint: BlueprintSection[];
}): string {
  const routeLabel = options.route === 'page' ? 'page（浏览型页面）' : 'app（工作型界面）';
  const lines: string[] = [
    '# 设计方向',
    '',
    `- 任务 ID：\`${options.taskId}\``,
    `- 路线：${routeLabel}`,
    `- 抽取 seed：\`${options.seed}\``,
    `- 阶段 revision：${options.revision}`,
    '',
    '三个方向在概念、构图、字体、配色和动效上必须不同。选一个，不要混合三个。',
    '',
  ];

  options.directions.forEach((direction, index) => {
    lines.push(
      `## ${index + 1}. ${direction.id} — ${direction.nameZh}`,
      '',
      `- 概念：${direction.concept}`,
      `- 构图：${direction.composition}`,
      `- 字体：${direction.type}`,
      `- 配色：${direction.palette}`,
      `- 动效：${direction.motion}`,
      `- 适用：${direction.bestFor}`,
      `- 避免：${direction.avoid}`,
      '',
    );
  });

  lines.push(
    '## 内容结构',
    '',
    '每一节都要能回答“它在证明什么”。没有作用的区块删除，不要为了填满页面增加区块。',
    '',
    '| # | 区块 | 要证明什么 | 必须内容 | 必需 |',
    '| --- | --- | --- | --- | --- |',
  );
  options.blueprint.forEach((section, index) => {
    lines.push(
      `| ${index + 1} | ${section.title} | ${section.proves} | ${section.content} | ${section.required ? '是' : '可选'} |`,
    );
  });

  lines.push(
    '',
    '## 下一步',
    '',
    '选定方向并确认内容结构后运行（替换方向 ID 和 decision ID）：',
    '',
    '```bash',
    `superweb decide --dir <任务目录> --gate direction --choice <方向ID>`,
    '```',
    '',
    '`--revision` 自动使用当前 revision；`--decision-id` 会自动生成。需要可审计的幂等确认时，再显式传入这两个参数。确认后 stageRevision 会推进，旧的确认自动失效。需要重新抽取方向时使用新的 seed，并重新确认内容结构。',
    '',
  );

  return lines.join('\n');
}

export function parseOfferedDirectionIds(markdown: string): string[] {
  const ids: string[] = [];
  const pattern = /^##\s+\d+\.\s+([a-z0-9-]+)\s+—/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    ids.push(match[1]!);
  }
  return ids;
}
