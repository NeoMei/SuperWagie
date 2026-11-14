import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { passiveSvgImage } from './passiveSvg';

export function MarkdownSvg({ source, children }: { source: string; children: React.ReactNode }) {
  const { t } = useI18n();
  const image = React.useMemo(() => passiveSvgImage(source), [source]);
  const [showSource, setShowSource] = React.useState(false);
  if (!image) return children;
  return (
    <div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}>
          {t(showSource ? 'filesView.editor.switchToPreviewMode' : 'filesView.artifact.table.showSource')}
        </Button>
      </div>
      {showSource ? children : <img src={image} alt="" className="max-h-[80vh] max-w-full" />}
    </div>
  );
}
