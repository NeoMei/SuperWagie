/** Session notice rows in the chat (`@/lib/opencode/session-notices`) — merged into each locale's main dictionary. */
export const sessionNoticesI18n = {
  en: {
    'chat.sessionNotice.restart': 'Continuing after restart',
    'chat.sessionNotice.commandFailed': 'Command failed to start: {command}',
    'chat.sessionNotice.moved': 'Moved to {folder}',
    'chat.sessionNotice.movedUnknown': 'Moved to another folder',
    'chat.sessionNotice.showDetails': 'Show what the agent received',
    'chat.sessionNotice.hideDetails': 'Hide what the agent received',
  },
  'zh-CN': {
    'chat.sessionNotice.restart': '重启后继续',
    'chat.sessionNotice.commandFailed': '命令无法启动：{command}',
    'chat.sessionNotice.moved': '已移至 {folder}',
    'chat.sessionNotice.movedUnknown': '已移至其他文件夹',
    'chat.sessionNotice.showDetails': '显示代理收到的内容',
    'chat.sessionNotice.hideDetails': '隐藏代理收到的内容',
  },
} as const;
