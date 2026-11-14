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
- No large illustrations, icon grids, nested cards or decorative gradients.
