# Product help guidance

## Ownership

The guidance registry maps product-help targets to Settings search anchors.
The store owns the current task step; the global highlight component observes
the rendered target. The assistant panel owns explanations and controls.
Settings owns all field values, saves and connection tests.

## Task and location contracts

- `models` location opens the overview. Its guide configures and tests one
  provider connection: choose a preset or existing connection, save connection
  details, then test the chosen model and purpose. It does not create a purpose
  binding. Completion explicitly describes that remaining setup.
- `appearance` guides changing the interface language: open the picker, then
  choose a different language and confirm the persisted value by reading it back.
- `theme`, `knowledge`, and `shortcuts` are locations only. An unsupported guide
  request for these targets is downgraded to a location, never simulated completion.

## Invariants

- A model response selects a registered target, never a selector, script or coordinate.
- Navigation changes pages and tabs only. Guidance never reads input values,
  saves settings, enters credentials or invokes connection tests.
- A visible anchor means ready for an action, not that the action succeeded.
  There is no Next button that can declare an operation complete.
- Owning controls call `beginGuidanceAction` before a real user operation, then
  `reportGuidanceAction` after its authoritative result. Tokens contain only the
  step request, action name and attempt number. An older attempt, stopped guide,
  changed runtime or different step cannot consume a late result.
- A saved connection selection or a chosen preset may satisfy the selection
  step from the rendered form state. Saving advances only after the response
  contains the saved connection; testing completes only from a verified result
  for the unchanged form. Failures stay on their step and permit an actual retry.
- Saving a connection during this guide stays on Connections even if the user
  previously opened that editor from a purpose. The public probe draft survives
  editor remounts. The guide never copies credentials or other form values.
- Automatic advancement changes only the highlight target. It does not repeat
  Settings navigation or reset a form. The second language step does not scroll,
  so opening the picker keeps it in place. Start, Back and Retry navigate.
- Lookup waits up to 8 seconds for asynchronous content. Missing, hidden or
  removed targets produce an unavailable state and clear the highlight.
- A replacement node for the same visible anchor keeps its step. After a step
  becomes unavailable, reappearance alone does not restart it; Retry does.
- One active guide has one observer. Stopped or completed guides leave no observer,
  timer or modified target attribute. Mutation events coalesce into one animation
  frame; steady highlights have no animation or polling. Once found, observation
  is restricted to the target and ancestors; unrelated document content does not
  trigger another anchor search.
- Runtime changes and closing Settings end the guide. Step state stays in memory.
- Web and Electron use the shared Settings window. Knowledge-library settings
  guidance requires Electron, matching that page's availability. VS Code,
  hosted-mobile and Capacitor guidance returns unsupported because their
  Settings navigation uses a separate document or shell.

## Highlight rendering

The highlight belongs to the real element and moves with scrolling, resizing
and translated layouts. A separate coordinate overlay would need continuous
geometry tracking and could cover or point outside the control.
