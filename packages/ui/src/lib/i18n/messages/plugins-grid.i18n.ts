/** Plugins settings card grid and Settings list-search strings — merged into each locale's main dictionary. */
export const pluginsGridI18n = {
  en: {
    'settings.plugins.grid.actionsAria': 'Actions for {name}',
    'settings.common.sidebar.searchPlaceholder': 'Search',
    'settings.common.sidebar.noMatches': 'Nothing matches “{query}”.',
    'settings.plugins.grid.description': 'OpenCode plugins from npm, local paths and plugin files. Open one to edit it.',
    'settings.plugins.grid.searchPlaceholder': 'Search plugins',
    'settings.plugins.grid.addHint': 'npm package or local path',
    'settings.plugins.grid.noMatches': 'No plugins match “{query}”.',
    'settings.plugins.grid.empty': 'No plugins yet.',
    'settings.plugins.grid.scope.project': 'Project',
    'settings.plugins.page.back': 'All plugins',
  },
  'zh-CN': {
    'settings.plugins.grid.actionsAria': '{name} 的操作',
    'settings.common.sidebar.searchPlaceholder': '搜索',
    'settings.common.sidebar.noMatches': '没有与“{query}”匹配的内容。',
    'settings.plugins.grid.description': '来自 npm、本地路径和插件文件的 OpenCode 插件。打开一个即可编辑。',
    'settings.plugins.grid.searchPlaceholder': '搜索插件',
    'settings.plugins.grid.addHint': 'npm 包或本地路径',
    'settings.plugins.grid.noMatches': '没有与“{query}”匹配的插件。',
    'settings.plugins.grid.empty': '还没有插件。',
    'settings.plugins.grid.scope.project': '项目',
    'settings.plugins.page.back': '所有插件',
  },
} as const;
