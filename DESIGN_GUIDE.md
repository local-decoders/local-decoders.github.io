# Design Guide — Light Scientific Theme

A style guide for building websites that match the CA Decoder Visualizer aesthetic: clean, data-dense, technical, and legible.

---

## Philosophy

The overall feel is a **scientific instrument** — light, precise, and functional. UI chrome stays minimal so data and content dominate. Color is used sparingly: one blue accent on a near-white background with greyscale text hierarchy. Nothing decorative that doesn't serve a purpose.

---

## Fonts

Two typefaces, each with a specific role:

- **Serif (Crimson Pro)** — used exclusively for the main page title. Gives weight and formality to the top-level heading without being ostentatious.
- **Monospace (JetBrains Mono)** — used for everything else: body text, labels, inputs, buttons, stats. Reinforces the technical/computational character of the interface.

Body text sits at 13px, weight 400, with a comfortable 1.6 line-height.

---

## Color

The palette is light mode with a single blue accent (`#5b9bd5`). All colors are defined as CSS custom properties so they can be swapped consistently.

- **Backgrounds**: three levels — a slightly tinted page background (`#f4f5f7`), white card surfaces, and a very faint off-white for inset elements like inputs.
- **Borders**: two weights — a standard soft border and a slightly darker one used on hover.
- **Accent**: used on interactive highlights, focus rings, slider thumbs, active values, and links. Appears at full saturation for active elements; at ~12% opacity for glow/fill effects.
- **Text**: four levels — near-black for values and headings, medium grey for body, light grey for labels and secondary text, and a muted grey for placeholders and disabled states.
- **Status colors**: red for errors/logical failures, amber for warnings. Used sparingly and only when something is genuinely wrong.

---

## Background Texture

The page background uses a subtle dot-matrix pattern: a radial-gradient dot at ~6% opacity on a 24px grid. This gives the feel of graph paper or a lab notebook without being visually heavy.

---

## Layout

Two-column grid: main visualization on the left and code details on the right. 

Above both columns, a centered header and an optional full-width description strip.

---

## Cards and Panels

All panels share the same surface treatment: white background, 1px soft border, 10px border radius. This creates a clear layering hierarchy — panel over the textured page background. No drop shadows; borders alone provide the separation.

Panels with grouped settings use a 1px bottom border between each group, which reads as a divider without requiring extra spacing.

---

## Typography Hierarchy

Section labels (e.g. "System Size", "Display") are tiny, uppercase, widely letter-spaced, and in a muted grey. This keeps them readable without competing with the actual content below them.

Headings inside panels follow the same monospace font as the rest of the UI — the visual distinction comes from size, weight, and color rather than switching typefaces. The single exception is the page title, which uses the serif.

The page title has a short accent-colored underline bar (60px wide, 2px tall) centered below it. This is the only decorative element in the design.

Live numeric values use tabular (fixed-width) numerals so they don't shift layout as they update.

---

## Form Controls

All inputs (text, number, select, slider, radio, checkbox) share a visual language:

- Same monospace font and small font size as the rest of the UI
- Slightly inset background (`--bg-surface`) to distinguish them from the panel
- 1px border that transitions to the accent color on focus, with a faint accent-colored ring (no default browser outline)
- The select chevron is a custom SVG in the same muted grey as labels

Sliders have a thin 3px track and a 14px circular thumb in the accent color. The current value is shown in a small accent-tinted chip beside the slider.

Radio and checkbox rows have a hover background that matches card-hover — just enough feedback without being visually heavy.

---

## Buttons

Use uppercase monospace text with slight letter-spacing. Both scale down slightly on click (`scale(0.97)`). Disabled state is just reduced opacity — no style changes.


## Animations

- **Page load**: each top-level grid element fades in and slides up 8px, staggered by ~50ms per element. Keeps the load feel smooth without being flashy.
- **Loading state**: a slow opacity pulse (2s) for anything that is computing or waiting.
- All interactive transitions (hover, focus, active) use short durations — 150–200ms — so the UI feels responsive rather than sluggish.

---

## Summary of Key Decisions

| Decision | Rationale |
|---|---|
| Monospace body font | Reinforces the technical/computational context |
| Single accent color | Keeps visual noise low; accent means "interactive or active" |
| No drop shadows | Borders alone provide layering; shadows feel too decorative |
| Dot-matrix background | Adds depth and texture without color or weight |
| Uppercase spaced labels | Visually distinct from content without a font change |
| Serif title only | One moment of warmth/formality at the top; everything else is precise |
| Tabular numerals on stats | Prevents layout shift in live-updating displays |
