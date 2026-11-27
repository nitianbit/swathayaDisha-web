# Design rules

Calm, plain and fast. Staff use the workspace for hours; customers may be on a cheap phone with a weak signal.

- **Tokens.** Colours, spacing, radius, type and focus come from `packages/ui/src/tokens.css`. Do not hard-code
  colours in app CSS.
- **One job per screen.** One `h1` (id `page-title`, focused after navigation), one primary action.
- **Every data screen has four states:** loading, empty, error with "Try again", and content. Use `Loading`, `Empty`
  and `ErrorState` from `@jansetu/ui`.
- **Every visible control works.** No placeholder buttons, no mock data in shipped screens.
- **Forms:** visible labels, inline errors tied with `aria-describedby`, a 44px minimum tap target, visible focus.
  Validate with the backend's own rules (exported from `@jansetu/api`), and still show the server's message.
- **Irreversible actions** (reject, refund, cancel) need an explicit second step that says what will happen.
- **Money** is shown with `formatRupees` (Indian grouping); dates with `formatDateTime` in IST.
- **Tables** for staff lists; they scroll horizontally inside their own wrapper, never the page.
- **Responsive:** the workspace works from tablet width up; the customer app is designed for 360px phones first.
- **Motion:** none required; `prefers-reduced-motion` turns off whatever is added.
- **Colour (WQ60).** Warm and friendly, readable first. Body ink is AAA on the canvas, and every pair in `tokens.css` is
  AA or better. Each workspace area has one colour: pharmacy green, lab violet, clinic blue, doctor clay, and Jansetu
  teal for admins. It is set by `data-area` on the shell, which re-points `--brand*`, so buttons, links, the active menu
  item and the main tile follow it. Status colours (ok, warn, danger, info, neutral) always come with an icon and words,
  never colour alone: `Badge` and `Alert` draw the tone's icon.
- **Tiles.** Home buttons and money tiles are soft-hued tiles: the icon large in a white circle, the label in ink. The
  first tile is in the area colour. Tile hues (`--hue-*`) are ≥ 5:1 with their soft backgrounds.
- **Charts** use `--chart-1…8`: a palette based on Okabe–Ito, each ≥ 3:1 on white. A chart also tells its series apart
  by label.
- **Icons** come from lucide only, are `aria-hidden`, and sit next to words; never a bare icon.
- No large illustrations, nested cards or decorative gradients.
