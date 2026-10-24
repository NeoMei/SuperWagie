import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { CREATION_NEW_LABEL_KEY, WORK_CATEGORY_ICON, WORK_CATEGORY_LABEL_KEY, type WorkCategoryHeaderKey } from '@/lib/creation';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

/**
 * One work category in the session list. The + opens what that category
 * creates: a project, a new chat, or the guide with this creation type chosen.
 */
export const WorkCategoryHeader: React.FC<{
  category: WorkCategoryHeaderKey;
  collapsed: boolean;
  forceExpanded: boolean;
  onToggle: () => void;
  onNewChat?: () => void;
  onAddProject?: () => void;
  alwaysShowActions?: boolean;
}> = ({ category, collapsed, forceExpanded, onToggle, onNewChat, onAddProject, alwaysShowActions = false }) => {
  const { t } = useI18n();
  const label = t(WORK_CATEGORY_LABEL_KEY[category]);
  const create = (): void => {
    if (category === 'chat') onNewChat?.();
    else if (category === 'projects') onAddProject?.();
    else useUIStore.getState().openCreation(category);
  };
  const createLabel = t(category === 'projects' ? 'creation.new.project' : CREATION_NEW_LABEL_KEY[category]);
  return (
    <div className="relative group/category -ms-2.5 -me-2">
      <button
        type="button"
        onClick={onToggle}
        disabled={forceExpanded}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 rounded-md py-1 pe-10 ps-4 text-start"
      >
        {forceExpanded ? null : (
          <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Icon name={WORK_CATEGORY_ICON[category]} className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
        <span className="typography-ui-header font-semibold text-foreground">{label}</span>
      </button>
      {category !== 'projects' || onAddProject ? <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={createLabel}
        title={createLabel}
        onClick={create}
        className={cn(
          'absolute inset-e-0.5 top-1/2 z-10 w-6 -translate-y-1/2 text-muted-foreground hover:bg-transparent hover:text-foreground',
          alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/category:opacity-100 group-hover/category:pointer-events-auto group-has-[:focus-visible]/category:opacity-100 group-has-[:focus-visible]/category:pointer-events-auto',
        )}
      >
        <Icon name="add" className="h-4 w-4" />
      </Button> : null}
    </div>
  );
};
