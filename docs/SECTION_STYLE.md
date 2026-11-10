# Per-section style options

Each homepage section (Lummet Site > Homepage sections) can be styled on its own, next to its **Background colour**:

| Field | Options | Effect |
|---|---|---|
| Heading font | Default, Serif, Monospace | Headings in this section, including card titles |
| Body text font | Default, Serif, Monospace | All text in this section |
| Text alignment | Left (default), Centred | Heading and intro (and the text-only block) |
| Content width | Standard, Narrow, Wide | Max width of the section's content |
| Vertical spacing | Standard, Compact, Spacious | Space above and below |
| Cards per row | Automatic, 1, 2, 3, 4 | Card, step, brand, update, insight and partner grids, checklists and the panel grid. Phones show one or two |

"Default" everywhere means the section looks exactly as it did before. Nothing here sets a colour, so every option works on every band and the band audit (`npm run audit:bands`) still applies.

## How it is kept safe
`worker/public-site/section-style.js` holds the allowed values. Anything else in the database (a typo, a hand edit) is ignored, so it cannot put a class name or CSS on the page. `test/section-style.test.js` covers that, plus the CMS form matching the renderer.

## Fonts
Serif and Monospace are system fonts (nothing to download, no CSP change). Only Instrument Sans ships with the site. To offer another web font: self-host the `.woff2` in `public/static/`, declare it in `tokens.css`, add a `--font-*` token, a `.sec-hfont-*` / `.sec-bfont-*` rule, and one value in `section-style.js` and in the CMS field options (the test fails until they match). Pages and the header/footer are not styled per section.
