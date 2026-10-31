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

## Decisions

### Why the resolver takes an input kind

The href `50%25off.md` identifies `50%off.md`; native path text may identify a
literal `50%25off.md`. Decode only at the URL boundary to keep those files distinct.

### Why resolved file paths preserve whitespace

Filename edge spaces distinguish files. Prose cleanup stays on native text
inputs, while resolved hrefs, filesystem probes and absolute file tabs retain
those spaces.
