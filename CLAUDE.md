# ProjectManagementReports

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
