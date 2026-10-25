import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { SettingsView } from './SettingsView';
import { ProductHelpPanel } from '@/components/product-help/ProductHelpPanel';
import { useProductHelpGuidanceStore } from '@/lib/product-help/guidance-store';

interface SettingsWindowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Settings rendered as a centered window with blurred backdrop.
 * Used for desktop and web (non-mobile) environments.
 */
export const SettingsWindow: React.FC<SettingsWindowProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const hasGuide = useProductHelpGuidanceStore((state) => state.session !== null);
  const [assistantAttached, setAssistantAttached] = React.useState(false);
  const showAssistant = hasGuide || (open && assistantAttached);
  React.useEffect(() => {
    if (!open) setAssistantAttached(false);
    else if (hasGuide) setAssistantAttached(true);
  }, [open, hasGuide]);
  const descriptionId = React.useId();
  const popupRef = React.useRef<HTMLDivElement>(null);
  const focusSettingsSearch = React.useCallback(() => {
    const popup = popupRef.current;
    return popup?.querySelector<HTMLElement>('[data-settings-search]') ?? popup ?? true;
  }, []);

  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return false;
    }

    return Boolean(
      document.querySelector('[data-slot="dropdown-menu-content"][data-open], [data-slot="select-content"][data-open]')
    );
  }, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && hasOpenFloatingMenu()) return;
        if (!next) useProductHelpGuidanceStore.getState().stop();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            'oc-glass-backdrop fixed inset-0 z-50 bg-black/25 dark:bg-black/40',
            'transition-opacity duration-150 ease-out',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <Dialog.Popup
            ref={popupRef}
            aria-describedby={descriptionId}
            // Open straight into the settings search, so typing filters at
            // once; the window itself if the field is not there.
            initialFocus={focusSettingsSearch}
            className={cn(
              'relative pointer-events-auto outline-none @container/settings-window',
              'w-[90vw] max-w-[1200px] h-[85vh] max-h-[900px]',
              'oc-window-corners border oc-modal-shadow overflow-hidden origin-center',
              'bg-background',
              'transition-all duration-150 ease-out',
              'data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]',
              'data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]',
              // Dim this window when a nested dialog (e.g. "Add a device") opens
              // on top of it, mirroring how the page behind a dialog is dimmed.
              'data-[nested-dialog-open]:brightness-[0.55] dark:data-[nested-dialog-open]:brightness-[0.4]',
            )}
          >
            <Dialog.Description id={descriptionId} className="sr-only">
              {t('settings.window.description')}
            </Dialog.Description>
            <div className={cn('flex h-full min-h-0', showAssistant && 'flex-col @5xl/settings-window:flex-row')}>
              <div className="min-h-0 min-w-0 flex-1">
                <SettingsView onClose={() => { useProductHelpGuidanceStore.getState().stop(); onOpenChange(false); }} isWindowed />
              </div>
              {showAssistant && <div className="h-64 max-h-[45%] min-h-0 shrink-0 bg-surface-muted @5xl/settings-window:h-full @5xl/settings-window:max-h-none @5xl/settings-window:w-80">
                <ProductHelpPanel visible={open} embedded />
              </div>}
            </div>
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
