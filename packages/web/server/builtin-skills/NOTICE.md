# Bundled skills

These skills ship with SuperWagie and are copied into the OpenCode skills
directory on first start unless the same skill already exists there or in
another host skill directory (`~/.claude/skills`, `~/.agents/skills`).

| Skill | Source | License |
| --- | --- | --- |
| superppt | https://github.com/NeoMei/SuperPPT | MIT (`LICENSES/SuperPPT-LICENSE`) |
| superwriter | https://github.com/NeoMei/SuperWriter | No license file in the source repository; © NeoMei |
| supervideo | https://github.com/NeoMei/SuperVideo | Apache-2.0 (`LICENSES/SuperVideo-LICENSE`); its engine ships OpenMontage, Remotion, PPTX2HTML and docx-preview notices |
| superweb | https://github.com/NeoMei/SuperWeb | MIT (`LICENSES/SuperWeb-LICENSE`) |
| WPSComposer | https://github.com/NeoMei/WPSComposer | No license file in the source repository; © NeoMei |
| ai-image-to-ppt | SuperWriter dependency | See `skills/ai-image-to-ppt/LICENSE` |
| image-to-editable-pptx | https://github.com/NeoMei/image-to-editable-pptx | No license file in the source repository; © NeoMei |
| obsidian-excalidraw | Bundled Obsidian Excalidraw skill | See `skills/obsidian-excalidraw/LICENSE` |
| grilling, grill-me, grill-with-docs, to-spec, domain-modeling | https://github.com/mattpocock/skills, v1.3.2 | MIT (`LICENSES/MattPocockSkills-LICENSE` and each installed skill's `LICENSE`) |

SuperWriter also declares `obsidian-excalidraw`, `WPSComposer`, and the
grilling family as dependencies. They are bundled here so the writing and
presentation flows work without a separate installer.

## Snapshot provenance

SuperPPT v0.3.6, SuperWeb v1.2.0 and WPSComposer v0.10.0 are pinned to
the official release commits recorded in each `VENDOR-SNAPSHOT.json`. These
receipts list the upstream and shipped SHA-256 for every owned file and name
each SuperWagie adaptation. They contain no local installation paths.

SuperPPT retains encoded local Markdown links. SuperWeb launches Chrome with
`--disable-features=MacAppCodeSignClone`. WPSComposer includes its upstream
macOS add-in resources inside the skill and resolves them in that installed
layout. Its 3 pinned Office templates come from the official `wpsjs@2.2.3`
archive, verified against the upstream lockfile integrity and template hashes.
The templates retain the package's Kingsoft redistribution terms in
`skills/WPSComposer/runtime/macos/wps-jsapi-probe/resources/wpsjs/LICENSE`.
The package metadata calls its license ISC; the included LICENSE contains
Kingsoft terms with modification and standalone-sale restrictions. The
template bytes remain unchanged. The wpsjs CLI and its dependencies are not
bundled or invoked.

The image-to-editable-pptx runtime remains a separate integration. These
snapshots do not install that runtime.

## Writing dependency snapshots

The 5 Matt Pocock skills use stable v1.3.2 at
`d1478fcb140db0b93c0c8df17bcfd311844749d0`. Each skill's
`VENDOR-SNAPSHOT.json` records upstream and shipped file hashes and names the
SuperWagie adaptations. Callable SuperWriter helpers retain
`disable-model-invocation: false`; their existing OpenAI host policy stays
unchanged. Glossary work reuses existing GLOSSARY or legacy CONTEXT files and
maps. Writing calls use the current customer workspace and existing stage
reviews. The bundled to-spec variant produces project-local content.

SuperWriter remains v0.2.9 at `f279b87fe1f826e50cda140707f821f5a8da0f8f`.
Its snapshot verifies the existing 46 source files and the restored official
`scripts/tender_template.py` helper. The helper has standard-library
dependencies. Repository installer and development verification utilities are
outside the shipped runtime subset.
