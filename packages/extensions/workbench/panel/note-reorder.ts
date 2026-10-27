interface NoteDrag {
  card: HTMLElement;
  handle: HTMLButtonElement;
  id: string;
  pointerId: number;
  delayed: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  scrollLeft: number;
  scrollTop: number;
  transform: string;
  pointerEvents: string;
  timer: number | null;
  dragging: boolean;
  target: HTMLElement | null;
}

export function installNoteReorder(list: HTMLElement, onMove: (activeId: string, targetId: string) => void): () => void {
  const document = list.ownerDocument;
  const view = document.defaultView;
  if (!view) return () => {};
  let drag: NoteDrag | null = null;

  const getHandle = (target: EventTarget | null): HTMLButtonElement | null => {
    if (!(target instanceof view.Element)) return null;
    const handle = target.closest<HTMLButtonElement>('button.note-drag');
    return handle && list.contains(handle) && !handle.disabled ? handle : null;
  };

  const getTarget = (active: NoteDrag): HTMLElement | null => {
    const bounds = list.getBoundingClientRect();
    const { x, y } = active;
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    const hit = document.elementFromPoint(x, y);
    if (hit && !list.contains(hit)) return null;
    const hitCard = hit?.closest<HTMLElement>('.note[data-note-id]');
    if (hitCard && hitCard !== active.card && list.contains(hitCard)) return hitCard;
    for (const card of list.querySelectorAll<HTMLElement>('.note[data-note-id]')) {
      if (card === active.card) continue;
      const rect = card.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return card;
    }
    return null;
  };

  const updateDrag = (): void => {
    const active = drag;
    if (!active?.dragging) return;
    const x = active.x - active.startX + list.scrollLeft - active.scrollLeft;
    const y = active.y - active.startY + list.scrollTop - active.scrollTop;
    active.card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    const target = getTarget(active);
    if (target === active.target) return;
    active.target?.classList.remove('is-drop-target');
    target?.classList.add('is-drop-target');
    active.target = target;
  };

  const cancel = (): void => {
    const active = drag;
    if (!active) return;
    drag = null;
    if (active.timer !== null) view.clearTimeout(active.timer);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    document.removeEventListener('lostpointercapture', onPointerCancel);
    document.removeEventListener('keydown', onEscape);
    list.removeEventListener('scroll', updateDrag);
    view.removeEventListener('blur', cancel);
    active.target?.classList.remove('is-drop-target');
    active.card.classList.remove('is-dragging');
    active.card.style.transform = active.transform;
    active.card.style.pointerEvents = active.pointerEvents;
    if (active.dragging) {
      try { active.handle.releasePointerCapture(active.pointerId); } catch { /* The pointer may already be released. */ }
    }
  };

  const activate = (): void => {
    const active = drag;
    if (!active) return;
    if (!list.isConnected || !list.contains(active.card)) { cancel(); return; }
    if (active.timer !== null) view.clearTimeout(active.timer);
    active.timer = null;
    active.dragging = true;
    active.card.classList.add('is-dragging');
    active.card.style.pointerEvents = 'none';
    try { active.handle.setPointerCapture(active.pointerId); } catch { /* Synthetic events have no native pointer to capture. */ }
    updateDrag();
  };

  function onPointerMove(event: PointerEvent): void {
    const active = drag;
    if (!active || event.pointerId !== active.pointerId) return;
    active.x = event.clientX;
    active.y = event.clientY;
    if (!active.dragging) {
      const distance = Math.hypot(active.x - active.startX, active.y - active.startY);
      if (active.delayed) {
        if (distance > 6) cancel();
        return;
      }
      if (distance < 8) return;
      activate();
    }
    event.preventDefault();
    updateDrag();
  }

  function onPointerUp(event: PointerEvent): void {
    const active = drag;
    if (!active || event.pointerId !== active.pointerId) return;
    active.x = event.clientX;
    active.y = event.clientY;
    const targetId = active.dragging ? getTarget(active)?.dataset.noteId : undefined;
    cancel();
    if (targetId && targetId !== active.id) onMove(active.id, targetId);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId === drag?.pointerId) cancel();
  }

  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancel();
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (drag || event.button !== 0 || !event.isPrimary) return;
    const handle = getHandle(event.target);
    const card = handle?.closest<HTMLElement>('.note[data-note-id]');
    const id = card?.dataset.noteId;
    if (!handle || !card || !id || !list.contains(card)) return;
    drag = {
      card, handle, id, pointerId: event.pointerId,
      delayed: event.pointerType === 'touch' || event.pointerType === 'pen',
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      scrollLeft: list.scrollLeft, scrollTop: list.scrollTop,
      transform: card.style.transform, pointerEvents: card.style.pointerEvents,
      timer: null, dragging: false, target: null,
    };
    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('lostpointercapture', onPointerCancel);
    document.addEventListener('keydown', onEscape);
    list.addEventListener('scroll', updateDrag);
    view.addEventListener('blur', cancel);
    if (drag.delayed) drag.timer = view.setTimeout(activate, 200);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (drag || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const handle = getHandle(event.target);
    const card = handle?.closest<HTMLElement>('.note[data-note-id]');
    if (!card?.dataset.noteId) return;
    const rtl = view.getComputedStyle(list).direction === 'rtl';
    let step: number;
    switch (event.key) {
      case 'ArrowUp': step = -1; break;
      case 'ArrowDown': step = 1; break;
      case 'ArrowLeft': step = rtl ? 1 : -1; break;
      case 'ArrowRight': step = rtl ? -1 : 1; break;
      default: return;
    }
    event.preventDefault();
    const cards = [...list.querySelectorAll<HTMLElement>('.note[data-note-id]')];
    const targetId = cards[cards.indexOf(card) + step]?.dataset.noteId;
    if (targetId && targetId !== card.dataset.noteId) onMove(card.dataset.noteId, targetId);
  };

  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('keydown', onKeyDown);
  return () => {
    cancel();
    list.removeEventListener('pointerdown', onPointerDown);
    list.removeEventListener('keydown', onKeyDown);
  };
}
