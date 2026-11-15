# Syntax language support

## Ownership

This module owns syntax language mappings and grammar preparation shared by
code renderers. Each renderer owns its engine selection and source handling.

## Invariants

- Tool code views prefer the requested Highlights lexer, then a supported
  `LANGUAGE_RELATIVES` entry, then plain text.
- Markdown's worker retains Shiki grammar state for languages without a
  Highlights lexer. The tool fallback does not change that engine boundary.

## Decisions

### Why tool views and Markdown retain separate fallbacks

A close lexer improves tool output without loading a second engine. Markdown
already has a grammar-state fallback for unsupported Highlights languages;
replacing it with plain text would remove existing syntax support.
