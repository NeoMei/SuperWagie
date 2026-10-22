# Page route blueprint

Use for landing pages, product pages, portfolios, event pages, and one-pagers.
The route is about browsing, not operating.

## Structure

The `directions` command prints the current structure; `src/directions.ts`
(`PAGE_BLUEPRINT`) is the source of truth. The default sections are:

| Section | Required | It must prove |
| --- | --- | --- |
| First viewport | yes | What this is, who it is for, what to do next |
| Credible evidence | yes | Why the claim can be trusted; delete if there is none |
| Core content | yes | How it solves the audience's problem |
| How to start | optional | The real steps from seeing to getting the result |
| Price / options | optional | Complete price, package, or event details |
| Questions | optional | Real objections that block action |
| Closing action | yes | Repeat the action with contact, time, or place |

Every section must have a one-sentence answer to "what does it prove". If the
answer is "it fills space", delete the section.

## First viewport

- Name the concrete object, not a category: "a bookshop on Charing Cross
  Road", not "solutions for modern retail".
- State the audience and the action. One primary action, visually dominant.
- Events put date, place, and action above the fold.
- A real product image, photograph, or honest placeholder is the visual anchor.
  Do not use a CSS-drawn mock product.

## Content completeness

- Full menu, full price list, full team, full schedule. No "and more" hiding
  required content.
- Copy in the audience's language.
- Real links for real destinations; if a destination does not exist yet, say so
  in the copy.
- Numbers need a source or must be removed.

## Type and color

- Choose the direction before layout. The sample must use the final tokens.
- Use one display face and one text face at most, plus a monospace only when
  the direction calls for it.
- Define a spacing scale (4/8 based), a radius rule, and a shadow rule. If the
  direction says "no radius", keep zero everywhere.
- Contrast: body text at least 4.5:1 against its background.

## Responsive rules

- 1440: use the full composition, but cap line length around 60–75 characters.
- 768: collapse multi-column layouts when the column would fall below about
  280px; do not simply shrink type.
- 390: single column, 16px minimum body text, 44px minimum touch targets,
  no horizontal scroll. Decorative overflow must be clipped deliberately.
- Test with `superweb inspect`; do not eyeball only at desktop width.

## Assets

Priority: user-provided local files → user-approved image generation → an
explicit placeholder. A placeholder must be visible and say what is needed:

```html
<figure>
  <div class="placeholder">[占位：书店门头照片，等待提供]</div>
</figure>
```

Never substitute a colored block, gradient, or hand-drawn SVG for a missing
logo or product photo without telling the user.
