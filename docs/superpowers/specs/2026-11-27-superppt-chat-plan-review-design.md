# SuperPPT chat plan review

## Intent

SuperWagie users review slide content and choose a complete style in the conversation. Other agents retain the standalone HTML and text flow when they do not declare support for SuperWagie reply blocks.

## Decisions

- Upgrade the bundled official snapshot from SuperPPT v0.3.6 to v0.3.8. Preserve the existing managed launchers, encoded local Markdown links, offline editable-PPTX boundary, decision validation and replay-safe jobs.
- SuperWagie launchers set `SUPERPPT_CHAT_INTERACTIONS=1`. CLI execution without that declaration uses the portable HTML/text flow.
- A supported `plan-review` reply first offers overall changes, selected slide changes, or unchanged content. Slide choices send another message naming the slide. The agent then shows only the requested slide's content and comment input, with a submit button carrying the current revision and decision identity.
- The same review offers all style images. Each press selects one style and sends that choice. The agent shows all of that style's exact tier and palette previews as one image-choice grid.
- A variant press supplies the exact style ID, tier, palette ID, current revision and decision ID. The UI text states that confirming the variant authorizes one sample image request. It also identifies the saved prompt snapshot, reference purpose, output and one-call budget.
- The agent renders returned blocks unchanged, validates the reply identity and variant against the current `review-model.json`, and invokes `decide` with `select-style-and-generate-sample`. No new runtime API, dependency, persisted task state or direct browser submission is added.
- Existing HTML generation and recovery remain available. Unsupported hosts retain their current text and local HTML choices. A supported chat may keep an HTML link as an optional detailed review.

## Runtime behavior

| Runtime | Behavior |
| --- | --- |
| Web | Uses the shared OpenUI reply blocks on the connected SuperWagie server. |
| Electron | Uses the same shared reply blocks and managed launcher. |
| VS Code | Uses the same shared reply blocks through the connected runtime. |
| Hosted mobile | Uses the shared reply blocks; image and text fallback remain available. |
| Capacitor mobile | Uses the shared reply blocks; image and text fallback remain available. |
| Other agents | Use HTML and ordinary text when the chat capability is not declared. |

## Failure behavior

Reply delivery retains the existing retry and history behavior. Stale or changed revision/decision identities remain rejected. No style click creates a job before the current `decide` transaction. Remote image failures leave text choices usable. Official v0.3.8 dependency updates are confined to the vendored component's existing package and lockfile.
