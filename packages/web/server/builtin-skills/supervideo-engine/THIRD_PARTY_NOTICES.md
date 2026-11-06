# Third-party sources and notices

SuperVideo original source and skill instructions are Copyright 2026 NeoMei and licensed under the Apache License, Version 2.0; see LICENSE. Third-party components retain their own licenses. The SuperVideo license does not replace upstream terms or grant rights to user-provided books, slides, fonts, music or other media.

- OpenMontage: https://github.com/calesthio/OpenMontage, pinned commit 08e2151fa02de28a5d6a312b3d575692bf147ad7. Its GNU AGPLv3 LICENSE is preserved in licenses/OpenMontage-LICENSE. Only the audited mixer/subtitle/base closure and optional legacy TTS module are included under vendor/openmontage with original license and hash provenance. No full checkout or upstream requirements installation is needed. Its AGPLv3 terms remain applicable; no process-boundary exception is claimed.
- Remotion and @remotion/renderer: version 4.0.522, https://github.com/remotion-dev/remotion. A minimal headless browser entry derived from the pinned Studio package is in vendor/remotion with modification, attribution and license notices; the full Studio/bundler and Webpack/Rspack are excluded. Core/renderer actual installed LICENSE.md files are retained in licenses/; dependencies and transitive versions are pinned by package-lock.json and installed separately.
- Chinese fonts are imported per project with their own license and provenance. Noto Sans CJK SC from https://github.com/notofonts/noto-cjk is an available OFL-licensed option. Font binaries are not in the lightweight distribution. System fonts must not be assumed redistributable.
- External FFmpeg, Python, document-rendering tools and Chrome are separately installed prerequisites with their respective upstream licenses, not bundled binaries.

- PPTX2HTML: version 0.3.4, https://github.com/arantes555/PPTX2HTML. The bundled browser converter is in vendor/office/pptx2html.full.js with its MIT license. It is used only for modern PPTX page capture; no desktop Office process is launched.
- docx-preview: version 0.4.1, https://github.com/VolodymyrBaydalka/docxjs. The browser bundle is in vendor/office/docx-preview.js with its Apache-2.0 license. It is used only for modern DOCX page capture.
- MarkItDown: optional host-provided semantic parser, https://github.com/microsoft/markitdown. SuperVideo invokes the configured executable when available and does not bundle or install its optional dependency set. Its own license and transitive notices remain the responsibility of the host environment.

The PPTX2HTML bundle has a local table-style compatibility patch. It normalizes absent, single and multiple styles, and uses an empty style when the referenced theme is absent. Original and shipped hashes are in vendor/office/provenance.json; the exact patch and both renderer licenses are retained there. Built-in Office theme emulation remains incomplete.

Modern PPTX/DOCX page extraction uses local Chrome. Optional MarkItDown supplies semantic text. Legacy .ppt/.doc conversion still requires explicitly configured host tools. SuperWagie Office viewing remains with Omni Viewer.

## SuperWagie diagnostic adaptations

These files derive from SuperVideo v0.1.2, commit `e3536f25aef1b6873ba11d8e8256156721f043fb`, at https://github.com/NeoMei/SuperVideo. The verified release archive SHA256 is `e3512261922b66f4efce233fcdaffc4718a812d658d3791ed5de0d1b43c8d702`. SuperWagie keeps the upstream release and dependency pins. The runtime manifest calls the shipped diagnostic API; the Python entry reports missing lxml through its structured dependency protocol.

| File | Upstream SHA256 | Shipped SHA256 |
| --- | --- | --- |
| `runtime-manifest.json` | `cfb900ebd21eb954d486c80c7e38ec0c46b9056557c80e4d5f5694525cf60537` | `e73ee0c3ebe737e0de8b59d05b09036e5144f3400813022e149b4f3b588c2a22` |
| `python/documents.py` | `da459d5eaa6e6b5fe1dd417ce5dab4e56fa69f9ba4b938171b029e7373599705` | `d11afa5cd0c8238298acdbd00b0c7c342acdedad2b1c2710571ce95fd03f7bf5` |
