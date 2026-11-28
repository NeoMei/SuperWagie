# Markdown file references

## Ownership

The renderer classifies local references and opens them through the active
runtime's existing file viewer or editor. Runtime adapters own filesystem
access and authorization.

## Invariants

- Ordinary hrefs and file URLs decode once, after reference suffix parsing.
- Inline code, fenced code and path-looking labels preserve literal percent
  sequences. Confirmation caches distinguish hrefs from native path text.
- Encoded filename punctuation and edge spaces survive resolution, stat and
  file-tab navigation for every artifact type.
- External schemes and protocol-relative hrefs stay external. File URLs accept
  only local hosts. Existing workspace and symlink authorization remains.
- Streamed blocks return to their resting styles after the entrance effect.
  Backwards fill keeps delayed blocks hidden before they enter and lets
  Chromium release the finished animation.

## Decisions

### Why the resolver takes an input kind

The href `50%25off.md` identifies `50%off.md`; native path text may identify a
literal `50%25off.md`. Decode only at the URL boundary to keep those files distinct.

### Why resolved file paths preserve whitespace

Filename edge spaces distinguish files. Prose cleanup stays on native text
inputs, while resolved hrefs, filesystem probes and absolute file tabs retain
those spaces.

## Passive SVG fences in file previews

`MarkdownContent.passiveSvg` is opt-in and defaults off. FilesView enables it
for its Markdown previews. A complete `svg` fence can display a data-URL image
with a source toggle. `passiveSvgImage` accepts static SVG geometry and text, capped at 128 KiB,
5,000 elements and 64 ancestor levels. `use`, definitions, reference paints and
all hrefs remain source, so a small reference graph cannot expand into a large
image render. Scripts, event attributes, HTML, animation, style attributes,
external resources, processing instructions, document types and entities also
reject the image path. No SVG markup enters page DOM.
Ordinary chat fences, standalone SVG files and Mermaid keep their prior paths.

## Shell fences in settled replies

The run button is shown for complete shell fences in an assistant reply on
a chat surface with server-backed terminals. It starts a command-mode PTY in
the reply directory only after the user clicks. The returned PTY identity and
mode are reconciled into the terminal store so even an already-exited command
keeps its output. A command tab does not become an interactive shell on reload
or restart. A reply from a different runtime instance cannot activate a tab.
The phone opens its existing terminal drawer.

## Chat and file text parsing

Chat messages and chat exports keep single tildes literal; double tildes still
mark strikethrough. File previews keep single-tilde strikethrough by default.
The renderer selects stable GFM and CJK parser policies together, so changing
the policy with unchanged source also updates the rendered text.

User-authored Markdown enables `literalText`: HTML-looking text and character
entities stay as typed. This disables their parser constructs instead of
escaping the source, preserving the characters inside inline code and math.
Runtime file resolution, media authorization and passive SVG remain owned by
their existing opt-in paths.

## UI fences in replies

Only assistant replies and explicitly marked subagent output draw
`openui-lang` fences as blocks. Assistant tags and `openui` fences normalize
through the shared `taggedBlocks` parser. Reasoning, user text, documents,
ordinary tool output and chat exports retain source code.

A block can answer only a settled assistant reply with its original session,
message and directory. Streaming replies and finished subagent output have no
answer destination, so their controls remain disabled. The block renderer
loads on demand and keeps source visible while loading or after load failure;
the UI-block module owns its validation and answer lifecycle.

Tool output tagged `ansi` is shown without terminal escape sequences, including
before the highlighter loads. Highlighted tool views use a supported related
lexer before falling back to escaped plain text. The Markdown worker's Shiki
fallback and source-offset contract remain separate.

- GitHub alerts use the upstream titled blockquote component, including the
  localized title and status icon. Copying across transcript rows belonging to
  the same answer uses the complete ordered Markdown selection; selections
  spanning unrelated documents remain native.
