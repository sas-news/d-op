# d-OP Share Web Foundation

## 0. Research Log

- Existing d-OP README and store listing: retained the OP/ED focus, local-first language, and restrained red accent without copying the proprietary player UI.
- Existing app audit: no prior Web design system or component layer existed; this document establishes the first shared token contract.
- Greenfield direction: warm paper, ink, and coral accent create a quiet editorial shell suitable for future media data without adding decorative media or remote assets.

## Tokens and Rules

- Legacy source contract: dark `#0a0a0c` canvas, `#141418` panels, `#1c1c22` raised surfaces, white text ramp, and `#e60012` d-OP red accent.
- Palette: paper `#0a0a0c`, surface `#141418`, raised `#1c1c22`, ink `#f7f8fa`, muted white at 68%, accent `#e60012`, bright accent `#ff1a2d`, yellow focus `#ffcc00`.
- Typography: local Japanese-capable system sans for body and display; mono labels echo the original portal's product metadata.
- Spacing: `--space-1` through `--space-8`, based on a 4px unit.
- Shape and depth: compact radii, translucent borders, radial red/blue atmosphere, and two restrained shadows.
- Motion: short transform and color transitions only; reduced motion removes transitions.
- Accessibility: one page `h1`, landmark header/main/footer, skip link, visible keyboard focus, semantic status/error notices, and disabled native controls.
- Theme: one dark theme is intentionally shipped because it is the existing gh-pages brand language. Contrast is validated by browser assertions and the visible focus treatment.

## Reusable Primitives

- `Button`: primary and secondary link variants, plus native disabled button semantics.
- `Notice`: informational status and error alert tones; status messages remain non-modal.
- `Card`: bordered, elevated content surface with a heading and slotted body.
- `DialogShell`: safe non-modal dialog landmark with explicit title and description relationships; `aria-modal` is only emitted when a future caller intentionally supplies a modal state.
- `ErrorShell`: 404/error presentation composed from the notice and button primitives, never browser dialogs.

## Responsive and QA Contract

- The document owns scrolling; content uses `minmax(0, 1fr)`, `min-width: 0`, and safe wrapping for long Japanese and script-like text.
- Required viewport proofs are 320x900, 768x900, and 1440x1000 with no horizontal overflow or clipped controls.
- Every route has one main `h1`, a skip link, header/main/footer landmarks, keyboard-visible focus, and zero browser console errors.
