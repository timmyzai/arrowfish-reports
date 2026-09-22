# ProjectManagementReports

Follow the ancestor workspace instructions.

Static stakeholder-report site. Internal plans and execution evidence belong in
`../vpn-internal-reports/`.

## Publishing contracts

- Reports are self-contained HTML under `Stakeholder/Sprint-<N>/YYYYMMDD_<type>.html`.
  Published weekly/sprint reports are immutable; corrections retain historical evidence.
- The sole living dashboard is `Stakeholder/Goal-2026/20260827_goals.html`.
  Preserve its filename and goal IDs. An approved refresh updates progress,
  milestones, statuses, effective date, totals, metadata, English translations,
  and the corresponding `reports.json` name/date/version together.
- Goal status is strategic aggregation; a completed Jira ticket does not itself
  complete a goal. Preserve Arrowfish/FFF runtime, account, database, Redis,
  secret, and migration-history isolation when reporting shared work.
- Publish no internal plans, issues, credentials, or infrastructure inventory.

## When relevant

- New reports: read [the reporting calendar](Stakeholder/README.md) and
  [Jira rules](../vpn-internal-reports/.claude/JIRA.md).
- Durable reporting context: use [the knowledge index](.claude/knowledge/INDEX.md).
- Before publishing, verify catalogue file paths and report titles/dates match.
  Use `python3 -m http.server 8000` for visual review; there is no compiled build.
  For auth-gate changes, run `node --check assets/auth-gate.js`.
