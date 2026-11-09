# Blue and dark background bands: how they work and how they are checked

A homepage section or a page header can sit on a **blue** or **dark** band (Lummet Site > Homepage sections / Pages / Site settings).

## One rule for CSS authors
Components read colour **tokens** (`--ink`, `--ink-dim`, `--ink-faint`, `--surface`, `--bg-soft`, `--border`, `--accent-ink`, `--ok`).
`public/static/css/components.css` re-points those tokens once for `.bg-blue` and `.bg-dark`, so any component that uses them for text and
backgrounds works on a band with no extra rule. Do **not** hard-code `#fff`, `#111` or a fixed grey for text or a card background.
`--accent` and `--band` are deliberately not re-pointed: buttons and small marks use them as fills.

## What is checked, and where
`npm run audit:bands` (`scripts/band-audit.mjs`) renders the real pages in Chromium, puts every section and page header on the blue band, then
the dark band, in the light and the dark theme, on 390px wide screens, and fails when:
- visible text is below 4.5:1 (3:1 for large text) against what is actually painted behind it,
- a button, chip or link is below 4.5:1 while hovered,
- the keyboard focus ring is below 3:1 against the band,
- typed text or a placeholder in a form field is below 4.5:1.
The `Band audit` workflow runs it on pull requests that touch `public/static/**` or `worker/public-site/**` and attaches a screenshot of every page.
Against the CSS from before the token change it found 137 problems; it must stay at zero.

## Designer review checklist (needs a person, a script cannot judge it)
- [ ] Blue band: is the brand blue the right one for text-heavy sections, and do the darker cards read as intended?
- [ ] Dark band: surface tint and border strength, next to the light header and footer.
- [ ] Logo tiles stay white on both bands (artwork is drawn for a light tile). Is that the look you want?
- [ ] Optional alternative: white cards with dark text on the blue band (needs a small CSS change).
- [ ] Look at the attached screenshots, not only the pass/fail result.
