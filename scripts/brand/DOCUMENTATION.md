# Brand assets

## Ownership

`scripts/brand` generates the retained OpenChamber artwork used by VS Code,
mobile, the headless server page and reference badges. `geometry.mjs` holds
the drawings and `raster.mjs` renders PNG and ICO data. The shared icon sprite
also reads the OpenChamber glyph from this geometry.

SuperWagie artwork is maintained in `packages/web/public` and
`packages/electron/resources/icons`. The web splash uses the light and dark
`superwagie-logo` PNG wordmarks. The early Electron splash embeds PNG copies
because it appears before the server is ready. Shared React components use
`logo.png` and the wordmarks. These assets and their consumers retain their
current artwork when this generator runs.

The Icon Composer document and compiled macOS icons are maintained by the
Electron package. This generator neither rewrites that document nor removes
its layers. Native icon compilation remains in the Electron package.

## Invariants

- `textOutputs` and `imageOutputs` declare the generated text and raster files.
  Neither includes the web public directory, web splash or Electron package.
  The sprite and optional iOS symbol keep their separate generation steps.
- Retained generated text must match the geometry. The VS Code loader and
  headless server page keep their inline drawing between
  `<!-- brand:flat-logo:start -->` and `<!-- brand:flat-logo:end -->`.
  Missing markers fail validation before that output can be written.
- Fork PNGs and the PNG data embedded in SVG wrappers and the Electron splash
  must decode successfully. Product marks have visible, nonuniform pixels.
- Tests compare generated text exactly. Rendered image bytes depend on the
  installed libvips build, so tests validate image structure and ownership.
- The optional iOS Control Center symbol generation still uses `swiftdraw`.
  If that executable is missing, the existing symbol stays in place.

## Decisions

### Why generated output ownership is explicit

This fork uses SuperWagie PNG artwork for its web and desktop identity.
Applying the upstream cube generator to those paths would replace that
identity and delete extra Icon Composer layers. Restricting its output list
preserves the fork artwork while keeping deterministic checks for the
OpenChamber drawings still in use.

### Why fork images have separate validation

Fork artwork comes from maintained PNG assets and embedded raster copies.
It cannot be recreated from OpenChamber geometry. Decoding those files catches
missing or corrupt artwork without treating the upstream drawing as their
expected content.
