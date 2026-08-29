# Translation and theme maintenance

Simplified Chinese report HTML is the only editorial source. English report copy lives in
`locales/en/reports/<report-id>.json`; do not commit generated English HTML or add paired
language spans to source pages. `tools/build_localized_site.py` creates deploy-only static
HTML under `_site/en/` and `_site/zh-CN/`. Browser rendering never downloads translation
catalogues or calls an online translation service.

## Publishing workflow

1. Edit the Chinese report and update `reports.json` when adding a report.
2. Run `python3 tools/i18n_catalog.py wire` for a newly registered report.
3. Run `python3 tools/i18n_catalog.py extract`. Existing translations are retained and new
   or changed units are left blank.
4. Translate blank targets manually, or seed them with the optional local-only command
   `python3 tools/i18n_catalog.py translate --model qwen2.5:7b` and review every result.
   For a large new catalogue, `--draft` keeps the first pass fast; immediately rerun the
   command without `--draft` so the strict factual and terminology repair pass completes.
   Use `--report-id <id>` for one report or `--start-at <id>` to resume a long local pass.
5. Run `python3 tools/i18n_catalog.py repair` to enforce exact shared terminology, then
   `python3 tools/i18n_catalog.py audit` and review every suspicious collision in context.
6. After human review, run `python3 tools/i18n_catalog.py review --report-id <id>`. The
   recorded target hash becomes stale whenever any target changes.
7. Run `python3 tools/i18n_catalog.py stats` and `python3 tools/i18n_catalog.py validate`.
8. Run `python3 tools/generate_report_context.py` to refresh both language contexts and
   indexes, then `python3 tools/build_localized_site.py` to create the deployable site.
9. Run the JavaScript tests, retrieval evaluation, and `python3 tools/test_localized_site.py`.

Never change `source`, `occurrence`, `kind`, `attribute`, `sourceVersion`, or block locators
by hand. They are deterministic source identifiers. The `target` field is the maintained
translation. When the same source text appears several times, its occurrence and context
allow the English wording to differ safely.

Review translated negatives, completion states, risks, money, percentages, time ranges,
names, product names, and release claims against the Chinese source. Validation rejects
changed numeric facts, lost negative status, altered protected product/platform terms,
structured model output, remaining Han characters, glossary drift, and targets changed
after their recorded review. Use `--force` only when intentionally replacing every existing
target with a newly reviewed translation pass.

## Terminology

| Chinese/source term | Preferred English |
| --- | --- |
| 阶段（带编号） | Sprint |
| 后台 | Back Office (BO) |
| 节点 | VPN node |
| 验收 | acceptance testing |
| 上线 | release / go live, according to context |
| 收口 | closure / stabilization, according to context |
| SkyTunnel | SkyTunnel |
| FFF | FFF |
| staging | staging |
| 日总 | General Manager Ri |

Product names, code identifiers, versions, amounts, percentages, dates, and personal names
must retain their exact factual value. Use concise international business English.

## UI strings and theme tokens

Shared interface copy is maintained in `assets/ui-i18n.js`. Add every visible label, error,
status, dynamic count, title, placeholder, and ARIA action there. Use
`ArrowfishI18n.t(key, params)` or `tn(key, count, params)` instead of inline UI strings.

Explicit choices are the only values written to `arrowfish_preferences_v1`. The root route
uses that choice, then browser language, to enter `/en/` or `/zh-CN/`. Locale pages derive
their language from the URL; switching languages navigates to the matching static route and
preserves the selected report hash. System theme changes remain live until explicitly set.

All color additions must use semantic variables from `assets/site-theme.css`. Avoid raw
light-only colors, inversion filters, and duplicated per-page dark-mode rules. The only
preference controls are the language and theme SVG buttons in the existing header.

## AI locale contract

The browser sends `uiLocale` for interface errors and `responseLocale` for the latest
question. The Worker independently checks the question language, validates evidence against
the matching canonical context, and returns `meta.locale`. API failures retain the legacy
`error` string and also include a stable uppercase `code`; the browser may localize by code
without parsing server prose. Switching the UI language aborts the active request and removes
the current `sessionStorage` conversation by design.
