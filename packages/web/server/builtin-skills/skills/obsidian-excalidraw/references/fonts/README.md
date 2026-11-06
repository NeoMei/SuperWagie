# Vendored rendering fonts

These `woff2` subsets are copied unchanged from
`@excalidraw/excalidraw@0.18.1/dist/prod/fonts` by `../build-vendor.sh`.
Only the families used by generator output are included:

- Excalifont for the hand-drawn Latin/Greek/Cyrillic glyphs
- Xiaolai for CJK and related fallback glyphs

Both upstream font descriptors declare the SIL Open Font License 1.1. See the
corresponding `packages/excalidraw/fonts/Excalifont/index.ts` and
`packages/excalidraw/fonts/Xiaolai/index.ts` files in the Excalidraw repository
for attribution, Unicode ranges, and the embedded license text.

Do not edit the binary subsets by hand. Re-run `bash references/build-vendor.sh`
when the pinned Excalidraw package version changes.
