#!/usr/bin/env python3
"""Generate deterministic, citation-ready context from stakeholder HTML reports."""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORTS_FILE = ROOT / "reports.json"
OUTPUTS = {
    "zh-CN": (ROOT / "report-context.json", ROOT / "report-index.json"),
    "en": (ROOT / "report-context.en.json", ROOT / "report-index.en.json"),
}

BLOCK_TAGS = {"p", "li", "summary", "dt", "dd", "blockquote", "pre"}
HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
SKIP_TAGS = {"script", "style", "noscript", "template", "svg"}
SEMANTIC_CLASS = re.compile(
    r"(?:(^|[-_])(tldr|callout|note|metric|titem|ttext|flow-step|update-card|risk-card|kpi|highlight)([-_]|$))"
    r"|(?:^|\s)route-future-card(?:\s|$)",
    re.IGNORECASE,
)
NEGATIVE_STATUS_RE = re.compile(
    r"(?:尚未|未|没有|不能|无法|不可)(?:.{0,6})?"
    r"(?:完成|上线|发布|验收|关闭|实现|使用|可用)",
    re.IGNORECASE,
)
NEGATIVE_STATUS_RE_EN = re.compile(
    r"\b(?:not\s+yet|not|never|no\s+longer|cannot|can't|unable|pending|blocked|incomplete|outstanding)\b",
    re.IGNORECASE,
)
STAGE_STATES = ("complete", "current", "next", "planned")
TIMELINE_RULES = (
    ("dated", re.compile(r"20\d{2}-\d{2}-\d{2}|20\d{2}\s*[-–]\s*\d{2}|20\d{2}\s*年\s*\d{1,2}\s*月")),
    ("next-release", re.compile(r"下一发布窗口|下次生产发布前|下一管理看板")),
    ("gated", re.compile(r"验收后|验收前|验证后|首发前|关闭后|完成后|门槛|门控")),
    ("year-end", re.compile(r"年底前|持续至年底")),
    ("ongoing", re.compile(r"持续")),
    ("unscheduled", re.compile(r"待排期")),
    ("now", re.compile(r"\bP0\b")),
)
AT_RISK_RE = re.compile(r"进度风险")


def goal_timeline(source_deadline: str) -> str:
    for name, pattern in TIMELINE_RULES:
        if pattern.search(source_deadline):
            return name
    return "unscheduled"


def normalize_text(value: str) -> str:
    value = value.replace("\xa0", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r"\s*\n\s*", " ", value)
    return re.sub(r"\s{2,}", " ", value).strip()


class TranslationLookup:
    """Apply sidecar translations in the same visible-text order as extraction."""

    def __init__(self, units: list[dict] | None = None) -> None:
        self.targets = {
            (unit["source"], int(unit.get("occurrence", 0))): unit.get("target", "")
            for unit in (units or [])
            if unit.get("kind") == "text"
        }
        self.counts: defaultdict[str, int] = defaultdict(int)

    def translate(self, value: str) -> str:
        source = value.strip()
        if not source:
            return value
        occurrence = self.counts[source]
        self.counts[source] += 1
        target = self.targets.get((source, occurrence), "").strip()
        if not target:
            return value
        leading = value[: len(value) - len(value.lstrip())]
        trailing = value[len(value.rstrip()) :]
        return f"{leading}{target}{trailing}"


class ReportParser(HTMLParser):
    def __init__(self, translations: list[dict] | None = None) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict] = []
        self.blocks: list[dict] = []
        self.section = "Report overview"
        self.skip_depth = 0
        self.translations = TranslationLookup(translations)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in SKIP_TAGS:
            self.skip_depth += 1
        self.stack.append(
            {
                "tag": tag,
                "attrs": dict(attrs),
                "parts": [],
                "source_parts": [],
                "line": self.getpos()[0],
            }
        )

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self.skip_depth or not data.strip():
            return
        source_data = data
        data = self.translations.translate(source_data)
        for node in self.stack:
            node["source_parts"].append(source_data)
            node["parts"].append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if not self.stack:
            return

        index = len(self.stack) - 1
        while index >= 0 and self.stack[index]["tag"] != tag:
            index -= 1
        if index < 0:
            return

        closing = self.stack[index:]
        self.stack = self.stack[:index]
        node = closing[0]

        if tag in SKIP_TAGS:
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if self.skip_depth:
            return

        text = normalize_text(" ".join(node["parts"]))
        source_text = normalize_text(" ".join(node["source_parts"]))
        if len(text) < 2:
            return

        ancestor_tags = {item["tag"] for item in self.stack}
        classes = node["attrs"].get("class", "") or ""
        kind = ""

        if tag in HEADING_TAGS:
            kind = "heading"
            if tag != "h1":
                self.section = text
        elif tag == "tr":
            kind = "table-row"
        elif tag in BLOCK_TAGS and "tr" not in ancestor_tags:
            kind = "details-summary" if tag == "summary" else tag
        elif tag in {"div", "article"} and SEMANTIC_CLASS.search(classes):
            kind = "highlight"

        if not kind:
            return

        if self.blocks and self.blocks[-1]["_source_text"] == source_text:
            return

        self.blocks.append(
            {
                "id": f"b{len(self.blocks) + 1:04d}",
                "section": self.section,
                "type": kind,
                "line": node["line"],
                "text": text[:2000],
                "_source_text": source_text,
            }
        )


def class_names(node: dict) -> set[str]:
    return set((node.get("attrs", {}).get("class", "") or "").split())


class ReportIndexParser(HTMLParser):
    """Extract the roadmap and goal registry without introducing a DOM dependency."""

    def __init__(self, translations: list[dict] | None = None) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict] = []
        self.phases: list[dict] = []
        self.goals: list[dict] = []
        self.workstream_labels: dict[str, str] = {}
        self.status_labels: dict[str, dict[str, str]] = {}
        self.skip_depth = 0
        self.translations = TranslationLookup(translations)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in SKIP_TAGS:
            self.skip_depth += 1
        self.stack.append(
            {
                "tag": tag,
                "attrs": dict(attrs),
                "parts": [],
                "source_parts": [],
                "fields": {},
            }
        )

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self.skip_depth or not data.strip():
            return
        translated = self.translations.translate(data)
        for node in self.stack:
            node["parts"].append(translated)
            node["source_parts"].append(data)

    def nearest(self, class_name: str) -> dict | None:
        return next(
            (node for node in reversed(self.stack) if class_name in class_names(node)),
            None,
        )

    def workstream(self) -> str | None:
        for node in reversed(self.stack):
            attrs = node.get("attrs", {})
            goal_group = attrs.get("data-goal-group")
            if goal_group:
                return goal_group
            if "project-section" in class_names(node) and attrs.get("id"):
                return re.sub(r"-goals$", "", attrs["id"])
        return None

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if not self.stack:
            return
        index = len(self.stack) - 1
        while index >= 0 and self.stack[index]["tag"] != tag:
            index -= 1
        if index < 0:
            return

        closing = self.stack[index:]
        self.stack = self.stack[:index]
        node = closing[0]
        if tag in SKIP_TAGS:
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if self.skip_depth:
            return
        text = normalize_text(" ".join(node["parts"]))
        source_text = normalize_text(" ".join(node["source_parts"]))
        classes = class_names(node)

        if tag == "h2":
            workstream = self.workstream()
            if workstream:
                label = re.sub(
                    r"\s+(?:2026\s+(?:路线图|Roadmap)|(?:目标清单|Goal Registry))$",
                    "",
                    text,
                    flags=re.IGNORECASE,
                ).strip()
                self.workstream_labels.setdefault(workstream, label or workstream)

        status_count = self.nearest("status-count")
        if tag == "span" and status_count is not None:
            workstream = self.workstream()
            status_key = next(
                (name for name in class_names(status_count) if name != "status-count"),
                None,
            )
            if workstream and status_key and text:
                self.status_labels.setdefault(workstream, {})[status_key] = text

        phase = self.nearest("route-stage") or self.nearest("route-future-card")
        if phase is not None:
            if "route-date" in classes or "route-status" in classes:
                phase["fields"]["label"] = text
            elif tag in {"h3", "h4"}:
                phase["fields"]["title"] = text
            elif "route-result" in classes:
                phase["fields"]["result"] = text

        goal_row = self.nearest("goal-row")
        if goal_row is not None and tag == "td":
            goal_row["fields"].setdefault("cells", []).append(text)
            goal_row["fields"].setdefault("sourceCells", []).append(source_text)

        if "route-stage" in classes or "route-future-card" in classes:
            workstream = self.workstream()
            fields = node["fields"]
            if workstream and fields.get("title") and fields.get("result"):
                self.phases.append(
                    {
                        "workstream": workstream,
                        "label": fields.get("label", ""),
                        "title": fields["title"],
                        "result": fields["result"],
                        "future": "route-future-card" in classes,
                        "stage": next(
                            (name for name in classes if name in STAGE_STATES),
                            "planned",
                        ),
                        "text": text,
                    }
                )

        if "goal-row" in classes:
            workstream = self.workstream()
            cells = node["fields"].get("cells", [])
            source_cells = node["fields"].get("sourceCells", [])
            source_deadline = source_cells[4] if len(source_cells) >= 5 else ""
            goal_match = re.match(r"(?:(?:FFF|SHARED)\s*·\s*)?(G\d+)\s*(.*)", cells[0]) if cells else None
            if workstream and len(cells) >= 5 and goal_match:
                self.goals.append(
                    {
                        "workstream": workstream,
                        "id": goal_match.group(1),
                        "title": goal_match.group(2).strip(),
                        "status": cells[1],
                        "statusGroup": node["attrs"].get("data-status", ""),
                        "evidence": cells[2],
                        "nextAction": cells[3],
                        "deadline": cells[4],
                        "timeline": goal_timeline(source_deadline),
                        "atRisk": bool(AT_RISK_RE.search(source_deadline)),
                        "text": text,
                    }
                )
            else:
                self.goals.append({"unparsed": text})


def parse_report(path: Path, translations: list[dict] | None = None) -> list[dict]:
    parser = ReportParser(translations)
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    for block in parser.blocks:
        block.pop("_source_text", None)
    return parser.blocks


def parse_report_index(
    path: Path, translations: list[dict] | None = None
) -> tuple[list[dict], list[dict], dict[str, str], dict[str, dict[str, str]]]:
    parser = ReportIndexParser(translations)
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    return parser.phases, parser.goals, parser.workstream_labels, parser.status_labels


def source_ref(report: dict, block: dict) -> dict:
    return {
        "reportId": report["id"],
        "blockId": block["id"],
    }


def matching_block(blocks: list[dict], text: str, preferred_type: str) -> dict | None:
    normalized = normalize_text(text)
    return next(
        (
            block
            for block in blocks
            if block["type"] == preferred_type and normalize_text(block["text"]) == normalized
        ),
        None,
    )


def build_report_index(
    output_reports: list[dict],
    translations_by_file: dict[str, list[dict]] | None = None,
    negative_status_re: re.Pattern = NEGATIVE_STATUS_RE,
) -> dict:
    workstreams: dict[str, dict] = {}
    unparsed_rows: list[str] = []

    for report in output_reports:
        path = ROOT / report["file"]
        phases, goals, labels, status_labels = parse_report_index(
            path, (translations_by_file or {}).get(report["file"])
        )
        for key, label in labels.items():
            workstreams.setdefault(
                key,
                {
                    "label": label,
                    "statusLabels": status_labels.get(key, {}),
                    "phases": [],
                    "goals": [],
                },
            )
        for phase in phases:
            block = matching_block(
                report["blocks"], phase.pop("text"),
                "highlight" if phase.pop("future") else "li",
            )
            if not block:
                continue
            workstream = phase.pop("workstream")
            workstreams.setdefault(
                workstream,
                {
                    "label": labels.get(workstream, workstream),
                    "statusLabels": status_labels.get(workstream, {}),
                    "phases": [],
                    "goals": [],
                },
            )
            workstreams[workstream]["phases"].append(
                {**phase, **source_ref(report, block)}
            )

        for goal in goals:
            if "unparsed" in goal:
                unparsed_rows.append(f"{report['file']}: {goal['unparsed']}")
                continue
            block = matching_block(report["blocks"], goal.pop("text"), "table-row")
            if not block:
                unparsed_rows.append(f"{report['file']}: {goal['id']} {goal['title']}")
                continue
            workstream = goal.pop("workstream")
            workstreams.setdefault(
                workstream,
                {
                    "label": labels.get(workstream, workstream),
                    "statusLabels": status_labels.get(workstream, {}),
                    "phases": [],
                    "goals": [],
                },
            )
            workstreams[workstream]["goals"].append(
                {**goal, **source_ref(report, block)}
            )

    blockers = []
    seen_blockers: set[str] = set()
    for report in sorted(output_reports, key=lambda item: item["date"], reverse=True):
        for block in report["blocks"]:
            normalized = normalize_text(block["text"])
            if (
                block["type"] == "heading"
                or is_low_information_block(block)
                or not negative_status_re.search(normalized)
                or normalized in seen_blockers
            ):
                continue
            seen_blockers.add(normalized)
            blockers.append(
                {
                    **source_ref(report, block),
                    "reportDate": report["date"],
                    "section": block["section"],
                    "text": block["text"],
                }
            )

    if unparsed_rows:
        print("WARNING: unparsed 目标清单 rows:")
        for row in unparsed_rows:
            print(f"- {row}")

    return {
        "order": [
            report["id"]
            for report in sorted(output_reports, key=lambda item: item["date"], reverse=True)
        ],
        "workstreams": workstreams,
        "blockers": blockers,
    }


def is_low_information_block(block: dict) -> bool:
    return block["type"] == "table-row" and len(block["text"]) < 32 and not re.search(r"\d", block["text"])


def localized_name(report: dict, locale: str) -> str:
    name = report["name"]
    if isinstance(name, dict):
        return name.get(locale) or name.get("zh-CN") or report["id"]
    return str(name)


def load_translations(report: dict) -> list[dict]:
    relative = (report.get("translations") or {}).get("en")
    if not relative:
        raise ValueError(f"Report {report['id']} has no English sidecar")
    path = ROOT / relative
    if not path.is_file():
        raise FileNotFoundError(f"Missing English sidecar: {relative}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    units = payload.get("units")
    if not isinstance(units, list):
        raise ValueError(f"English sidecar has invalid units: {relative}")
    blank = [unit.get("id", "unknown") for unit in units if not str(unit.get("target", "")).strip()]
    if blank:
        raise ValueError(f"English sidecar has {len(blank)} blank translations: {relative}")
    return units


def main() -> None:
    reports = json.loads(REPORTS_FILE.read_text(encoding="utf-8"))
    if not isinstance(reports, list) or not reports:
        raise ValueError("reports.json must contain a non-empty array")

    required_fields = {"id", "name", "date", "file"}
    seen_ids: set[str] = set()
    seen_files: set[str] = set()
    for index, report in enumerate(reports):
        missing_fields = required_fields - set(report)
        if missing_fields:
            raise ValueError(f"Report {index} is missing fields: {sorted(missing_fields)}")
        if report["id"] in seen_ids:
            raise ValueError(f"Duplicate report id: {report['id']}")
        if report["file"] in seen_files:
            raise ValueError(f"Duplicate report file: {report['file']}")
        seen_ids.add(report["id"])
        seen_files.add(report["file"])

    published_files = {
        path.relative_to(ROOT).as_posix()
        for path in (ROOT / "Stakeholder").rglob("*.html")
    }
    unregistered = sorted(published_files - seen_files)
    unknown = sorted(seen_files - published_files)
    if unregistered:
        raise ValueError(f"Unregistered stakeholder reports: {unregistered}")
    if unknown:
        raise FileNotFoundError(f"Registered reports are missing: {unknown}")

    source_versions: dict[str, str] = {}
    for report in reports:
        path = ROOT / report["file"]
        if not path.is_file():
            raise FileNotFoundError(f"Missing report: {report['file']}")

        blocks = parse_report(path)
        if not blocks:
            raise ValueError(f"No report context extracted from {report['file']}")

        canonical = "\n".join(
            f"{block['section']}\t{block['type']}\t{block['text']}" for block in blocks
        )
        version = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
        source_versions[report["id"]] = version

    generated_reports: dict[str, list[dict]] = {}
    for locale, (context_file, index_file) in OUTPUTS.items():
        translations_by_file = {
            report["file"]: load_translations(report) for report in reports
        } if locale == "en" else {}
        output_reports = []
        for report in reports:
            blocks = parse_report(
                ROOT / report["file"], translations_by_file.get(report["file"])
            )
            if not blocks:
                raise ValueError(f"No {locale} report context extracted from {report['file']}")
            output_reports.append(
                {
                    "id": report["id"],
                    "name": localized_name(report, locale),
                    "date": report["date"],
                    "file": report["file"],
                    "version": source_versions[report["id"]],
                    "blocks": blocks,
                }
            )

        payload = {"schemaVersion": 1, "locale": locale, "reports": output_reports}
        generated_reports[locale] = output_reports
        context_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        index_payload = build_report_index(
            output_reports,
            translations_by_file,
            NEGATIVE_STATUS_RE_EN if locale == "en" else NEGATIVE_STATUS_RE,
        )
        index_payload["locale"] = locale
        index_file.write_text(
            json.dumps(index_payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        total_blocks = sum(len(report["blocks"]) for report in output_reports)
        print(
            f"Generated {context_file.name} and {index_file.name}: "
            f"{len(output_reports)} reports, {total_blocks} {locale} evidence blocks"
        )

    chinese = generated_reports["zh-CN"]
    english = generated_reports["en"]
    chinese_contract = [
        (report["id"], report["file"], report["date"], report["version"], [block["id"] for block in report["blocks"]])
        for report in chinese
    ]
    english_contract = [
        (report["id"], report["file"], report["date"], report["version"], [block["id"] for block in report["blocks"]])
        for report in english
    ]
    if chinese_contract != english_contract:
        raise ValueError("Chinese and English report contexts do not share the same canonical IDs and versions")
    print("Verified bilingual context contract: report IDs, block IDs, files, dates, and versions match")


if __name__ == "__main__":
    main()
