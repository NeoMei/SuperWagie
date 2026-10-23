/** Tracker item strings for the composer, work status and New Worktree (`{provider}` names the tracker) — merged into each locale's main dictionary. */
export const linearIssuePickerI18n = {
  en: {
    'chat.chatInput.actions.linkTrackerItem': 'Link {provider} Issue',
    'chat.chatInput.linked.trackerItem.openInBrowserAria': 'Open issue in {provider}',
    'chat.chatInput.linked.trackerItem.removeAria': 'Remove linked {provider} issue',
    'chat.workStatus.linkedIssues.openTrackerItem': 'Open {identifier} in {provider}',
    'session.newWorktree.actions.startFromTrackerItem': 'A {provider} issue',
  },
  'zh-CN': {
    'chat.chatInput.actions.linkTrackerItem': '关联 {provider} Issue',
    'chat.chatInput.linked.trackerItem.openInBrowserAria': '在 {provider} 中打开 Issue',
    'chat.chatInput.linked.trackerItem.removeAria': '移除已关联的 {provider} Issue',
    'chat.workStatus.linkedIssues.openTrackerItem': '在 {provider} 中打开 {identifier}',
    'session.newWorktree.actions.startFromTrackerItem': '从 {provider} Issue 开始',
  },
} as const;
