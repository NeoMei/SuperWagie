import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { useSessionTodosStore, type SessionTodo } from '@/stores/useSessionTodosStore';
import { WorkStatusCollapsibleSection, WorkStatusNote, WorkStatusRow } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

const STATUS_ICON = {
  pending: 'checkbox-blank', in_progress: 'checkbox-blank-circle', completed: 'checkbox', cancelled: 'close',
} satisfies Record<SessionTodo['status'], IconName>;

/** Session tool steps remain separate from project plans and personal Markdown tasks. */
export const WorkStatusTasksSection: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const entry = useSessionTodosStore((state) => sessionId ? state.entries[sessionId] : undefined);
  const present = entry !== undefined && entry.state !== 'off' && entry.state !== 'unsupported';
  useReportWorkStatusPresence('tasks', present);
  if (!present) return null;
  const todos = entry.todos.filter((todo) => todo.status !== 'cancelled');
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <WorkStatusCollapsibleSection id="tasks" title={t('chat.workStatus.section.tasks')} icon="list-check-2" summary={todos.length > 0 ? `${completed}/${todos.length}` : undefined} defaultExpanded>
      {entry.failures > 0 ? <WorkStatusNote>{t(entry.state === 'loading' ? 'chat.workStatus.tasks.initialReadFailed' : 'chat.workStatus.tasks.readFailed')}</WorkStatusNote> : null}
      {entry.state === 'loading' && entry.failures === 0 ? <WorkStatusNote>{t('chat.workStatus.tasks.loading')}</WorkStatusNote> : null}
      {entry.state === 'ready' && todos.length === 0 ? <WorkStatusNote>{t('chat.workStatus.tasks.empty')}</WorkStatusNote> : null}
      <div className="max-h-72 overflow-y-auto">
        {todos.map((todo, index) => (
          <WorkStatusRow key={`${index}-${todo.content}`} leading={<Icon name={STATUS_ICON[todo.status]} className="size-3" />} muted={todo.status === 'completed'} label={<span dir="auto" className={todo.status === 'completed' ? 'line-through' : undefined}>{todo.content}</span>} tooltip={`${t(`chat.statusRow.todo.status.${todo.status === 'in_progress' ? 'inProgress' : todo.status}`)}: ${todo.content}`} />
        ))}
      </div>
    </WorkStatusCollapsibleSection>
  );
};
