import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { WORK_CATEGORY_ICON, WORK_CATEGORY_LABEL, type WorkCategoryHeaderKey } from '@/lib/creation';
import { useUIStore } from '@/stores/useUIStore';

/**
 * One work category in the session list. The + opens what that category
 * creates: a new chat, or the guide with this creation type already chosen.
 */
export const WorkCategoryHeader: React.FC<{
  category: WorkCategoryHeaderKey;
  collapsed: boolean;
  forceExpanded: boolean;
  onToggle: () => void;
  onNewChat?: () => void;
}> = ({ category, collapsed, forceExpanded, onToggle, onNewChat }) => {
  const label = WORK_CATEGORY_LABEL[category];
  const create = (): void => {
    if (category === 'chat') onNewChat?.();
    else if (category !== 'projects') useUIStore.getState().openCreation(category);
  };
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
      {category !== 'projects' ? <button
        type="button"
        aria-label={`新建${label}`}
        onClick={create}
        className="absolute inset-e-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 pointer-events-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover/category:opacity-100 group-hover/category:pointer-events-auto group-has-[:focus-visible]/category:opacity-100 group-has-[:focus-visible]/category:pointer-events-auto"
      >
        <Icon name="add" className="h-4 w-4" />
      </button> : null}
    </div>
  );
};
