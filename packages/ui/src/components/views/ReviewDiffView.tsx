import React from 'react';
import type { FileDiffMetadata } from '@pierre/diffs';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useGitComparison, type GitComparisonSource } from '@/hooks/useGitComparison';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { fileWithDiffCommentOrigin, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { fileDiffFromPatch, isBinaryPatch } from '@/lib/diff/patchFileDiff';
import { parsePullRequestDiff } from '@/lib/diff/pullRequestDiff';
import { getGitRangeFiles } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useSourceControlProvider, useSourceControlProviderServing } from '@/lib/source-control/providers/registry';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useUIStore, type ReviewDiffRequest } from '@/stores/useUIStore';
import { PierreDiffViewer, type PierreDiffViewerHandle } from './PierreDiffViewer';
import { startReviewDiffLineJump } from './reviewDiffLineJump';

function comparisonFor(origin: DiffCommentOrigin | undefined, supportsRevisions: boolean): GitComparisonSource | null {
  if (!origin) return null;
  if (origin.kind === 'commit') return { kind: 'commit', hash: origin.hash };
  if (origin.kind === 'branch') return { kind: 'branch', baseRef: origin.baseRef, headRef: origin.headRef };
  const separator = origin.repository?.lastIndexOf('/') ?? -1;
  const sourceRepo = origin.repository && separator >= 0
    ? { owner: origin.repository.slice(0, separator), repo: origin.repository.slice(separator + 1) }
    : undefined;
  return {
    kind: 'pr',
    number: origin.number,
    ...(sourceRepo ? { sourceRepo } : {}),
    ...(supportsRevisions && origin.revision ? { revision: origin.revision } : {}),
  };
}

type DiffContent = { original: string; modified: string; fileDiff?: FileDiffMetadata; isBinary?: boolean };
type ReadOutcome =
  | { key: string; kind: 'ready'; content: DiffContent }
  | { key: string; kind: 'unavailable' }
  | { key: string; kind: 'error'; message: string };
type ReadResult = ReadOutcome & { request: ReviewDiffRequest };

const patchContent = (path: string, patch: string): DiffContent => {
  const isBinary = isBinaryPatch(patch);
  return { original: '', modified: '', isBinary, fileDiff: isBinary ? undefined : fileDiffFromPatch(path, patch) };
};

export function ReviewDiffView({ request, visible, onBack }: {
  request: ReviewDiffRequest;
  visible: boolean;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { git, sourceControl } = useRuntimeAPIs();
  const { destination, sourceDirectory } = request;
  const { line, side, origin, path, repositoryPath, staged } = destination;
  const { gitDirectory } = useNestedGitDirectory(repositoryPath ? null : sourceDirectory, { enabled: visible });
  const directory = repositoryPath ? toAbsoluteFilePath(sourceDirectory, repositoryPath) : gitDirectory;
  // A bound provider is the only authority for a recorded change request.
  const isChangeRequest = origin?.kind === 'change-request';
  const binding = useRepositoryBinding(isChangeRequest ? directory : null, sourceControl);
  const context = isChangeRequest
    ? binding.contexts.find((entry) => !origin.provider || entry.provider === origin.provider) ?? null
    : null;
  const serving = useSourceControlProviderServing(context?.provider);
  const descriptor = useSourceControlProvider(context?.provider);
  const supportsRevisions = descriptor.features.revisions;
  const source = React.useMemo(() => comparisonFor(origin, supportsRevisions), [origin, supportsRevisions]);
  // Providers without named revisions can only supply the patch still held by
  // their current context. Verify its head before accepting any file from it.
  const expectedHead = isChangeRequest && !supportsRevisions ? origin.revision : undefined;
  const comparisonEnabled = visible && (!isChangeRequest || (serving === 'served' && descriptor.features.changeRequestPatch));
  const comparison = useGitComparison(directory, expectedHead ? null : source, comparisonEnabled, '', context);
  const { fetchDiff, fetchFullFile } = comparison;
  const [attempt, setAttempt] = React.useState(0);
  const [result, setResult] = React.useState<ReadResult | null>(null);
  const readKey = JSON.stringify([directory, path, origin, staged, comparison.key, comparison.revision, attempt]);
  const settled = result?.request === request && result.key === readKey ? result : null;
  const unavailable = (isChangeRequest && binding.status === 'ready' && !context)
    || (isChangeRequest && serving === 'not-served' && context !== null)
    || (isChangeRequest && serving === 'served' && !descriptor.features.changeRequestPatch);

  React.useEffect(() => {
    if (!directory || !comparisonEnabled || unavailable || !request.isCurrentRuntime()) return;
    if (settled) return;
    let active = true;
    const publish = (next: ReadOutcome) => {
      if (active && request.isCurrentRuntime()) setResult({ ...next, request });
    };
    const read = async (): Promise<DiffContent | null> => {
      if (source?.kind === 'pr' && expectedHead) {
        if (!sourceControl || !context) return null;
        const current = await sourceControl.changeRequestContext(context, source.number, {
          includeDiff: true,
          project: source.sourceRepo && { owner: source.sourceRepo.owner, name: source.sourceRepo.repo },
        });
        if (current.changeRequest?.headSha?.toLowerCase() !== expectedHead.toLowerCase() || !current.diff) return null;
        const file = parsePullRequestDiff(current.diff).find((entry) => entry.path === path);
        return file ? patchContent(path, file.patch) : null;
      }
      if (source) {
        const file = comparison.files?.find((file) => file.path === path);
        if (!file || (origin?.kind === 'branch' && origin.revision && file.revision !== origin.revision)) return null;
        const { diff } = await fetchDiff(path, source.kind === 'pr' ? 3 : 1_000_000);
        // The range patch carries no revision. Check the same branch
        // and working-tree file again before publishing its rendered rows.
        if (source.kind === 'branch' && origin?.kind === 'branch' && origin.revision) {
          if (!active || !request.isCurrentRuntime()) return null;
          const after = await getGitRangeFiles(directory, {
            base: source.baseRef, head: source.headRef, includeWorkingTree: true,
          });
          if (after.find((entry) => entry.path === path)?.revision !== origin.revision) return null;
        }
        const content = patchContent(path, diff);
        if (source.kind === 'pr' && line && content.fileDiff?.isPartial && !content.fileDiff.hunks.some((hunk) => {
          const start = side === 'deletions' ? hunk.deletionStart : hunk.additionStart;
          const count = side === 'deletions' ? hunk.deletionCount : hunk.additionCount;
          return line >= start && line < start + count;
        })) return fetchFullFile(path);
        return content;
      }
      const file = await git.getGitFileDiff(directory, { path, staged });
      return { original: file.original, modified: file.modified, isBinary: file.isBinary || Boolean(file.submodule) };
    };
    if (source && !expectedHead && !comparison.files) return;
    void (async () => {
      try {
        const content = await read();
        publish(content ? { key: readKey, kind: 'ready', content } : { key: readKey, kind: 'unavailable' });
      } catch (error) {
        publish({ key: readKey, kind: 'error', message: error instanceof Error ? error.message : t('diffView.state.failedToLoadDiff') });
      }
    })();
    return () => { active = false; };
  }, [comparison.files, comparisonEnabled, context, directory, expectedHead, fetchDiff, fetchFullFile, git, line, origin, path, readKey, request, settled, side, source, sourceControl, staged, t, unavailable]);

  const viewer = React.useRef<PierreDiffViewerHandle | null>(null);
  const content = !unavailable && settled?.kind === 'ready' ? settled.content : null;
  const job = React.useRef<{ request: ReviewDiffRequest; content: DiffContent | null; finished: boolean } | null>(null);
  const [missingLineFor, setMissingLineFor] = React.useState<DiffContent | null>(null);
  React.useLayoutEffect(() => {
    if (job.current?.request !== request) job.current = { request, content: null, finished: false };
    const pending = job.current;
    if (!pending || pending.finished) return;
    if (pending.content && pending.content !== content) {
      pending.finished = true;
      return;
    }
    if (!visible || !content || content.isBinary || !line) return;
    pending.content = content;
    return startReviewDiffLineJump({
      lineNumber: line, side,
      scroll: (target) => {
        if (!request.isCurrentRuntime()) {
          pending.finished = true;
          return true;
        }
        pending.finished = viewer.current?.scrollToLine(target) === true;
        return pending.finished;
      },
      unavailable: () => {
        pending.finished = true;
        setMissingLineFor(content);
      },
    });
  }, [content, line, request, side, visible]);

  const wrapLines = useUIStore((state) => state.diffWrapLines);
  const bindingError = isChangeRequest && binding.status === 'error' ? binding.error : null;
  const error = bindingError?.message ?? comparison.error ?? (settled?.kind === 'error' ? settled.message : null);
  const title = fileWithDiffCommentOrigin(path, origin);
  const revisionLabel = isChangeRequest && origin.revision ? ` @${origin.revision.slice(0, 10)}` : '';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label={t('diffView.review.back')} title={t('diffView.review.back')}>
          <Icon name="arrow-left" className="size-4 rtl:rotate-180" />
        </Button>
        <span className="truncate typography-ui-label" dir="auto" title={title + revisionLabel}>{title + revisionLabel}</span>
      </div>
      {content ? (
        <>
          {missingLineFor === content ? <p role="status" className="px-3 py-2 typography-meta text-muted-foreground">{t('diffView.review.lineUnavailable')}</p> : null}
          {content.isBinary ? (
            <p className="p-3 typography-meta text-muted-foreground">{t('diffView.binary.unavailable')}</p>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <PierreDiffViewer
                ref={viewer}
                fileName={path}
                language={getLanguageFromExtension(path) || 'text'}
                original={content.original}
                modified={content.modified}
                fileDiff={content.fileDiff}
                enableComments={false}
                renderSideBySide={side === 'deletions'}
                wrapLines={wrapLines}
                layout="inline"
              />
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center typography-meta text-muted-foreground">
          {unavailable || settled?.kind === 'unavailable'
            ? <p>{t('diffView.review.unavailable')}</p>
            : error ? <>
              <p>{error}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => {
                if (bindingError) void binding.retry();
                else if (comparison.error) void comparison.refresh();
                else setAttempt((value) => value + 1);
              }}>{t('diffView.actions.retry')}</Button>
            </> : <p role="status">{t('diffView.state.loadingDiff')}</p>}
        </div>
      )}
    </div>
  );
}
