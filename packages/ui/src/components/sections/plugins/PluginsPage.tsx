import React from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AddPluginDialog } from './AddPluginDialog';
import { PluginsGrid, type PluginDeleteTarget } from './PluginsGrid';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
  useAutosave,
  AUTOSAVE_SAVED,
  AUTOSAVE_UNCHANGED,
  autosaveFailed,
  type AutosaveResult,
} from '@/components/sections/shared/SettingsAutosave';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { usePluginOperationOwner } from './usePluginOperationOwner';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { RegistryBanner } from './RegistryBanner';
import { PluginStatusBanner } from './PluginStatusBanner';
import { configEntryRuntimeTarget, pluginFileRuntimeTarget } from './pluginLoadState';
import {
  usePluginsStore,
  getPluginsConfigDirectory,
  capturePluginsOwner,
  type PluginDraft,
  type PluginEntry,
  type PluginFile,
  type PluginScope,
} from '@/stores/usePluginsStore';

interface OptionsParseResult {
  ok: boolean;
  value?: Record<string, unknown>;
}

function parseOptionsJson(raw: string): OptionsParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function stringifyOptions(options: Record<string, unknown> | undefined): string {
  if (!options || Object.keys(options).length === 0) {
    return '';
  }
  return JSON.stringify(options, null, 2);
}

function optionsEqual(left: string, right: string): boolean {
  if (left.trim() === right.trim()) return true;
  const parsedLeft = parseOptionsJson(left);
  const parsedRight = parseOptionsJson(right);
  return parsedLeft.ok && parsedRight.ok
    && stringifyOptions(parsedLeft.value) === stringifyOptions(parsedRight.value);
}

function buildEntryDraft(entry: PluginEntry): PluginDraft {
  return {
    mode: 'entry',
    scope: entry.scope,
    spec: entry.spec,
    optionsJson: stringifyOptions(entry.options),
    fileName: '',
    content: '',
  };
}

function buildFileDraft(file: PluginFile, content: string): PluginDraft {
  return {
    mode: 'file',
    scope: file.scope,
    spec: '',
    optionsJson: '',
    fileName: file.fileName,
    content,
  };
}

const ScopeBadge: React.FC<{ scope: PluginScope; label: string }> = ({ scope, label }) => {
  return (
    <span
      className={cn(
        'typography-micro font-medium rounded-full px-2 py-0.5',
        'bg-[var(--surface-elevated)] text-muted-foreground',
        'border border-[var(--interactive-border)]',
      )}
      data-scope={scope}
    >
      {label}
    </span>
  );
};

export const PluginsPage: React.FC = () => {
  const { t } = useI18n();
  const { visit, scope, ownsVisit, ownsScope } = usePluginOperationOwner();

  const projectDirectory = useProjectsStore((state) => state.getActiveProject()?.path);
  const configDirectory = projectDirectory?.trim() || getPluginsConfigDirectory();
  const loadedDirectory = usePluginsStore((state) => state.loadedDirectory);
  const loadedRuntimeKey = usePluginsStore((state) => state.loadedRuntimeKey);
  const loadedOwner = usePluginsStore((state) => state.loadedOwner);
  const catalogIsCurrent = loadedDirectory === configDirectory && loadedRuntimeKey === getRuntimeKey() && (loadedOwner?.() ?? true);
  const selectedId = usePluginsStore((s) => s.selectedId);
  const entries = usePluginsStore((s) => s.entries);
  const files = usePluginsStore((s) => s.files);
  const draft = usePluginsStore((s) => s.draft);
  const setDraft = usePluginsStore((s) => s.setDraft);
  const updateEntry = usePluginsStore((s) => s.updateEntry);
  const updateFile = usePluginsStore((s) => s.updateFile);
  const readFile = usePluginsStore((s) => s.readFile);
  const setSelected = usePluginsStore((s) => s.setSelected);
  const deleteEntry = usePluginsStore((s) => s.deleteEntry);
  const deleteFile = usePluginsStore((s) => s.deleteFile);
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [deleteTarget, setDeleteTargetState] = React.useState<PluginDeleteTarget | null>(null);
  const deleteOperation = React.useRef<symbol | null>(null);
  const setDeleteTarget = React.useCallback((target: PluginDeleteTarget | null) => {
    if (!ownsVisit()) return;
    deleteOperation.current = null;
    setIsDeleting(false);
    setDeleteTargetState(target);
  }, [ownsVisit]);
  const [isDeleting, setIsDeleting] = React.useState(false);

  React.useEffect(() => {
    const handleOpenAdd = () => setIsAddOpen(true);
    window.addEventListener('openchamber:settings-open-plugin-add', handleOpenAdd);
    return () => window.removeEventListener('openchamber:settings-open-plugin-add', handleOpenAdd);
  }, []);

  // The page opens on the plugin grid; leaving it drops the selection so the
  // next visit starts there again.
  React.useEffect(() => {
    const owns = capturePluginsOwner();
    return () => { if (owns()) usePluginsStore.getState().setSelected(null); };
  }, [scope]);
  React.useEffect(() => {
    deleteOperation.current = null;
    setIsDeleting(false);
    setDeleteTargetState(null);
    return () => { deleteOperation.current = null; };
  }, [scope]);
  React.useEffect(() => usePluginsStore.subscribe((state, previous) => {
    if ((state.selectedId !== previous.selectedId && state.selectedId !== null)
      || (state.draft !== previous.draft && state.draft !== null && JSON.stringify(state.draft) !== JSON.stringify(previous.draft))) {
      deleteOperation.current = null;
      setIsDeleting(false);
      setDeleteTargetState(null);
    }
  }), []);

  const selectedEntry = React.useMemo(
    () => (selectedId ? entries.find((e) => e.id === selectedId) ?? null : null),
    [entries, selectedId],
  );
  const selectedFile = React.useMemo(
    () => (selectedId ? files.find((f) => f.id === selectedId) ?? null : null),
    [files, selectedId],
  );

  const selectedEntryTarget = React.useMemo(
    () => (selectedEntry ? configEntryRuntimeTarget(selectedEntry.spec, selectedEntry.sourcePath) : null),
    [selectedEntry],
  );
  const selectedFileTarget = React.useMemo(
    () => (selectedFile ? pluginFileRuntimeTarget(selectedFile.absolutePath) : null),
    [selectedFile],
  );

  const [isLoadingFile, setIsLoadingFile] = React.useState(false);
  const hydratedDraft = React.useRef<{ id: string; directory: string | null; value: PluginDraft; owns: () => boolean } | null>(null);
  const [modelOwner, setModelOwner] = React.useState<(() => boolean) | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!ownsVisit()) return;
    if (!catalogIsCurrent) {
      hydratedDraft.current = null;
      setDraft(null);
      return;
    }
    const hydrate = (id: string, value: PluginDraft) => {
      if (!ownsVisit() || usePluginsStore.getState().selectedId !== id) return;
      const previous = hydratedDraft.current;
      const current = usePluginsStore.getState().draft;
      const dirty = previous?.owns() && previous.id === id && previous.directory === configDirectory && current !== null && (
        current.spec !== previous.value.spec
        || !optionsEqual(current.optionsJson, previous.value.optionsJson)
        || current.content !== previous.value.content
      );
      hydratedDraft.current = { id, directory: configDirectory, value, owns: ownsVisit };
      if (!dirty) setDraft(value);
      setModelOwner(() => ownsVisit);
    };

    if (selectedEntry) {
      hydrate(selectedEntry.id, buildEntryDraft(selectedEntry));
      return () => {
        cancelled = true;
      };
    }

    if (selectedFile) {
      const hasBaseline = hydratedDraft.current?.owns() && hydratedDraft.current.id === selectedFile.id;
      setIsLoadingFile(!hasBaseline);
      if (!hasBaseline) setDraft(null);
      void (async () => {
        const result = await readFile(selectedFile.id);
        if (cancelled || !ownsVisit()) return;
        setIsLoadingFile(false);
        if (!result) return;
        hydrate(selectedFile.id, buildFileDraft(selectedFile, result.content));
      })();
      return () => {
        cancelled = true;
      };
    }

    hydratedDraft.current = null;
    setDraft(null);
    return () => {
      cancelled = true;
    };
  }, [selectedEntry, selectedFile, readFile, setDraft, catalogIsCurrent, configDirectory, ownsVisit, visit]);

  // One routine for both shapes the page edits: a registry entry (spec +
  // options) and a plugin file (its contents). Text fields commit on blur, so
  // this runs with whatever the draft holds at that moment.
  const save = React.useCallback(async (): Promise<AutosaveResult> => {
    if (!ownsVisit() || !modelOwner?.() || hydratedDraft.current?.owns !== modelOwner
      || !draft || !catalogIsCurrent) return AUTOSAVE_UNCHANGED;

    if (selectedEntry && draft.mode === 'entry') {
      const spec = draft.spec.trim();
      const unchanged = spec === selectedEntry.spec
        && optionsEqual(draft.optionsJson, stringifyOptions(selectedEntry.options));
      if (unchanged) return AUTOSAVE_UNCHANGED;
      if (!spec) return autosaveFailed(t('settings.plugins.validation.specRequired'));
      const options = parseOptionsJson(draft.optionsJson);
      if (!options.ok) return autosaveFailed(t('settings.plugins.page.field.options.invalidJson'));

      const result = await updateEntry(selectedEntry.id, { spec, options: options.value });
      if (!ownsVisit() || !modelOwner()) return AUTOSAVE_UNCHANGED;
      if (result.invalidSpec) return autosaveFailed(t('settings.plugins.validation.specUnloadable'));
      if (!result.ok) {
        return autosaveFailed(result.message || t('settings.plugins.toast.reloadFailed'));
      }
      if (result.reloadFailed) {
        return autosaveFailed(result.warning || result.message || t('settings.plugins.toast.reloadFailed'));
      }
      return AUTOSAVE_SAVED;
    }

    if (selectedFile && draft.mode === 'file') {
      const originalContent = hydratedDraft.current.value.content;
      if (draft.content === originalContent) return AUTOSAVE_UNCHANGED;

      const result = await updateFile(selectedFile.id, { content: draft.content });
      if (!ownsVisit() || !modelOwner()) return AUTOSAVE_UNCHANGED;
      if (!result.ok) {
        return autosaveFailed(result.message || t('settings.plugins.toast.reloadFailed'));
      }
      const baseline = hydratedDraft.current;
      if (baseline?.owns === modelOwner) baseline.value = { ...baseline.value, content: draft.content };
      if (result.reloadFailed) {
        return autosaveFailed(result.warning || result.message || t('settings.plugins.toast.reloadFailed'));
      }
      return AUTOSAVE_SAVED;
    }

    return AUTOSAVE_UNCHANGED;
  }, [draft, selectedEntry, selectedFile, t, updateEntry, updateFile, catalogIsCurrent, modelOwner, ownsVisit]);

  const autosave = useAutosave(save);

  const handleDelete = async () => {
    if (!deleteTarget || !ownsVisit()) return;
    const operation = Symbol();
    deleteOperation.current = operation;
    const ownsDelete = () => ownsScope() && deleteOperation.current === operation;
    setIsDeleting(true);
    try {
      const result = deleteTarget.kind === 'entry' ? await deleteEntry(deleteTarget.id) : await deleteFile(deleteTarget.id);
      if (!ownsDelete()) return;
      if (result.ok) toast.success(result.message || t('settings.plugins.sidebar.toast.deleted', { name: deleteTarget.label }));
      else toast.error(t('settings.plugins.sidebar.toast.deleteFailed'));
      setDeleteTargetState(null);
    } finally {
      if (ownsDelete()) {
        deleteOperation.current = null;
        setIsDeleting(false);
      }
    }
  };

  const dialogs = (
    <>
      <AddPluginDialog open={isAddOpen} onOpenChange={setIsAddOpen} />
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.plugins.sidebar.deleteDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.plugins.sidebar.deleteDialog.description', { name: deleteTarget?.label ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void handleDelete()} disabled={isDeleting}>
              {isDeleting ? t('settings.plugins.sidebar.actions.deleting') : t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (!selectedId) {
    return (
      <>
        <PluginsGrid onAdd={() => setIsAddOpen(true)} onDelete={setDeleteTarget} />
        {dialogs}
      </>
    );
  }

  const backButton = <SettingsBackButton label={t('settings.plugins.page.back')} onClick={() => { if (ownsVisit()) setSelected(null); }} />;
  const deleteButton = (
    <Button variant="ghost" size="xs" className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]" onClick={() => {
      if (selectedEntry) setDeleteTarget({ kind: 'entry', id: selectedEntry.id, label: selectedEntry.spec });
      else if (selectedFile) setDeleteTarget({ kind: 'file', id: selectedFile.id, label: selectedFile.fileName });
    }}>
      <Icon name="delete-bin" className="size-3.5" />
      {t('settings.common.actions.delete')}
    </Button>
  );

  if (selectedEntry && draft && draft.mode === 'entry') {
    const optionsResult = parseOptionsJson(draft.optionsJson);
    const optionsValid = optionsResult.ok;

    return (
      <>
      <SettingsPageLayout
        title={t('settings.plugins.page.header.entry')}
        titleLeading={backButton}
        headerEnd={deleteButton}
        titleAccessory={(
          <ScopeBadge
            scope={selectedEntry.scope}
            label={
              selectedEntry.scope === 'project'
                ? t('settings.plugins.sidebar.group.projectEntries')
                : t('settings.plugins.sidebar.group.userEntries')
            }
          />
        )}
        onBlurCapture={autosave.onBlurCapture}
      >
        <SettingsSection divider={false}>
          <div className="flex flex-col gap-3">
            <PluginStatusBanner target={selectedEntryTarget} name={selectedEntry.spec} />
            <RegistryBanner entryId={selectedEntry.id} spec={selectedEntry.spec} />
          </div>
        </SettingsSection>

        <SettingsSection
          title={t('settings.plugins.page.field.spec')}
          settingsItem="plugins.spec"
        >
          <Input
            value={draft.spec}
            onChange={(e) => {
              if (ownsVisit() && modelOwner?.()) setDraft({ ...draft, spec: e.target.value });
            }}
            placeholder={t('settings.plugins.page.field.spec.placeholder')}
            className="font-mono typography-meta"
            spellCheck={false}
          />
        </SettingsSection>

        <SettingsSection
          title={t('settings.plugins.page.field.options')}
          settingsItem="plugins.options"
        >
          <Textarea
            value={draft.optionsJson}
            onChange={(e) => {
              if (ownsVisit() && modelOwner?.()) setDraft({ ...draft, optionsJson: e.target.value });
            }}
            rows={10}
            className={cn(
              'font-mono typography-meta min-h-[200px]',
              !optionsValid && 'border-[var(--status-error-border)]',
            )}
            spellCheck={false}
            placeholder='{ }'
          />
          {!optionsValid && (
            <p className="typography-micro text-[var(--status-error)]">
              {t('settings.plugins.page.field.options.invalidJson')}
            </p>
          )}
        </SettingsSection>
      </SettingsPageLayout>
      {dialogs}
      </>
    );
  }

  if (selectedFile && draft && draft.mode === 'file') {
    return (
      <>
      <SettingsPageLayout
        title={t('settings.plugins.page.header.file')}
        titleLeading={backButton}
        headerEnd={deleteButton}
        titleAccessory={(
          <>
            <ScopeBadge
              scope={selectedFile.scope}
              label={
                selectedFile.scope === 'project'
                  ? t('settings.plugins.sidebar.group.projectFiles')
                  : t('settings.plugins.sidebar.group.userFiles')
              }
            />
            <span
              className={cn(
                'typography-micro font-mono rounded-full px-2 py-0.5',
                'bg-[var(--surface-elevated)] text-foreground',
                'border border-[var(--interactive-border)]',
              )}
            >
              {selectedFile.fileName}
            </span>
          </>
        )}
        onBlurCapture={autosave.onBlurCapture}
      >
        <SettingsSection divider={false}>
          <PluginStatusBanner target={selectedFileTarget} name={selectedFile.fileName} />
        </SettingsSection>

        <SettingsSection
          title={t('settings.plugins.page.field.content')}
          settingsItem="plugins.content"
        >
          <Textarea
            value={draft.content}
            onChange={(e) => {
              if (ownsVisit() && modelOwner?.()) setDraft({ ...draft, content: e.target.value });
            }}
            onKeyDown={(event) => {
              // The file editor is long enough that leaving the field to save
              // is a chore; the usual shortcut writes it where you are.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                autosave.requestSave();
              }
            }}
            rows={16}
            className="font-mono typography-meta min-h-[320px]"
            spellCheck={false}
            disabled={isLoadingFile}
          />
        </SettingsSection>
      </SettingsPageLayout>
      {dialogs}
      </>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center text-muted-foreground">
        <Icon name="loader-4" className="mx-auto mb-3 h-6 w-6 animate-spin opacity-50" />
      </div>
    </div>
  );
};
