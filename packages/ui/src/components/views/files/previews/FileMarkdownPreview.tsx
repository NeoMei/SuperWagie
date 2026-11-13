import React from 'react';
import { getLoadedMarkdownRendererModule, loadMarkdownRendererModule } from '@/components/chat/markdownRendererLoader';
import type { SimpleMarkdownRendererProps } from '@/components/chat/MarkdownRendererImpl';
import { LazyFilePreview } from './LazyFilePreview';

type RendererLoader = () => Promise<{ default: React.ComponentType<SimpleMarkdownRendererProps> }>;
// File previews own manual recovery. The chat wrapper retains its application reload policy.
const loadFileMarkdown: RendererLoader = () => loadMarkdownRendererModule().then((module) => ({ default: module.SimpleMarkdownRenderer }));

export function FileMarkdownPreview({ loadRenderer = loadFileMarkdown, ...props }: SimpleMarkdownRendererProps & { loadRenderer?: RendererLoader }) {
  const loaded = loadRenderer === loadFileMarkdown ? getLoadedMarkdownRendererModule()?.SimpleMarkdownRenderer : undefined;
  return <LazyFilePreview load={loadRenderer} resolved={loaded} previewProps={props} />;
}
