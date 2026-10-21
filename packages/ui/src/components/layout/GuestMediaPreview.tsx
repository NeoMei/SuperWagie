import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { useGuestPreviewStore } from '@/stores/useGuestPreviewStore';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);
const FRAME = new Set(['html', 'htm', 'pdf']);

const extensionOf = (path: string): string => {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/**
 * Shows a project file a guest page asked for. The host resolves the file
 * itself; the overlay sits above the page, and closing it returns to the same
 * stage the user was reading.
 */
export const GuestMediaPreview: React.FC = () => {
  const preview = useGuestPreviewStore((state) => state.preview);
  const close = useGuestPreviewStore((state) => state.close);

  React.useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, close]);

  if (!preview) return null;

  const extension = extensionOf(preview.path);
  const src = getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
    path: preview.path,
    directory: preview.directory ?? undefined,
  });
  const name = preview.path.split('/').pop() ?? preview.path;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${name}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-3 text-white">
        <span className="truncate text-sm font-medium">{name}</span>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/25 px-3 py-1.5 text-sm hover:bg-white/10"
          onClick={close}
        >
          <Icon name="close" className="size-4" />
          关闭
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {IMAGE.has(extension) ? (
          <img src={src} alt={name} className="max-h-full max-w-full object-contain" />
        ) : VIDEO.has(extension) ? (
          <video src={src} controls className="max-h-full max-w-full" />
        ) : FRAME.has(extension) ? (
          <iframe
            src={src}
            title={name}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="h-full w-full rounded-md border-0 bg-white"
          />
        ) : (
          <p className="text-sm text-white/80">这个文件不能在页面里预览，去项目文件列表里打开。</p>
        )}
      </div>
    </div>
  );
};
