# Bundled skills

These skills ship with SuperWagie and are copied into the OpenCode skills
directory on first start unless the same skill already exists there or in
another host skill directory (`~/.claude/skills`, `~/.agents/skills`).

| Skill | Source | License |
| --- | --- | --- |
| superppt | https://github.com/NeoMei/SuperPPT | MIT (`LICENSES/SuperPPT-LICENSE`) |
| superwriter | https://github.com/NeoMei/SuperWriter | No license file in the source repository; © NeoMei |
| supervideo | https://github.com/NeoMei/SuperVideo | Apache-2.0 (`LICENSES/SuperVideo-LICENSE`); its engine ships OpenMontage and Remotion notices |
| superweb | https://github.com/NeoMei/SuperWeb | MIT (`LICENSES/SuperWeb-LICENSE`) |
| WPSComposer | https://github.com/NeoMei/WPSComposer | No license file in the source repository; © NeoMei |
| ai-image-to-ppt | SuperWriter dependency | See `skills/ai-image-to-ppt/LICENSE` |
| image-to-editable-pptx | https://github.com/NeoMei/image-to-editable-pptx | No license file in the source repository; © NeoMei |
| obsidian-excalidraw | Bundled Obsidian Excalidraw skill | See `skills/obsidian-excalidraw/LICENSE` |
| grilling, grill-me, grill-with-docs, to-spec, domain-modeling | SuperWriter's declared dependencies | No license file in the source directories |

SuperWriter also declares `obsidian-excalidraw`, `WPSComposer`, and the
grilling family as dependencies. They are bundled here so the writing and
presentation flows work without a separate installer.
