# Shared UI primitives

## Ownership

This folder owns runtime-independent controls and their Base UI integration, including dropdown focus and dismissal. Feature-specific model filtering belongs to `components/model-picker`.

## Invariants

- A root dropdown opened by keyboard or controlled state stays open when the pointer leaves its popup. Hover dismissal applies only to a dropdown opened by trigger hover.
- Escape, outside presses, item selection, and window blur retain their normal dismissal behavior. Submenu hover behavior stays with Base UI.
- Each opening has its own hover-dismissal eligibility; closing clears it.
- `Textarea` forwards its ref to the textarea element itself.
- The About dialog exposes its version area as a product-help target and embeds
  guide controls inside the modal when an update guide is active. It never
  starts an update check merely because a guide opened it.
- The desktop About dialog reads update progress from `useUpdateStore`. Its check button stays disabled and shows a spinner with the checking label while that state is active. The existing menu event owns the request and its result toast.

## Decisions

### Why hover dismissal follows the opening reason

Base UI 1.4 has no opening DOM event when a caller changes the controlled `open` prop, so it treats that popup as hover-dismissible. Filtering can shrink it away from a stationary pointer and close it during typing. The shared dropdown root cancels that hover close unless a trigger-hover event opened the menu, preserving explicit hover menus without caller-specific workarounds.

### Why update button labels share a grid cell

Both idle and checking labels reserve their width, with only the active label visible and exposed to accessibility APIs. The icon has a fixed slot, so starting a check cannot resize the button.
