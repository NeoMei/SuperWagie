// Matching rules and capabilities ship with the app. Reviewed prose and literal
// search phrases come from the validated content snapshot.
import { BUNDLED_PRODUCT_HELP_CONTENT } from './content.js';

const articles = [
  {
    id: 'models-first-connection', target: 'models',
    match: /服务商|凭据|api\s*key|密钥|连接模型|接入模型|配置.*模型|模型.*配置|模型.*设置|设置.*模型|provider|credential|connect.*model|model.*setup|model.*settings|first model/i,
  },
  {
    id: 'models-purpose', target: 'model-purposes',
    match: /用途|绑定|embedding|rerank|ocr|视觉|嵌入|重排|默认模型|切换.*模型|选择.*模型|模型.*选择|purpose|binding|default model|choose.*model|select.*model/i,
  },
  {
    id: 'models-test', target: 'model-tests',
    match: /(?:模型|连接|服务商|凭据).*(?:测试|验证|失败|错误|余额|额度|连不上)|(?:测试|验证|失败|错误).*(?:模型|连接)|(?:model|connection|provider).*(?:fail|error|test|verify|quota|credit)|(?:test|verify).*(?:model|connection)/i,
  },
  {
    id: 'knowledge-setup', target: 'knowledge',
    match: /导入.*(?:文件|目录|资料|文档)|(?:资料库|知识库).*(?:导入|添加|启用|初始化)|添加.*(?:文件夹|目录|资料)|启用.*(?:资料|知识)|import.*(?:files|folder|documents|library)|library.*(?:import|add|initialize)|add.*(?:folder|document)|enable.*library|set up.*library/i,
  },
  {
    id: 'knowledge-search', target: 'knowledge',
    match: /检索|搜索.*资料|找.*资料|资料库|知识库|wiki|图谱|knowledge|library|search.*(?:knowledge|library|document)|retrieve/i,
  },
  {
    id: 'knowledge-failure', target: 'knowledge',
    match: /(?:资料|知识|索引|解析).*(?:失败|错误|不可用|不运行|找不到)|(?:失败|错误).*(?:资料|知识|索引)|(?:index|parsing|library).*(?:fail|error|unavailable|missing)/i,
  },
  {
    id: 'skills', target: 'skills',
    match: /技能|skill|\$.*选择/i,
  },
  {
    id: 'plugins-extensions', target: 'plugins',
    match: /插件|扩展|mcp|集成|plugin|extension|integration/i,
  },
  {
    id: 'workbench', target: 'workbench',
    match: /工作台|任务列表|便笺|日历|workbench|task list|sticky note|calendar/i,
  },
  {
    id: 'projects-chats', target: 'sessions',
    match: /项目|新对话|聊天|会话|归档|project|new chat|conversation|session|archive/i,
  },
  {
    id: 'report-workflow', target: 'chat',
    match: /报告|标书|方案|文档|report|proposal|document/i,
  },
  {
    id: 'appearance-language', target: 'appearance', operations: ['language-en', 'language-zh-CN'],
    match: /语言|英文|中文|language/i,
  },
  {
    id: 'appearance-theme', target: 'theme', operations: ['theme-light', 'theme-dark', 'theme-system'],
    match: /外观|主题|深色|浅色|appearance|theme|dark mode|light mode/i,
  },
  {
    id: 'appearance-font', target: 'font',
    match: /字体|字号|font|text size/i,
  },
  {
    id: 'shortcuts', target: 'shortcuts',
    match: /快捷键|键盘|热键|shortcut|keyboard|hotkey/i,
  },
  {
    id: 'chat-input', target: 'chat',
    match: /附件|附加文件|上传.*(?:聊天|对话)|(?:聊天|对话|输入框).*(?:上传|粘贴|拖入|换行|发送|输入)|斜杠命令|代码片段|attach.*file|file.*attachment|upload.*(?:chat|message)|(?:chat|message).*(?:upload|attach)|chat input|composer|slash command|snippet|(?:paste|drag).*(?:image|file)|send.*message|newline/i,
  },
  {
    id: 'chat-stop-queue', target: 'chat',
    match: /停止生成|停止回复|停止.*(?:对话|聊天|智能体)|排队.*消息|消息.*排队|队列|stop.*(?:generat|response|agent)|queued? message|message queue/i,
  },
  {
    id: 'chat-questions', target: 'chat',
    match: /等待回答|等待输入|需要输入|(?:问题|提问|表单).*(?:回答|选项|提交|跳过|忽略)|(?:回答|提交).*(?:问题|表单|选项)|input needed|question form|(?:answer|submit|dismiss).*(?:question|form)|waiting.*(?:answer|input)/i,
  },
  {
    id: 'session-history', target: 'sessions',
    match: /归档|恢复.*(?:会话|聊天|对话)|(?:搜索|查找|导出|删除|重命名).*(?:会话|聊天|对话)|(?:会话|聊天|对话).*(?:搜索|导出|恢复|删除)|archive|(?:restore|search|export|delete|rename).*(?:session|chat|conversation)|(?:session|chat|conversation).*(?:history|export|restore)/i,
  },
  {
    id: 'session-goals', target: 'chat',
    match: /会话目标|作为目标运行|靶心|(?:目标|goal).*(?:预算|暂停|继续|完成|运行)|持续执行|持续推进|session goal|run as (?:a )?goal|token budget/i,
  },
  {
    id: 'context-compact', target: 'context',
    match: /上下文|压缩.*(?:会话|历史)|分叉.*(?:会话|对话)|\/compact\b|\/fork\b|context (?:window|full|limit)|compact.*(?:chat|history|session)|fork.*(?:chat|session|conversation)/i,
  },
  {
    id: 'scheduled-tasks', target: 'scheduled-tasks',
    match: /计划任务|定时任务|定时执行|自动执行|周期任务|循环任务|cron|scheduled? task|schedule.*(?:task|prompt)|recurring task/i,
  },
  {
    id: 'scheduled-task-failure', target: 'scheduled-tasks',
    match: /(?:计划任务|定时任务|定时执行|循环任务|cron).*(?:失败|错误|不运行|没运行|未运行|不执行|不触发|没触发|没有触发|排队|跳过)|(?:失败|错误|不执行|不触发|没有触发).*(?:计划任务|定时任务)|(?:scheduled? task|cron).*(?:fail|error|doesn.?t run|not run|not fire|queue|skip)/i,
  },
  {
    id: 'workflows', target: 'workflows',
    match: /工作流|\bworkflows?\b/i,
  },
  {
    id: 'files-preview', target: 'files',
    match: /文件树|文件面板|文件预览|文档预览|预览.*(?:文件|文档)|(?:打开|下载|保存|查找|搜索|重命名|删除|上传).*(?:生成的|产出|文件)|(?:文件|文档).*(?:打不开|无法打开)|file (?:tree|panel|preview)|(?:open|download|rename|upload|delete|preview).*(?:file|artifact)|search.*file/i,
  },
  {
    id: 'terminal', target: 'terminal',
    match: /终端|shell|命令行|terminal|输入.*!|以.*!.*开头/i,
  },
  {
    id: 'git-changes', target: 'changes',
    match: /\bgit\b|仓库|暂存|提交.*(?:变更|更改|代码)|(?:变更|更改).*(?:提交|差异)|推送|拉取|合并冲突|stage.*(?:change|file)|commit.*(?:change|file)|\b(?:push|pull|branch|staged|commit|repository|merge conflict|pull request)\b.{0,24}\b(?:git|repo|branch|change|file|commit|remote|worktree)\b|\b(?:git|repo|branch|change|file|commit|remote|worktree)\b.{0,24}\b(?:push|pull|branch|staged|commit|repository|merge conflict|pull request)\b/i,
  },
  {
    id: 'worktrees', target: 'worktrees',
    match: /工作树|worktree|隔离.*分支/i,
  },
  {
    id: 'mcp', target: 'mcp',
    match: /\bmcp\b|工具服务器|模型上下文协议/i,
  },
  {
    id: 'permissions', target: 'permissions',
    match: /权限|安全网|允许一次|始终允许|全部接受|permission|approval|safety net|allow once|always allow/i,
  },
  {
    id: 'voice', target: 'voice',
    match: /语音|听写|麦克风|朗读|转写|dictation|microphone|read aloud|speech recognition|transcription|\bvoice\b.{0,24}(?:input|dictat|microphone|speech|read|transcri|record|setting)|(?:input|dictat|microphone|speech|read aloud|transcri|record).{0,24}\bvoice\b/i,
  },
  {
    id: 'memory', target: 'memory',
    match: /记忆|对话学习|项目经验|遗忘|(?:conversation|agent|project|stored|saved|enable|recall|forget).{0,24}\bmemory\b|\bmemory\b.{0,24}(?:conversation|agent|project|recall|forget|setting|enable)|conversation learning|learn.*conversation|forget.*(?:entry|experience)/i,
  },
  {
    id: 'remote-instances', target: 'remote',
    match: /远程实例|连接.*远程|远程.*连接|配对|连接设备|ssh|remote instance|connect.*remote|pairing|connect.*device/i,
  },
  {
    id: 'external-tunnel', target: 'tunnel',
    match: /隧道|公网访问|外网访问|tunnel|cloudflare|tailscale|funnel/i,
  },
  {
    id: 'updates', target: 'updates',
    match: /检查更新|应用更新|更新应用|升级|版本更新|check.*update|app update|update.*app|upgrade/i,
  },
  {
    id: 'assistant-guidance',
    match: /助手|帮助文档|操作提示|操作引导|退出.*引导|结束.*引导|引导.*(?:退出|结束)|高亮|带我操作|assistant|help articles|guided help|highlight|怎么用(?:这个)?(?:产品|应用|SuperWagie|犇马)|(?:产品|应用|SuperWagie|犇马).*(?:怎么用|如何使用)|how (?:do i |to )?use (?:this (?:app|product)|superwagie)/i,
  },
];

export const getProductHelpArticles = (locale = 'en', content = BUNDLED_PRODUCT_HELP_CONTENT) => content.articles.map((article) => {
  const capabilities = articles.find(entry => entry.id === article.id);
  return {
    id: article.id,
    ...article[locale === 'zh-CN' ? 'zh-CN' : 'en'],
    actions: [
      ...(capabilities?.target ? ['locate', 'guide'].map((kind) => ({
        id: `${capabilities.target}-${kind}`, kind, target: capabilities.target,
      })) : []),
      ...(capabilities?.operations ?? []).map(operation => ({ id: operation, kind: 'execute', operation })),
    ],
  };
});

const usageQuestion = /^(?:请问|我想知道|想问一下)?\s*(?:怎么|如何|哪里|在哪)|^(?:how|where)\b/i;
const actionOnlyFollowup = /^(?:(?:那|然后|接下来)[，,\s]*)?(?:请\s*)?(?:带我操作(?:一下|这个)?|定位到这里|guide me|locate(?: here| this| it)?|take me there)\s*[?？!！。.]*$/i;
const generalTask = /(?:帮我|替我|给我|请).{0,8}(?:写|生成|创作|编写|翻译|计算|制定|制订)|^(?:写|生成|创作|翻译|计算|制定|制订)|\b(?:write|compose|draft|translate|solve|calculate|generate|summarize|analyze|analyse|plan)\b.{0,40}\b(?:report|story|poem|code|essay|email|proposal|budget)\b/i;
const unrelated = /天气|股价|股票|体育比分|讲个笑话|\b(?:weather|stock price|sports score|tell.*joke)\b/i;

export function isClearlyOutsideProductHelp(question) {
  const asksAboutInterface = /工作台|组件|面板|设置|显示|widget|panel|setting|display/i.test(question);
  return (unrelated.test(question) && !asksAboutInterface) || (!usageQuestion.test(question) && generalTask.test(question));
}

const containsKeyword = (sample, keyword) => {
  const wordCharacter = /[a-z0-9_]/;
  for (let index = sample.indexOf(keyword); index !== -1; index = sample.indexOf(keyword, index + 1)) {
    const left = wordCharacter.test(keyword[0]) && wordCharacter.test(sample[index - 1] ?? '');
    const right = wordCharacter.test(keyword.at(-1)) && wordCharacter.test(sample[index + keyword.length] ?? '');
    if (!left && !right) return true;
  }
  return false;
};

export function selectLocalProductHelp(question, context, history, content = BUNDLED_PRODUCT_HELP_CONTENT) {
  if (isClearlyOutsideProductHelp(question)) return { kind: 'out-of-scope', articleIds: [] };
  // Prefer the named operation over broad project/chat words, and its failure help over setup.
  const priority = [
    'scheduled-task-failure', 'scheduled-tasks', 'mcp', 'external-tunnel', 'remote-instances',
    'memory', 'chat-questions', 'chat-stop-queue', 'session-goals', 'worktrees', 'permissions', 'voice',
    'session-history', 'context-compact', 'chat-input', 'terminal', 'git-changes', 'workflows',
    'knowledge-failure', 'models-test', 'knowledge-setup', 'models-purpose', 'models-first-connection',
    'knowledge-search', 'files-preview', 'updates',
  ];
  const match = (sample) => {
    const normalized = sample.toLowerCase();
    // Published keywords are literal phrases. They cannot introduce executable
    // regular expressions, and a named new topic wins over a broad bundled match.
    let keywordMatch;
    let longest = 0;
    for (const article of content.articles) {
      for (const keyword of article.keywords) {
        if (keyword.length > longest && containsKeyword(normalized, keyword.toLowerCase())) {
          keywordMatch = article.id;
          longest = keyword.length;
        }
      }
    }
    if (keywordMatch) return keywordMatch;
    const ids = new Set(content.articles.map(article => article.id));
    const matches = articles.filter((article) => ids.has(article.id) && article.match.test(sample));
    return priority.find((id) => matches.some((article) => article.id === id)) ?? matches[0]?.id;
  };
  // A named new topic wins over previous conversation context.
  const wantsAction = actionOnlyFollowup.test(question.trim());
  const current = match(question);
  if (current && !wantsAction) return { kind: 'answer', articleIds: [current] };
  if (/这个页面|当前页面|this page|current page/i.test(question)) {
    const pageArticles = {
      models: 'models-purpose', 'model-configuration': 'models-purpose', providers: 'models-first-connection',
      knowledge: 'knowledge-search', library: 'knowledge-search', 'knowledge-library': 'knowledge-search',
      appearance: 'appearance-language', shortcuts: 'shortcuts', workbench: 'workbench',
      projects: 'projects-chats', sessions: 'session-history', chat: 'chat-input',
      commands: 'chat-input', snippets: 'chat-input', 'skills.installed': 'skills', 'skills.catalog': 'skills',
      plugins: 'plugins-extensions', extensions: 'plugins-extensions', integrations: 'plugins-extensions',
      mcp: 'mcp', agents: 'permissions', voice: 'voice', git: 'git-changes',
      'remote-instances': 'remote-instances', tunnel: 'external-tunnel', about: 'updates',
    };
    const page = context.page.startsWith('settings:') ? context.page.slice('settings:'.length) : context.page;
    if (Object.hasOwn(pageArticles, page) && content.articles.some(article => article.id === pageArticles[page])) {
      return { kind: 'answer', articleIds: [pageArticles[page]] };
    }
  }
  // Only topic-free follow-ups may inherit context. A prefix such as "那" or
  // "why" alone must not turn a new, unrelated question into product help.
  const followup = /^(?:(?:那|然后|接下来)[，,\s]*)?(?:下一步(?:呢|是什么|怎么做)?|然后呢|接下来呢|为什么(?:呢)?|怎么做|怎么办|失败了(?:怎么办)?|还不行(?:怎么办)?|怎么(?:测试|验证|继续)|这个(?:怎么做|怎么办|呢))\s*[?？!！。.]*$|^(?:(?:and|then)\s+)?(?:next|what next|what is next|why|how so|it failed|still fails|what if it fails|how (?:do i|to) (?:test|continue)|what about testing)\s*[?!.]*$/i.test(question.trim());
  if (followup || wantsAction) {
    // Recognize only our complete reviewed answer text, never arbitrary prose
    // supplied in an assistant history entry. This keeps later follow-ups useful
    // after the original question has left the six-turn history window.
    const reviewed = [...getProductHelpArticles('en', content), ...getProductHelpArticles('zh-CN', content)];
    for (const turn of [...history].reverse()) {
      if (turn.role === 'user') {
        if (isClearlyOutsideProductHelp(turn.text)) break;
        if (actionOnlyFollowup.test(turn.text.trim())) continue;
        const id = match(wantsAction ? turn.text : `${turn.text} ${question}`);
        if (id) return { kind: 'answer', articleIds: [id] };
      } else {
        const previous = reviewed.find((article) => turn.text.includes(`${article.title}\n\n${article.text}`));
        if (previous) return { kind: 'answer', articleIds: [wantsAction ? previous.id : match(`${previous.title} ${question}`) ?? previous.id] };
      }
    }
  }
  if (current) return { kind: 'answer', articleIds: [current] };
  return { kind: /superwagie|openchamber|犇马|产品|应用|app\b/i.test(question) || followup || wantsAction ? 'not-covered' : 'out-of-scope', articleIds: [] };
}
