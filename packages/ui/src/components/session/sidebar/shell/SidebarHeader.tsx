import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Icon } from "@/components/icon/Icon";
import { resolveSidebarGrouping, useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { SessionSearchInput } from '@/components/session/SessionSearchInput';
import { Button } from '@/components/ui/button';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestPages } from '@/hooks/useGuestSurfaces';
import { CREATION_GUEST_ID } from '@/lib/creation';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { useUIStore } from '@/stores/useUIStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

type Props = {
  hideDirectoryControls: boolean;
  showProjectDisplayControls: boolean;
  showSectionControls: boolean;
  handleOpenDirectoryDialog: () => void;
  /** Whether the issues and pull requests board is offered. */
  showSourceBoard: boolean;
  headerActionIconClass: string;
  headerActionButtonClass: string;
  isSessionSearchOpen: boolean;
  openSessionSearch: () => void;
  /** Hides the field and drops its query. */
  closeSessionSearch: () => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
  collapseAll: () => void;
  expandAll: () => void;
};

/**
 * Whether the remaining extension pages get buttons next to the fixed tools
 * without pushing into the list controls. All or nothing: once they stop
 * fitting, they all move into one menu, so a page never hops between the row
 * and the menu as the sidebar resizes. The measured parts don't change with
 * the answer, so it cannot flip back and forth on its own.
 */
function useGuestPagesFitInline(
  rowRef: React.RefObject<HTMLDivElement | null>,
  fixedToolsRef: React.RefObject<HTMLDivElement | null>,
  listControlsRef: React.RefObject<HTMLDivElement | null>,
  count: number,
  expanded: boolean,
): boolean {
  const [fits, setFits] = React.useState(true);
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    const fixedTools = fixedToolsRef.current;
    const listControls = listControlsRef.current;
    if (!row || !fixedTools || !listControls || count === 0 || expanded) return;
    const measure = () => {
      const button = fixedTools.lastElementChild;
      const buttonWidth = button ? button.getBoundingClientRect().width : 0;
      const fixedStyle = getComputedStyle(fixedTools);
      const gap = Number.parseFloat(fixedStyle.columnGap) || 0;
      const inset = Number.parseFloat(fixedStyle.marginInlineStart) || 0;
      const rowGap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      const needed = inset + fixedTools.getBoundingClientRect().width + count * (gap + buttonWidth);
      const available = row.getBoundingClientRect().width - listControls.getBoundingClientRect().width - rowGap;
      setFits(needed <= available);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(fixedTools);
    observer.observe(listControls);
    return () => observer.disconnect();
  }, [rowRef, fixedToolsRef, listControlsRef, count, expanded]);
  return fits;
}

const PRESSED_PAGE_BUTTON_CLASS = 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground';
const IDLE_PAGE_BUTTON_CLASS = 'text-muted-foreground hover:text-foreground hover:bg-transparent';

type SidebarTool = {
  id: string;
  label: string;
  pressed: boolean;
  onClick: () => void;
  icon: React.ReactNode;
};

/**
 * A page the sidebar opens in the main area. The button stays pressed while
 * its page is open, and the same click closes the page again.
 */
function SidebarPageButton({ tool, className, showLabel = false }: {
  tool: SidebarTool;
  className: string;
  showLabel?: boolean;
}): React.ReactNode {
  const { label, pressed, onClick, icon } = tool;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            showLabel
              ? 'flex min-h-14 min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-md px-1.5 py-1.5'
              : className,
            pressed
              ? PRESSED_PAGE_BUTTON_CLASS
              : showLabel
                ? 'oc-tile oc-tile-hover text-foreground focus-visible:bg-interactive-hover'
                : IDLE_PAGE_BUTTON_CLASS,
          )}
          aria-label={label}
          aria-pressed={pressed}
        >
          {icon}
          {showLabel ? <span className="line-clamp-2 max-w-full text-center typography-meta [overflow-wrap:anywhere]">{label}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side={showLabel ? 'top' : 'bottom'} sideOffset={4}><p>{label}</p></TooltipContent>
    </Tooltip>
  );
}

export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  const availableGuestPages = useGuestPages();
  const workbenchPage = availableGuestPages.find((guest) => guest.id === 'openchamber-builtin-workbench');
  // Workbench stays in the fixed page group; creation has its own section.
  const guestPages = availableGuestPages.filter((guest) => guest.id !== CREATION_GUEST_ID && guest.id !== workbenchPage?.id);
  const {
    hideDirectoryControls,
    showProjectDisplayControls,
    showSectionControls,
    handleOpenDirectoryDialog,
    showSourceBoard,
    headerActionIconClass,
    headerActionButtonClass,
    isSessionSearchOpen,
    openSessionSearch,
    closeSessionSearch,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
    collapseAll,
    expandAll,
  } = props;

  const [toolbarExpanded, setToolbarExpanded] = React.useState(false);
  const toolbarPanelId = React.useId();
  const rowRef = React.useRef<HTMLDivElement>(null);
  const fixedToolsRef = React.useRef<HTMLDivElement>(null);
  const listControlsRef = React.useRef<HTMLDivElement>(null);
  const guestPagesInline = useGuestPagesFitInline(rowRef, fixedToolsRef, listControlsRef, guestPages.length, toolbarExpanded);

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const toggleSelectionMode = useSessionMultiSelectStore((state) => state.toggleMode);

  const isSourceBoardOpen = useUIStore((state) => state.isSourceBoardOpen);
  const isOverviewOpen = useUIStore((state) => state.isOverviewOpen);
  const overviewAvailable = useUIStore((state) => state.overviewFeatureAvailable);
  const isScheduledOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveOpen = useUIStore((state) => state.isArchivePageOpen);
  const isIntegrationsCatalogOpen = useUIStore((state) => state.isIntegrationsCatalogOpen);
  // The bundled catalog offers outside services; enterprise mode waits for
  // administrator-curated sources instead.
  const enterpriseMode = useEnterpriseMode();
  const openGuestPageId = useUIStore((state) => state.openGuestPageId);

  const showChatsSection = useSessionDisplayStore((state) => state.showChatsSection);
  const setShowChatsSection = useSessionDisplayStore((state) => state.setShowChatsSection);
  const showWorkSection = useSessionDisplayStore((state) => state.showWorkSection);
  const setShowWorkSection = useSessionDisplayStore((state) => state.setShowWorkSection);
  const showPinnedSection = useSessionDisplayStore((state) => state.showPinnedSection);
  const setShowPinnedSection = useSessionDisplayStore((state) => state.setShowPinnedSection);
  const detailedZoneRows = useSessionDisplayStore((state) => state.detailedZoneRows);
  const setDetailedZoneRows = useSessionDisplayStore((state) => state.setDetailedZoneRows);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const setProjectSortOrder = useSessionDisplayStore((state) => state.setProjectSortOrder);
  const sidebarGrouping = useSessionDisplayStore(resolveSidebarGrouping);
  const setSidebarGrouping = useSessionDisplayStore((state) => state.setSidebarGrouping);
  const keepWorkInPlace = useSessionDisplayStore((state) => state.keepWorkInPlace);
  const setKeepWorkInPlace = useSessionDisplayStore((state) => state.setKeepWorkInPlace);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const setProjectDisplayMode = useSessionDisplayStore((state) => state.setProjectDisplayMode);
  // VS Code always groups under its workspace.
  const timeGrouping = showProjectDisplayControls && sidebarGrouping === 'time';
  const isSingleProjectMode = showProjectDisplayControls && projectDisplayMode === 'single';

  // One choice per line, rarely touched orders behind submenus that name the
  // current choice, so the menu stays short: selection first, then the view,
  // its orders, the sections, and collapse.
  const checkMark = <Icon name="check" className="h-4 w-4 text-primary" />;
  const choiceSubmenu = <T extends string>(
    labelKey: I18nKey,
    options: readonly (readonly [T, I18nKey])[],
    current: T,
    onSelect: (value: T) => void,
  ) => {
    const currentLabelKey = options.find(([value]) => value === current)?.[1];
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="flex-1">{t(labelKey)}</span>
          {currentLabelKey ? <span className="ms-4 text-muted-foreground">{t(currentLabelKey)}</span> : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[160px]">
          {options.map(([value, optionLabelKey]) => (
            <DropdownMenuItem key={value} onClick={() => onSelect(value)} className="flex items-center justify-between">
              <span>{t(optionLabelKey)}</span>
              {current === value ? checkMark : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };
  const toggleItem = (labelKey: I18nKey, checked: boolean, onToggle: () => void) => (
    <DropdownMenuItem onClick={onToggle} className="flex items-center justify-between">
      <span>{t(labelKey)}</span>
      {checked ? checkMark : null}
    </DropdownMenuItem>
  );
  const displayMenuSections: React.ReactNode[] = [
    <DropdownMenuItem key="select" onClick={toggleSelectionMode} className="flex items-center gap-2">
      <Icon name="checkbox-multiple" className="h-4 w-4" />
      <span>{selectionModeEnabled
        ? t('sessions.sidebar.header.actions.exitSelection')
        : t('sessions.sidebar.header.actions.selectSessions')}</span>
    </DropdownMenuItem>,
  ];
  // One view: works under their projects, or every project's works in one
  // list by time, which has no project headers to sort.
  if (showProjectDisplayControls) {
    displayMenuSections.push(choiceSubmenu('sessions.sidebar.header.listGrouping.label', [
      ['project', 'sessions.sidebar.header.listGrouping.project'],
      ['time', 'sessions.sidebar.header.listGrouping.time'],
    ] as const, sidebarGrouping, (grouping) => {
      setSidebarGrouping(grouping);
      void updateDesktopSettings({ sidebarGrouping: grouping });
    }));
  }
  displayMenuSections.push(<>
    {!timeGrouping ? choiceSubmenu('sessions.sidebar.header.actions.sortProjects', [
      ['manual', 'sessions.sidebar.header.projectSort.manual'],
      ['a-z', 'sessions.sidebar.header.projectSort.aToZ'],
      ['z-a', 'sessions.sidebar.header.projectSort.zToA'],
      ['date-added', 'sessions.sidebar.header.projectSort.dateAdded'],
      ['recent', 'sessions.sidebar.header.projectSort.recent'],
    ] as const, projectSortOrder, (order) => {
      setProjectSortOrder(order);
      void updateDesktopSettings({ sidebarProjectSortOrder: order });
    }) : null}
    {showProjectDisplayControls ? choiceSubmenu('sessions.sidebar.header.projectDisplay.label', [
      ['all', 'sessions.sidebar.header.projectDisplay.all'],
      ['single', 'sessions.sidebar.header.projectDisplay.single'],
    ] as const, projectDisplayMode, (mode) => {
      setProjectDisplayMode(mode);
      void updateDesktopSettings({ sidebarProjectDisplayMode: mode });
    }) : null}
  </>);
  if (showSectionControls) {
    displayMenuSections.push(<>
      {toggleItem('sessions.sidebar.header.displayMode.showChats', showChatsSection, () => {
        setShowChatsSection(!showChatsSection);
        void updateDesktopSettings({ sidebarShowChatsSection: !showChatsSection });
      })}
      {toggleItem('sessions.sidebar.header.displayMode.showPinned', showPinnedSection, () => {
        setShowPinnedSection(!showPinnedSection);
        void updateDesktopSettings({ sidebarShowPinnedSection: !showPinnedSection });
      })}
      {sessionWorkEnabled ? toggleItem('sessions.sidebar.header.displayMode.showWork', showWorkSection, () => {
        setShowWorkSection(!showWorkSection);
        void updateDesktopSettings({ sidebarShowWorkSection: !showWorkSection });
      }) : null}
      {/* A work in In work leaves its project unless asked; VS Code always keeps it there. */}
      {sessionWorkEnabled && showWorkSection && showProjectDisplayControls ? toggleItem('sessions.sidebar.header.displayMode.keepWorkInPlace', keepWorkInPlace, () => {
        setKeepWorkInPlace(!keepWorkInPlace);
        void updateDesktopSettings({ sidebarKeepWorkInPlace: !keepWorkInPlace });
      }) : null}
      {/* Rows that mix projects keep one line unless asked. */}
      {toggleItem('sessions.sidebar.header.displayMode.detailedZoneRows', detailedZoneRows, () => {
        setDetailedZoneRows(!detailedZoneRows);
        void updateDesktopSettings({ sidebarDetailedZoneRows: !detailedZoneRows });
      })}
    </>);
  }
  if (!isSingleProjectMode) {
    displayMenuSections.push(<>
      <DropdownMenuItem onClick={collapseAll} className="flex items-center gap-2">
        <Icon name="contract-up-down" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.displayMode.collapseAll')}</span>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={expandAll} className="flex items-center gap-2">
        <Icon name="expand-up-down" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.displayMode.expandAll')}</span>
      </DropdownMenuItem>
    </>);
  }

  if (hideDirectoryControls) {
    // VS Code: the sidebar is always a single workspace, so project/directory
    // controls stay hidden, but session search is still useful. Show a compact,
    // always-visible search input at the top of the sessions list.
    return (
      <div className="select-none flex-shrink-0 px-2.5 py-1.5">
        <SessionSearchInput
          inputRef={sessionSearchInputRef}
          value={sessionSearchQuery}
          onSearch={setSessionSearchQuery}
          onClose={closeSessionSearch}
          placeholder={t('sessions.sidebar.header.search.placeholder')}
          clearLabel={t('sessions.sidebar.header.search.clear')}
          leadingHint={hasSessionSearchQuery
            ? (searchMatchCount === 1
              ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
              : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount }))
            : undefined}
          trailingHint={t('sessions.sidebar.header.search.escapeHint')}
        />
      </div>
    );
  }

  const toolbarLabel = t('sessions.sidebar.header.toolbar');
  const guestTool = (guest: (typeof availableGuestPages)[number]): SidebarTool => {
    const pressed = openGuestPageId === guest.id;
    return {
      id: `guest:${guest.id}`,
      label: guest.pageTitle ?? guest.name,
      pressed,
      onClick: () => useUIStore.getState().setOpenGuestPage(pressed ? null : guest.id),
      icon: <GuestIcon
        icon={resolveGuestIconName(guest.icon)}
        iconSrc={guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset)}
        className={headerActionIconClass}
      />,
    };
  };
  const fixedTools: SidebarTool[] = [];
  if (workbenchPage) fixedTools.push(guestTool(workbenchPage));
  if (showSourceBoard && overviewAvailable) fixedTools.push({
    id: 'overview',
    label: t('overview.title'),
    pressed: isOverviewOpen,
    onClick: () => useUIStore.getState().setOverviewOpen(!isOverviewOpen),
    icon: <Icon name="compass-3" className={headerActionIconClass} />,
  });
  if (showSourceBoard) fixedTools.push({
    id: 'source-board',
    label: t('sourceBoard.title'),
    pressed: isSourceBoardOpen,
    onClick: () => useUIStore.getState().setSourceBoardOpen(!isSourceBoardOpen),
    icon: <Icon name="git-pull-request" className={headerActionIconClass} />,
  });
  fixedTools.push({
    id: 'scheduled-tasks',
    label: t('sessions.sidebar.header.actions.scheduledTasks'),
    pressed: isScheduledOpen,
    onClick: () => useUIStore.getState().setScheduledTasksDialogOpen(!isScheduledOpen),
    icon: <Icon name="calendar-schedule" className={headerActionIconClass} />,
  }, {
    id: 'archive',
    label: t('sessions.sidebar.nav.archive'),
    pressed: isArchiveOpen,
    onClick: () => useUIStore.getState().setArchivePageOpen(!isArchiveOpen),
    icon: <Icon name="archive" className={headerActionIconClass} />,
  });
  if (!enterpriseMode) fixedTools.push({
    id: 'integrations',
    label: t('integrationsCatalog.sidebar.open'),
    pressed: isIntegrationsCatalogOpen,
    onClick: () => useUIStore.getState().setIntegrationsCatalogOpen(!isIntegrationsCatalogOpen),
    icon: <Icon name="store-2" className={headerActionIconClass} />,
  });
  const extensionTools = guestPages.map(guestTool);
  const renderTool = (tool: SidebarTool, showLabel: boolean) => (
    <SidebarPageButton key={tool.id} tool={tool} className={cn(headerActionButtonClass, 'shrink-0')} showLabel={showLabel} />
  );

  return (
    <div className="select-none flex-shrink-0 px-2.5 py-1">
      <div className="flex h-auto min-h-8 flex-col gap-1">
        <div ref={rowRef} className="flex min-h-8 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <div ref={fixedToolsRef} className="ms-[3px] flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setToolbarExpanded((expanded) => !expanded)}
                    className={cn(
                      headerActionButtonClass,
                      toolbarExpanded && 'w-auto justify-start gap-1 pe-2 typography-meta font-medium',
                    )}
                    aria-label={toolbarLabel}
                    aria-expanded={toolbarExpanded}
                    aria-controls={toolbarPanelId}
                  >
                    <Icon name={toolbarExpanded ? 'arrow-down-s' : 'arrow-right-s'} className={cn(headerActionIconClass, 'shrink-0')} />
                    {toolbarExpanded ? <span>{toolbarLabel}</span> : null}
                  </button>
                </TooltipTrigger>
                {!toolbarExpanded ? <TooltipContent side="top" sideOffset={4}><p>{toolbarLabel}</p></TooltipContent> : null}
              </Tooltip>
              {!toolbarExpanded ? fixedTools.map((tool) => renderTool(tool, false)) : null}
            </div>
            {!toolbarExpanded && (guestPagesInline ? extensionTools.map((tool) => renderTool(tool, false)) : guestPages.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="xs" className="w-6 text-muted-foreground" aria-label={t('sessions.sidebar.header.actions.extensionPages')}>
                    <Icon name="puzzle" className={headerActionIconClass} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>{t('sessions.sidebar.header.actions.extensionPages')}</DropdownMenuLabel>
                  {guestPages.map((guest) => <DropdownMenuItem key={guest.id} onSelect={() => useUIStore.getState().setOpenGuestPage(guest.id)}>
                    <GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset)} className="size-4" />
                    <span>{guest.pageTitle ?? guest.name}</span>
                  </DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
          </div>

          <div ref={listControlsRef} className="flex min-w-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={isSessionSearchOpen ? closeSessionSearch : openSessionSearch}
                  className={cn(headerActionButtonClass, isSessionSearchOpen ? PRESSED_PAGE_BUTTON_CLASS : IDLE_PAGE_BUTTON_CLASS)}
                  aria-label={t('sessions.sidebar.header.actions.searchSessions')}
                  aria-expanded={isSessionSearchOpen}
                >
                  <Icon name="search" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.searchSessions')}</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenDirectoryDialog}
                  className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                  aria-label={t('sessions.sidebar.header.actions.addProject')}
                >
                  <Icon name="folder-add" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.addProject')}</p></TooltipContent>
            </Tooltip>

            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                      aria-label={t('sessions.sidebar.header.displayMode.label')}
                    >
                      <Icon name="equalizer-2" className={headerActionIconClass} />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.displayMode.label')}</p></TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                {displayMenuSections.map((section, index) => (
                  <React.Fragment key={index}>
                    {index > 0 ? <DropdownMenuSeparator /> : null}
                    {section}
                  </React.Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div
          id={toolbarPanelId}
          className={toolbarExpanded
            ? 'grid max-h-[40vh] grid-cols-[repeat(auto-fill,minmax(min(100%,5rem),1fr))] gap-1.5 overflow-y-auto pb-1'
            : 'hidden'}
        >
          {toolbarExpanded ? [...fixedTools, ...extensionTools].map((tool) => renderTool(tool, true)) : null}
        </div>

        {isSessionSearchOpen ? (
          <div className="pb-1">
            <SessionSearchInput
              inputRef={sessionSearchInputRef}
              value={sessionSearchQuery}
              onSearch={setSessionSearchQuery}
              onClose={closeSessionSearch}
              placeholder={t('sessions.sidebar.header.search.placeholder')}
              clearLabel={t('sessions.sidebar.header.search.clear')}
              leadingHint={hasSessionSearchQuery
                ? (searchMatchCount === 1
                  ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
                  : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount }))
                : undefined}
              trailingHint={t('sessions.sidebar.header.search.escapeHint')}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
