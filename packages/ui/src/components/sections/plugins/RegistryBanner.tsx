import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { usePluginsStore, type PluginEntry } from '@/stores/usePluginsStore';

import { usePluginOperationOwner } from './usePluginOperationOwner';

interface RegistryBannerProps {
  entryId: string;
  spec: string;
}

type PinUpdateOperation = {
  entry: PluginEntry;
  nextSpec: string;
  catalogSpec: string;
  owns: () => boolean;
};

export const RegistryBanner: React.FC<RegistryBannerProps> = ({ entryId, spec }) => {
  const { t } = useI18n();
  const { visit, ownsVisit } = usePluginOperationOwner(entryId);
  const operationRef = React.useRef<PinUpdateOperation | null>(null);
  const binding = React.useRef({ entryId, spec });
  if (binding.current.entryId !== entryId || binding.current.spec !== spec) {
    const operation = operationRef.current;
    const entry = usePluginsStore.getState().entries.find((item) => item.id === entryId);
    // The accepted pin's catalog echo changes this banner before its promise returns.
    const ownEcho = operation && operation.owns()
      && binding.current.entryId === entryId && binding.current.spec === operation.entry.spec
      && spec === operation.nextSpec && entry?.spec === operation.nextSpec
      && entry.scope === operation.entry.scope && entry.sourcePath === operation.entry.sourcePath
      && entry.parsedKind === operation.entry.parsedKind;
    if (ownEcho) operation.catalogSpec = spec;
    else operationRef.current = null;
    binding.current = { entryId, spec };
  }
  const info = usePluginsStore((s) => s.registryInfo[spec]);
  const updateToLatest = usePluginsStore((s) => s.updateToLatest);

  const [isUpdating, setIsUpdating] = React.useState(false);
  React.useLayoutEffect(() => usePluginsStore.subscribe((state, previous) => {
    const operation = operationRef.current;
    if (!operation || state.entries === previous.entries) return;
    const entry = state.entries.find((item) => item.id === operation.entry.id);
    const expectedTransition = operation.catalogSpec === operation.entry.spec && entry?.spec === operation.nextSpec;
    if (!operation.owns() || !entry || entry.scope !== operation.entry.scope || entry.sourcePath !== operation.entry.sourcePath
      || entry.parsedKind !== operation.entry.parsedKind
      || (entry.spec !== operation.catalogSpec && !expectedTransition)) {
      operationRef.current = null;
      setIsUpdating(false);
      return;
    }
    if (entry.spec !== operation.catalogSpec) {
      operation.catalogSpec = entry.spec;
    }
  }), []);
  React.useEffect(() => {
    operationRef.current = null;
    setIsUpdating(false);
    return () => { operationRef.current = null; };
  }, [visit, entryId]);
  React.useEffect(() => {
    if (!operationRef.current) setIsUpdating(false);
  }, [spec]);

  if (!info) return null;

  if (info.kind === 'npm-ok') {
    if (!info.hasUpdate || !info.latestVersion) return null;

    const latest = info.latestVersion;
    const current = info.currentVersion ?? '';

    const handleUpdate = async () => {
      if (!ownsVisit() || binding.current.spec !== spec) return;
      const entry = usePluginsStore.getState().entries.find((item) => item.id === entryId);
      if (!entry || entry.spec !== spec) return;
      const operation: PinUpdateOperation = { entry, nextSpec: `${info.name}@${latest}`, catalogSpec: spec, owns: ownsVisit };
      operationRef.current = operation;
      const ownsUpdate = () => operation.owns() && operationRef.current === operation;
      setIsUpdating(true);
      try {
        const result = await updateToLatest(entryId);
        if (!ownsUpdate()) return;
        if (result.ok) {
          toast.success(
            t('settings.plugins.toast.updatedToLatest', { version: latest }),
          );
        } else if (operation.catalogSpec === operation.entry.spec) {
          toast.error(t('settings.plugins.toast.refreshFailed'));
        }
      } finally {
        if (ownsUpdate()) { operationRef.current = null; setIsUpdating(false); }
      }
    };

    return (
      <div className="oc-tile rounded-md p-3 flex items-start gap-3">
        <Icon
          name="arrow-up"
          className="h-5 w-5 text-[var(--status-success)] shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <p className="typography-label text-[var(--status-success)]">
            {t('settings.plugins.registry.banner.updateAvailable.title')}
          </p>
          <p className="typography-micro text-muted-foreground mt-0.5">
            {t('settings.plugins.registry.banner.updateAvailable.description', {
              current,
              latest,
            })}
          </p>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => void handleUpdate()}
          disabled={isUpdating}
        >
          {t('settings.plugins.registry.banner.updateAvailable.action', { latest })}
        </Button>
      </div>
    );
  }

  if (info.kind === 'path-ok') return null;
  if (info.kind === 'git-ok') return null;

  if (info.kind === 'npm-network') {
    return (
      <div className="oc-tile rounded-md p-3 flex items-start gap-3">
        <Icon
          name="cloud-off"
          className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <p className="typography-micro text-muted-foreground">
            {t('settings.plugins.registry.badge.network.tooltip')}
          </p>
        </div>
      </div>
    );
  }

  const isWarning = info.kind === 'path-unreadable';
  const colorVar = isWarning ? 'var(--status-warning)' : 'var(--status-error)';
  const iconName = isWarning ? 'alert' : 'error-warning';

  const description = (() => {
    switch (info.kind) {
      case 'npm-missing-version':
        return t('settings.plugins.registry.banner.invalid.missingVersion');
      case 'npm-missing-package':
        return t('settings.plugins.registry.banner.invalid.missingPackage');
      case 'npm-malformed':
        return t('settings.plugins.registry.banner.invalid.malformed');
      case 'path-missing':
        return t('settings.plugins.registry.banner.invalid.pathMissing');
      case 'path-unreadable':
        return t('settings.plugins.registry.banner.invalid.pathUnreadable');
    }
  })();

  return (
    <div className="oc-tile rounded-md p-3 flex items-start gap-3">
      <Icon
        name={iconName}
        className="h-5 w-5 shrink-0 mt-0.5"
        style={{ color: colorVar }}
      />
      <div className="flex-1 min-w-0">
        <p className="typography-label" style={{ color: colorVar }}>
          {t('settings.plugins.registry.banner.invalid.title')}
        </p>
        <p className="typography-micro text-muted-foreground mt-0.5">
          {description}
        </p>
      </div>
    </div>
  );
};
