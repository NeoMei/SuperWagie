/** MCP settings card grid strings — merged into each locale's main dictionary. */
export const mcpGridI18n = {
  en: {
    'settings.mcp.grid.actionsAria': 'Actions for {name}',
    'settings.mcp.grid.description': 'Tool servers your agents can call. Open one to see its status and settings.',
    'settings.mcp.grid.searchPlaceholder': 'Search servers',
    'settings.mcp.grid.addHint': 'Local command or remote URL',
    'settings.mcp.grid.noMatches': 'No servers match “{query}”.',
    'settings.mcp.grid.empty': 'No MCP servers yet.',
    'settings.mcp.grid.status.disabled': 'Disabled',
    'settings.mcp.grid.status.pending': 'Connecting',
    'settings.mcp.grid.status.blockedByPolicy': 'Blocked by policy',
    'settings.mcp.grid.scope.project': 'Project',
    'settings.mcp.page.back': 'All servers',
  },
  'zh-CN': {
    'settings.mcp.grid.actionsAria': '{name} 的操作',
    'settings.mcp.grid.description': '智能体可以调用的工具服务器。打开一个即可查看状态和设置。',
    'settings.mcp.grid.searchPlaceholder': '搜索服务器',
    'settings.mcp.grid.addHint': '本地命令或远程 URL',
    'settings.mcp.grid.noMatches': '没有与“{query}”匹配的服务器。',
    'settings.mcp.grid.empty': '还没有 MCP 服务器。',
    'settings.mcp.grid.status.disabled': '已停用',
    'settings.mcp.grid.status.pending': '连接中',
    'settings.mcp.grid.status.blockedByPolicy': '已被策略阻止',
    'settings.mcp.grid.scope.project': '项目',
    'settings.mcp.page.back': '所有服务器',
  },
} as const;
