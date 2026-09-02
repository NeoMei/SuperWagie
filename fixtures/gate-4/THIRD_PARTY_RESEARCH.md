# Gate 4 third-party research boundary

Research snapshot: 2026-09-01. These projects are research references only; neither
source tree, runtime, templates, prompts, schemas nor UI may enter the SuperWagie
production dependency graph.

| Project | Pinned identity | License evidence | Decision |
|---|---|---|---|
| OpenMontage | `calesthio/OpenMontage@cd9f3c1f03368be87b140af494914b8ee4e3c7a4` | `LICENSE` is AGPLv3; SHA-256 `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0` | Research only; no code or runtime integration. |
| Remotion | `remotion-dev/remotion@aa8cf57c355b328db2a85280eca77189300f4747` | `LICENSE.md`; SHA-256 `bd65083b940f61904f6ef298aade918a7cad72a3e35bc406e36fab365844b673` | Research only; no code, npm package, renderer, player, studio or templates. |

Remotion's current Free License allows eligible individuals, nonprofits and
for-profit organizations with up to three employees to create commercial videos,
but disallows copying or modifying Remotion code for the purpose of selling,
licensing or sublicensing a derivative. Larger for-profit organizations require a
Company License. SuperWagie's confirmed clean-room decision avoids making either
license a production prerequisite; it does not waive the separate Chromium,
FFmpeg, codec, font, TTS and media-asset SBOM review.

