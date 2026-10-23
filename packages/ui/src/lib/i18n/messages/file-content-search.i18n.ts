/** Find in files in the sidebar files tree (search mode menu, regex toggle, result rows) — merged into each locale's main dictionary. */
export const fileContentSearchI18n = {
  en: {
    'sidebarFilesTree.search.mode.aria': 'Search mode',
    'sidebarFilesTree.search.mode.names': 'File names',
    'sidebarFilesTree.search.mode.contents': 'File contents',
    'sidebarFilesTree.search.contentsPlaceholder': 'Search in files...',
    'sidebarFilesTree.search.regexTitle': 'Use regular expression',
    'sidebarFilesTree.contentSearch.empty': 'No matches.',
    'sidebarFilesTree.contentSearch.limit': 'Showing the first {count} matches.',
    'sidebarFilesTree.contentSearch.deadline': 'The search stopped after 30 seconds, so the list may be incomplete.',
    'sidebarFilesTree.contentSearch.unavailable': 'This server cannot search file contents: it has no ripgrep.',
    'sidebarFilesTree.contentSearch.invalidPattern': 'This regular expression is not valid.',
    'sidebarFilesTree.contentSearch.failed': 'The search failed: {message}',
  },
  'zh-CN': {
    'sidebarFilesTree.search.mode.aria': '搜索模式',
    'sidebarFilesTree.search.mode.names': '文件名',
    'sidebarFilesTree.search.mode.contents': '文件内容',
    'sidebarFilesTree.search.contentsPlaceholder': '在文件中搜索...',
    'sidebarFilesTree.search.regexTitle': '使用正则表达式',
    'sidebarFilesTree.contentSearch.empty': '没有匹配项。',
    'sidebarFilesTree.contentSearch.limit': '仅显示前 {count} 个匹配项。',
    'sidebarFilesTree.contentSearch.deadline': '搜索在 30 秒后停止，列表可能不完整。',
    'sidebarFilesTree.contentSearch.unavailable': '此服务器没有 ripgrep，无法搜索文件内容。',
    'sidebarFilesTree.contentSearch.invalidPattern': '此正则表达式无效。',
    'sidebarFilesTree.contentSearch.failed': '搜索失败：{message}',
  },
} as const;
