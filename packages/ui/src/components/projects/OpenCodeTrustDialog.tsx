import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { folderTrust } from '@/lib/opencodeTrust';

export const OpenCodeTrustDialog: React.FC = () => {
  const { t } = useI18n();
  const prompt = React.useSyncExternalStore(folderTrust.subscribe, folderTrust.getPrompt, folderTrust.getPrompt);
  const [saving, setSaving] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setSaving(false);
    setFailed(false);
  }, [prompt]);
  const trust = async () => {
    if (!prompt || saving) return;
    setSaving(true);
    setFailed(false);
    const accepted = await prompt.trust();
    if (folderTrust.getPrompt() === prompt) {
      setSaving(false);
      setFailed(!accepted);
    }
  };
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => { if (!open && !saving) prompt?.decline(); }}>
      <DialogContent layerClassName="z-[70]" backdropProps={{ className: 'z-[70]' }}>
        <DialogHeader>
          <DialogTitle>{t('projects.openCodeTrust.title')}</DialogTitle>
          <DialogDescription>{t('projects.openCodeTrust.description')}</DialogDescription>
        </DialogHeader>
        <p dir="auto" className="oc-ui-start-align break-all typography-meta text-muted-foreground">{prompt?.assessment.directory}</p>
        <ul className="max-h-[45vh] space-y-2 overflow-auto rounded-lg bg-[var(--surface-muted)] p-3">
          {prompt?.assessment.items.map((item, index) => (
            <li key={item.source + ':' + index} className="space-y-0.5">
              <p className="typography-ui-label">{t(`projects.openCodeTrust.item.${item.kind}`)}{item.name ? ' · ' + item.name : null}</p>
              {item.detail ? <p dir="auto" className="oc-ui-start-align break-all font-mono typography-meta">{item.detail}</p> : null}
              <p dir="auto" className="oc-ui-start-align break-all typography-meta text-muted-foreground">{item.source}</p>
            </li>
          ))}
        </ul>
        {failed ? <p role="alert" className="typography-meta text-destructive">{t('projects.openCodeTrust.saveFailed')}</p> : null}
        <DialogFooter>
          <Button autoFocus variant="ghost" disabled={saving} onClick={() => prompt?.decline()}>{t('projects.sharedTrust.skip')}</Button>
          <Button disabled={saving} onClick={() => void trust()}>{t('projects.openCodeTrust.allow')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
