type TargetObserverOptions = {
  document: Document;
  itemId: string;
  onReady: () => void;
  onUnavailable: (reason: 'not-found' | 'hidden') => void;
  timeoutMs?: number;
  scroll?: boolean;
};

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const view = element.ownerDocument.defaultView;
  let current: HTMLElement | null = element;
  while (view && current) {
    const style = view.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    current = current.parentElement;
  }
  return element.getClientRects().length > 0;
}

/** Observe one registered settings anchor only while an explicit guide is active. */
export function observeGuidanceTarget(options: TargetObserverOptions): () => void {
  const { document, itemId, onReady, onUnavailable } = options;
  const view = document.defaultView;
  if (!view || !document.body) {
    onUnavailable('not-found');
    return () => {};
  }
  const windowRef = view;
  let target: HTMLElement | null = null;
  let stopped = false;
  let scheduled: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const clearTarget = () => {
    target?.removeAttribute('data-product-help-highlight');
    target = null;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    view.removeEventListener('resize', schedule);
    document.removeEventListener('transitionend', schedule, true);
    if (scheduled !== null) view.cancelAnimationFrame(scheduled);
    if (timeout !== null) clearTimeout(timeout);
    clearTarget();
  };
  const fail = (reason: 'not-found' | 'hidden') => {
    stop();
    onUnavailable(reason);
  };
  const mutationAttributes = ['hidden', 'inert', 'aria-hidden', 'style', 'class', 'data-starting-style', 'data-ending-style'];
  const observeLoading = () => {
    observer.disconnect();
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: mutationAttributes });
  };
  const observeAncestors = (element: HTMLElement) => {
    observer.disconnect();
    let ancestor: HTMLElement | null = element;
    while (ancestor) {
      observer.observe(ancestor, { childList: true, attributes: true, attributeFilter: mutationAttributes });
      ancestor = ancestor.parentElement;
    }
  };
  const findVisible = (id: string) => {
    const escaped = windowRef.CSS?.escape ? windowRef.CSS.escape(id) : id.replace(/[^a-zA-Z0-9_.-]/g, '');
    const candidates = document.querySelectorAll<HTMLElement>(`[data-settings-item="${escaped}"]`);
    return Array.from(candidates).find(isVisible) ?? null;
  };
  const inspect = () => {
    scheduled = null;
    if (stopped) return;
    if (target && isVisible(target)) return;
    const candidate = findVisible(itemId);
    if (target && candidate !== target) {
      if (candidate) {
        // A render replaced the same registered anchor. Keep its step and
        // attach to the replacement without changing navigation or form state.
        clearTarget();
      } else {
        fail('hidden');
        return;
      }
    }
    if (!target && candidate) {
      target = candidate;
      if (timeout !== null) clearTimeout(timeout);
      timeout = null;
      if (options.scroll !== false) candidate.scrollIntoView({ block: 'center', behavior: 'instant' });
      candidate.setAttribute('data-product-help-highlight', 'true');
      observeAncestors(candidate);
      onReady();
    }
  };
  function schedule() {
    if (!stopped && scheduled === null) scheduled = windowRef.requestAnimationFrame(inspect);
  }
  const observer = new MutationObserver(schedule);
  observeLoading();
  view.addEventListener('resize', schedule);
  document.addEventListener('transitionend', schedule, true);
  timeout = setTimeout(() => fail('not-found'), options.timeoutMs ?? 8000);
  inspect();
  return stop;
}
