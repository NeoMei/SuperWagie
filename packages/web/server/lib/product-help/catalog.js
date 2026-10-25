// Reviewed against the owning UI and documentation, shipped with the application.
// Models choose article IDs; only these reviewed words and navigation targets reach users.
export const PRODUCT_HELP_CATALOG_VERSION = '2026-10-25.4';

const articles = [
  {
    id: 'models-first-connection', target: 'models', guide: true,
    match: /服务商|凭据|api\s*key|密钥|连接模型|接入模型|配置.*模型|模型.*配置|模型.*设置|设置.*模型|provider|credential|connect.*model|model.*setup|model.*settings|first model/i,
    en: { title: 'Connect a model provider', text: 'Open Settings → Model configuration. Agent conversations use the native OpenCode provider connection and model choice. Other supported purposes can reuse a connection from Connections: add the provider, its endpoint and credential there, then choose that connection for the intended purpose. Enter keys only in the connection form. Guide me walks through configuring and testing a provider connection. Check for a successful test result, then bind the connection and model to the intended purpose separately. Saving or testing a connection does not select it for every purpose.' },
    'zh-CN': { title: '首次接入模型', text: '打开“设置 → 模型配置”。Agent 对话使用 OpenCode 原生服务商连接和模型选择。其他受支持用途可以复用“连接”中的配置：先添加服务商、接口地址和凭据，再到对应用途选择这个连接。密钥只填写在连接表单中。“带我操作”引导完成服务商连接配置与测试。确认测试成功后，还需到对应用途绑定连接和模型；保存或测试连接不会自动为所有用途选择模型。' },
  },
  {
    id: 'models-purpose', target: 'models',
    match: /用途|绑定|embedding|rerank|ocr|视觉|嵌入|重排|默认模型|切换.*模型|选择.*模型|模型.*选择|purpose|binding|default model|choose.*model|select.*model/i,
    en: { title: 'Choose a model by purpose', text: 'Open Settings → Model configuration and select Purposes. Choose the capability you need, then its connection and model. Agent and auxiliary models use their native OpenCode controls. Embedding, rerank, vision and speech are separate purposes. A purpose marked Planned or Requires adapter is not made usable by saving a model. Existing indexed knowledge can depend on the embedding model and dimensions; keep them until an explicit rebuild is available.' },
    'zh-CN': { title: '按用途选择模型', text: '打开“设置 → 模型配置”，进入“用途”，先选需要的能力，再选择连接和模型。Agent 和辅助模型使用 OpenCode 原生配置；嵌入、重排、视觉和语音分别配置。标为“计划中”或“需要适配”的用途不会因保存模型而变为可用。已有资料索引可能依赖原嵌入模型和维度，更换前应确认独立的重建流程。' },
  },
  {
    id: 'models-test', target: 'models',
    match: /(?:模型|连接|服务商|凭据).*(?:测试|验证|失败|错误|余额|额度|连不上)|(?:测试|验证|失败|错误).*(?:模型|连接)|(?:model|connection|provider).*(?:fail|error|test|verify|quota|credit)|(?:test|verify).*(?:model|connection)/i,
    en: { title: 'Test a model connection', text: 'Save the connection first, choose the model and test purpose, then run Test saved connection. A successful test verifies that model and purpose only. It does not save a purpose binding. On failure, check the displayed cause: key and permissions, model ID and endpoint, provider quota, or network. Wait for an actual successful response before treating the connection as verified. Some purposes require testing inside their component.' },
    'zh-CN': { title: '测试连接与排查失败', text: '先保存连接，选择测试模型和用途，再执行“测试已保存的连接”。成功结果只验证该模型和用途，不会代替用途绑定。失败时根据界面原因检查密钥与权限、模型 ID 与接口地址、服务商额度或网络。看到真实成功结果后才算验证完成；部分用途需要到对应组件中验证。' },
  },
  {
    id: 'knowledge-setup', target: 'knowledge',
    match: /导入.*(?:文件|目录|资料|文档)|(?:资料库|知识库).*(?:导入|添加|启用|初始化)|添加.*(?:文件夹|目录|资料)|启用.*(?:资料|知识)|import.*(?:files|folder|documents|library)|library.*(?:import|add|initialize)|add.*(?:folder|document)|enable.*library|set up.*library/i,
    en: { title: 'Add folders to the knowledge library', text: 'Open Settings → Knowledge library and check that the local backend is enabled and initialized. Then open the Knowledge library panel and choose Add folder. Review the indexable and skipped file counts before confirming Add and index. Indexing reads that folder and may call the configured remote model. Documents become available after indexing completes; a parsing document is not ready yet.' },
    'zh-CN': { title: '向资料库添加文件夹', text: '打开“设置 → 资料库”，确认本地服务已启用并完成初始化。然后打开右侧“资料库”面板，点击“添加文件夹”。查看可索引和跳过的文件数量，再确认“添加并索引”。索引会读取该目录，并可能调用已配置的远程模型。文档完成索引后才可使用，“解析中”不表示已经完成。' },
  },
  {
    id: 'knowledge-search', target: 'knowledge',
    match: /检索|搜索|找.*(资料|文件)|资料库|知识库|wiki|图谱|knowledge|library|search.*(file|document)|retrieve/i,
    en: { title: 'Search indexed knowledge', text: 'Use Search names and content in the Knowledge library panel to find files and passages. Results you can open or quote come from indexed documents. The agent can search the library when the read-only Knowledge library tool is enabled. Documents, Wiki, Graph and Gallery show different views of the same library; Wiki and its graph need that library’s Wiki feature to be enabled.' },
    'zh-CN': { title: '检索资料与查看知识视图', text: '在资料库面板的“搜索名称和内容”中查找文件和段落。可打开或引用的内容来自已索引文档。启用只读“资料库工具”后，Agent 也能检索资料。文档、Wiki、图谱和画廊展示同一资料库的不同视图；Wiki 和图谱需要该资料库启用 Wiki。' },
  },
  {
    id: 'knowledge-failure', target: 'knowledge',
    match: /(?:资料|知识|索引|解析).*(?:失败|错误|不可用|不运行|找不到)|(?:失败|错误).*(?:资料|知识|索引)|(?:index|parsing|library).*(?:fail|error|unavailable|missing)/i,
    en: { title: 'Troubleshoot knowledge indexing', text: 'Check the backend status in Knowledge library settings first. If it is stopped, use the available Retry action. If setup is incomplete, finish the embedding-model setup. For an unreadable folder, check that the folder exists on the server machine and that the app has file access. A Failed document needs its displayed error resolved before rescanning. A rescan may use model tokens. Removing a library does not delete the original files.' },
    'zh-CN': { title: '排查资料库与索引失败', text: '先在资料库设置查看本地服务状态。服务未运行时使用页面提供的“重试”；未初始化时先完成嵌入模型设置。文件夹无法读取时，确认目录存在于运行服务的机器上，并允许应用访问文件。文档标为“失败”时，先处理页面显示的原因，再重新扫描；扫描可能消耗模型额度。移除资料库不会删除原始文件。' },
  },
  {
    id: 'skills',
    match: /技能|skill|\$.*选择/i,
    en: { title: 'Install and use skills', text: 'Manage reusable instructions in Settings → Skills, or install a ready-made skill from the skills catalog. Personal skills are available across projects; project skills belong to the selected project. In a chat message, type $ to open the skill picker and select the skill. A slash at the beginning opens commands instead. Skills guide the ordinary agent; the product assistant only explains how to use them.' },
    'zh-CN': { title: '安装与使用技能', text: '在“设置 → 技能”管理可复用指令，或从技能目录安装现成技能。个人技能可在不同项目使用，项目技能属于所选项目。在普通对话输入“$”打开技能选择器并选择技能；输入框开头的“/”打开命令。技能用于指导普通 Agent，使用助手负责解释它们的用法。' },
  },
  {
    id: 'plugins-extensions',
    match: /插件|扩展|mcp|集成|plugin|extension|integration/i,
    en: { title: 'Plugins, extensions and integrations', text: 'OpenCode plugins run inside OpenCode; app extensions add panels or pages to the application. Use Settings to manage the corresponding plugin, extension or integration. An extension can require explicit permission before activation, and an integration may require signing in to its service. Built-in extensions ship with the app and can be disabled; their data and connected accounts are retained. Availability can differ by runtime and administrator policy.' },
    'zh-CN': { title: '插件、扩展和集成', text: 'OpenCode 插件运行在 OpenCode 中；应用扩展为界面增加面板或页面。请在设置中进入对应的插件、扩展或集成管理项。扩展启用前可能需要确认权限，集成可能需要登录对应服务。内置扩展随应用提供，可以停用，数据和已连接账户会保留。不同运行环境和管理员策略可能影响可用性。' },
  },
  {
    id: 'workbench',
    match: /工作台|任务列表|便笺|日历|workbench|task list|sticky note|calendar/i,
    en: { title: 'Use the workbench', text: 'The workbench brings together tasks, sticky notes and a calendar. Select a project to work with its tasks, or use the available global task view. Write what you want to do before choosing Create task. Dates and times belong in the task details when a reminder is needed. The Usage assistant entry opens the same assistant as the right sidebar, so you can continue an existing help conversation.' },
    'zh-CN': { title: '使用工作台', text: '工作台集中展示任务、便笺和日历。选择项目后处理该项目的任务，也可以使用全局任务视图。先写下要做的事，再点击“创建任务”；需要提醒时在任务详情中填写日期和时间。“使用助手”入口打开与右侧栏相同的助手，可以继续已有的帮助对话。' },
  },
  {
    id: 'projects-chats',
    match: /项目|新对话|聊天|会话|归档|project|new chat|conversation|session|archive/i,
    en: { title: 'Projects and chats', text: 'A project points to a folder and keeps the agent’s sessions and tools in that context. Add a project with the sidebar’s add control or the command palette, then select it before starting project work. Use a plain chat for work outside a project. Archive hides a session from the active list; deletion is a separate action. In VS Code, the extension uses the currently opened folder and does not offer plain chats.' },
    'zh-CN': { title: '项目与普通对话', text: '项目对应一个文件夹，Agent 的会话和工具以该目录为上下文。通过侧栏的添加入口或命令面板添加项目，开始项目工作前先选中它。不依赖项目的任务可以使用普通对话。归档将会话从活动列表隐藏，删除是另一个操作。VS Code 扩展使用当前打开的文件夹，不提供独立普通对话。' },
  },
  {
    id: 'report-workflow',
    match: /报告|标书|方案|文档|report|proposal|document/i,
    en: { title: 'Use the product to write a report', text: 'Start an ordinary conversation in the project containing your materials. Describe the report’s audience, purpose and expected output, and attach the relevant material. If an appropriate writing skill is installed, select it with $ in the message. Review the proposed outline and generated content in that conversation. This assistant explains that workflow; drafting the report itself belongs in the ordinary conversation.' },
    'zh-CN': { title: '通过产品完成报告写作', text: '在存放材料的项目中开始普通对话，说明报告的读者、目的和期望交付形式，并附上相关材料。如果已安装合适的写作技能，可以在输入框用“$”选择。在该对话中检查大纲和生成内容。使用助手解释这些操作步骤，报告正文在普通对话中完成。' },
  },
  {
    id: 'appearance-language', target: 'appearance', guide: true, operations: ['language-en', 'language-zh-CN'],
    match: /语言|英文|中文|language/i,
    en: { title: 'Change the interface language', text: 'Open Settings → Appearance and choose the available language from the language control. Guide me opens and highlights that control so you can choose the language. A language change updates interface labels while keeping user-authored names and content unchanged. Use Do it for me to apply a supported language directly. The assistant confirms the saved setting before reporting completion.' },
    'zh-CN': { title: '切换界面语言', text: '打开“设置 → 外观”，在语言控件中选择可用语言。“带我操作”会打开并高亮这个控件，由你选择语言。切换语言会更新界面标签，用户填写的名称和内容保持原样；也可以在“帮我完成”中直接选择目标语言，助手保存并核对结果后反馈。' },
  },
  {
    id: 'appearance-theme', target: 'theme', operations: ['theme-light', 'theme-dark', 'theme-system'],
    match: /外观|主题|深色|浅色|appearance|theme|dark mode|light mode/i,
    en: { title: 'Change the application theme', text: 'Open Settings → Appearance. Choose the application’s theme mode and available light or dark theme. Locate opens the theme settings and highlights the theme control. The change affects the application interface; it does not change your documents. Use Do it for me to switch to light mode, dark mode or system appearance. The assistant checks the saved mode before reporting completion.' },
    'zh-CN': { title: '调整应用主题', text: '打开“设置 → 外观”，选择应用的主题模式以及可用的浅色或深色主题。“定位到这里”会打开主题设置并高亮主题控件。主题设置影响应用界面，不会修改文档；也可以在“帮我完成”中直接切换浅色、深色或跟随系统，助手会核对保存结果。' },
  },
  {
    id: 'appearance-font',
    match: /字体|字号|font|text size/i,
    en: { title: 'Adjust interface fonts', text: 'Open Settings → Appearance and find the typography controls. Use the available font and size choices for the interface. These controls affect application text, not fonts inside your documents. This article provides instructions only; guided font selection is not available.' },
    'zh-CN': { title: '调整界面字体', text: '打开“设置 → 外观”，找到字体与字号设置，使用页面提供的选项调整界面文字。这里的设置影响应用界面，不会修改文档中的字体。当前提供操作说明，暂不支持字体选择的逐步引导。' },
  },
  {
    id: 'shortcuts', target: 'shortcuts',
    match: /快捷键|键盘|热键|shortcut|keyboard|hotkey/i,
    en: { title: 'Find and customize shortcuts', text: 'Open Settings → Shortcuts to see the current assignments and change customizable actions. Record the desired key combination, then confirm it. Resolve any conflict shown by the recorder before saving. The shortcuts help view lists effective bindings, including your overrides. The modifier shown as Mod means Command on macOS and Control on Windows and Linux.' },
    'zh-CN': { title: '查看和修改快捷键', text: '打开“设置 → 快捷键”查看当前绑定并修改可自定义操作。录入组合键后确认；保存前处理录入器提示的冲突。快捷键帮助页显示包含自定义修改在内的实际绑定。Mod 在 macOS 表示 Command，在 Windows 和 Linux 表示 Control。' },
  },
  {
    id: 'assistant-guidance',
    match: /助手|操作引导|退出.*引导|结束.*引导|引导.*(?:退出|结束)|高亮|带我操作|assistant|guided help|highlight|怎么用(?:这个)?(?:产品|应用|SuperWagie|犇马)|(?:产品|应用|SuperWagie|犇马).*(?:怎么用|如何使用)|how (?:do i |to )?use (?:this (?:app|product)|superwagie)/i,
    en: { title: 'Use and leave guided help', text: 'Open the Usage assistant from the right sidebar or the workbench. Ask about the product’s features, settings or an error shown by the product. Locate opens the relevant area and highlights its control. Guide me opens the related page and walks through its controls one step at a time while you operate them. Use End guide to remove the highlight and return to the conversation. Reaching the last guidance step does not prove that configuration succeeded; check the saved state or test result on the page. Do it for me can apply the listed language and appearance settings after you select the specific operation. Other tasks continue through the product forms and guides. If a help topic is not covered, it says so.' },
    'zh-CN': { title: '使用助手与退出操作引导', text: '从右侧栏或工作台打开“使用助手”，询问产品功能、设置或产品显示的错误。“定位到这里”打开相关区域并高亮控件；“带我操作”打开对应页面，逐步高亮操作点，由你完成操作。点击“结束引导”清除高亮并返回问答。走到最后一步不表示配置已成功，请以页面中的保存状态或测试结果为准。“帮我完成”可以在你选择具体操作后直接应用支持的语言和外观设置；其他任务继续使用产品表单与引导。资料未覆盖的问题会明确说明。' },
  },
];

export const PRODUCT_HELP_ARTICLE_IDS = articles.map((article) => article.id);

export const getProductHelpArticles = (locale = 'en') => articles.map((article) => ({
  id: article.id,
  ...article[locale === 'zh-CN' ? 'zh-CN' : 'en'],
  actions: [
    ...(article.target ? (article.guide ? ['locate', 'guide'] : ['locate']).map((kind) => ({
      id: `${article.target}-${kind}`, kind, target: article.target,
    })) : []),
    ...(article.operations ?? []).map(operation => ({ id: operation, kind: 'execute', operation })),
  ],
}));

const usageQuestion = /^(?:请问|我想知道|想问一下)?\s*(?:怎么|如何|哪里|在哪)|^(?:how|where)\b/i;
const generalTask = /(?:帮我|替我|给我|请).{0,8}(?:写|生成|创作|编写|翻译|计算|制定|制订)|^(?:写|生成|创作|翻译|计算|制定|制订)|\b(?:write|compose|draft|translate|solve|calculate|generate|summarize|analyze|analyse|plan)\b.{0,40}\b(?:report|story|poem|code|essay|email|proposal|budget)\b/i;
const unrelated = /天气|股价|股票|体育比分|讲个笑话|\b(?:weather|stock price|sports score|tell.*joke)\b/i;

export function isClearlyOutsideProductHelp(question) {
  const asksAboutInterface = /工作台|组件|面板|设置|显示|widget|panel|setting|display/i.test(question);
  return (unrelated.test(question) && !asksAboutInterface) || (!usageQuestion.test(question) && generalTask.test(question));
}

export function selectLocalProductHelp(question, context, history) {
  if (isClearlyOutsideProductHelp(question)) return { kind: 'out-of-scope', articleIds: [] };
  // Error-specific help takes precedence over the general topic with the same nouns.
  const priority = ['knowledge-failure', 'models-test', 'knowledge-setup', 'models-purpose', 'models-first-connection'];
  const match = (sample) => {
    const matches = articles.filter((article) => article.match.test(sample));
    return priority.find((id) => matches.some((article) => article.id === id)) ?? matches[0]?.id;
  };
  // A named new topic wins over previous conversation context.
  const current = match(question);
  if (current) return { kind: 'answer', articleIds: [current] };
  if (/这个页面|当前页面|this page|current page/i.test(question)) {
    const pageArticles = { models: 'models-purpose', 'model-configuration': 'models-purpose', knowledge: 'knowledge-search', library: 'knowledge-search', 'knowledge-library': 'knowledge-search', appearance: 'appearance-language', shortcuts: 'shortcuts', workbench: 'workbench' };
    const page = context.page.startsWith('settings:') ? context.page.slice('settings:'.length) : context.page;
    if (Object.hasOwn(pageArticles, page)) return { kind: 'answer', articleIds: [pageArticles[page]] };
  }
  // Only topic-free follow-ups may inherit context. A prefix such as "那" or
  // "why" alone must not turn a new, unrelated question into product help.
  const followup = /^(?:(?:那|然后|接下来)[，,\s]*)?(?:下一步(?:呢|是什么|怎么做)?|然后呢|接下来呢|为什么(?:呢)?|怎么做|怎么办|失败了(?:怎么办)?|还不行(?:怎么办)?|怎么(?:测试|验证|继续)|这个(?:怎么做|怎么办|呢))\s*[?？!！。.]*$|^(?:(?:and|then)\s+)?(?:next|what next|what is next|why|how so|it failed|still fails|what if it fails|how (?:do i|to) (?:test|continue)|what about testing)\s*[?!.]*$/i.test(question.trim());
  if (followup) {
    // Recognize only our complete reviewed answer text, never arbitrary prose
    // supplied in an assistant history entry. This keeps later follow-ups useful
    // after the original question has left the six-turn history window.
    const reviewed = [...getProductHelpArticles('en'), ...getProductHelpArticles('zh-CN')];
    for (const turn of [...history].reverse()) {
      if (turn.role === 'user') {
        if (isClearlyOutsideProductHelp(turn.text)) break;
        const id = match(`${turn.text} ${question}`);
        if (id) return { kind: 'answer', articleIds: [id] };
      } else {
        const previous = reviewed.find((article) => turn.text.includes(`${article.title}\n\n${article.text}`));
        if (previous) return { kind: 'answer', articleIds: [match(`${previous.title} ${question}`) ?? previous.id] };
      }
    }
  }
  return { kind: /superwagie|openchamber|犇马|产品|应用|app\b/i.test(question) || followup ? 'not-covered' : 'out-of-scope', articleIds: [] };
}
