# ProjectManagementReports

Follow the ancestor workspace instructions for exploration, safety, git, and
verification.

## Purpose

Static stakeholder-report site for published Arrowfish VPN sprint summaries and
full reports. Internal plans and execution evidence belong in
`vpn-internal-reports`, not this repository.

## Stack

- Static HTML, CSS, and browser JavaScript
- `reports.json` report catalogue
- GitHub Pages deployment through `.github/workflows/deploy.yml`

## Build & Verify

- `node --check assets/auth-gate.js`
- `python3 -m http.server 8000` for local visual review
- Verify every `reports.json` `file` path exists before publishing

There is no package manager or compiled build in this repository.

## Structure

- `index.html` — report landing page
- `reports.json` — generated/published report catalogue
- `Stakeholder/Sprint-*/` — stakeholder HTML artifacts
- `Stakeholder/Goal-2026/20260827_goals.html` — living annual goal dashboard
- `assets/auth-gate.js` — shared browser access gate
- `.github/workflows/deploy.yml` — catalogue generation and Pages deployment

## Knowledge

Read `ProjectManagementReports/.claude/knowledge/INDEX.md` first (path from
workspace root). Dated sprint facts and working evidence remain in
`vpn-internal-reports`; do not duplicate them as durable knowledge here.

## Key Conventions

- Keep stakeholder reports as self-contained HTML artifacts.
- Preserve the `Stakeholder/Sprint-<N>/YYYYMMDD_<type>.html` layout consumed by
  the deployment workflow.
- Do not place internal plans, issues, credentials, or live infrastructure
  inventory in published reports.
- Keep catalogue titles and dates consistent with each report's HTML metadata.
- Treat weekly and sprint stakeholder reports as immutable after publication.
- Treat `Stakeholder/Goal-2026/20260827_goals.html` as the sole living annual
  dashboard exception. Preserve its filename and stable goal IDs.
- An approved goal refresh updates the dashboard's latest progress, next
  milestone, goal status, visible effective date, metadata, calculated totals,
  matching `reports.json` name/date/version, and English translation data.
- Goal status (`planned`, `progress`, `done`) is strategic aggregation and is
  not a Jira workflow status. A completed Jira ticket does not automatically
  complete its parent goal.
- Preserve Arrowfish/FFF isolation: source modules may be versioned and reused,
  but FFF must not share Arrowfish production runtime, accounts, database,
  Redis, secrets, or migration history.
