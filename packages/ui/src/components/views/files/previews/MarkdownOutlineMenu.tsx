import React from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

type Heading = { element: HTMLHeadingElement; text: string; level: number };
/** Targets committed heading elements, including duplicate or non-Latin titles. */
export function MarkdownOutlineMenu({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [headings, setHeadings] = React.useState<Heading[]>([]);
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const next = Array.from(container.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6'))
        .map((element) => ({ element, text: element.textContent?.trim() ?? '', level: Number(element.tagName.slice(1)) }));
      setHeadings((previous) => previous.length === next.length && previous.every((heading, index) => (
        heading.element === next[index].element && heading.text === next[index].text
      )) ? previous : next);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [containerRef]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" title={t('filesView.markdown.outline')} aria-label={t('filesView.markdown.outline')}>
          <Icon name="list-unordered" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-80 max-w-80 overflow-auto">
        {headings.length === 0 ? <DropdownMenuItem disabled>{t('filesView.markdown.noHeadings')}</DropdownMenuItem> : headings.map((heading, index) => (
          <DropdownMenuItem key={index} onSelect={() => {
            if (containerRef.current?.contains(heading.element)) heading.element.scrollIntoView({ block: 'start' });
          }}>
            <span className="truncate" style={{ paddingInlineStart: (heading.level - 1) * 12 }}>{heading.text}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
