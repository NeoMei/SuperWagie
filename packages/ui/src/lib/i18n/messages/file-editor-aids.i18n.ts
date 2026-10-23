/** Files editor aids (git change view, JSON errors, import links) — merged into each locale's main dictionary. */
export const fileEditorAidsI18n = {
  en: {
    'filesView.editor.gitHunk.revert': 'Revert',
    'filesView.editor.gitHunk.close': 'Close',
    'filesView.editor.jsonSyntaxError': 'The JSON stops parsing here',
    'filesView.editor.importNotFound': 'No file found for {path}',
    'filesView.editor.importLookupFailed': 'Could not look up {path}',
  },
  'zh-CN': {
    'filesView.editor.gitHunk.revert': '还原',
    'filesView.editor.gitHunk.close': '关闭',
    'filesView.editor.jsonSyntaxError': 'JSON 从这里开始无法解析',
    'filesView.editor.importNotFound': '找不到 {path} 对应的文件',
    'filesView.editor.importLookupFailed': '无法查找 {path}',
  },
} as const;
