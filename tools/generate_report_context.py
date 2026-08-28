#!/usr/bin/env python3
"""Generate deterministic, citation-ready context from stakeholder HTML reports."""

from __future__ import annotations

import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORTS_FILE = ROOT / "reports.json"
OUTPUT_FILE = ROOT / "report-context.json"
INDEX_OUTPUT_FILE = ROOT / "report-index.json"

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
def normalize_text(value: str) -> str:
    value = value.replace("\xa0", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r"\s*\n\s*", " ", value)
    return re.sub(r"\s{2,}", " ", value).strip()


class ReportParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict] = []
        self.blocks: list[dict] = []
        self.section = "Report overview"
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in SKIP_TAGS:
            self.skip_depth += 1
        self.stack.append(
            {
                "tag": tag,
                "attrs": dict(attrs),
                "parts": [],
                "line": self.getpos()[0],
            }
        )

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self.skip_depth or not data.strip():
            return
        for node in self.stack:
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

        if self.blocks and self.blocks[-1]["text"] == text:
            return

        self.blocks.append(
            {
                "id": f"b{len(self.blocks) + 1:04d}",
                "section": self.section,
                "type": kind,
                "line": node["line"],
                "text": text[:2000],
            }
        )


def class_names(node: dict) -> set[str]:
    return set((node.get("attrs", {}).get("class", "") or "").split())


class ReportIndexParser(HTMLParser):
    """Extract the roadmap and goal registry without introducing a DOM dependency."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict] = []
        self.phases: list[dict] = []
        self.goals: list[dict] = []
        self.workstream_labels: dict[str, str] = {}
        self.status_labels: dict[str, dict[str, str]] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.stack.append(
            {
                "tag": tag.lower(),
                "attrs": dict(attrs),
                "parts": [],
                "fields": {},
            }
        )

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if not data.strip():
            return
        for node in self.stack:
            node["parts"].append(data)

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
        text = normalize_text(" ".join(node["parts"]))
        classes = class_names(node)

        if tag == "h2":
            workstream = self.workstream()
            if workstream:
                label = re.sub(r"\s+(?:2026\s+路线图|目标清单)$", "", text).strip()
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
                        "text": text,
                    }
                )

        if "goal-row" in classes:
            workstream = self.workstream()
            cells = node["fields"].get("cells", [])
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
                        "text": text,
                    }
                )
            else:
                self.goals.append({"unparsed": text})


def parse_report(path: Path) -> list[dict]:
    parser = ReportParser()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    return parser.blocks


def parse_report_index(path: Path) -> tuple[list[dict], list[dict], dict[str, str], dict[str, dict[str, str]]]:
    parser = ReportIndexParser()
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


def build_report_index(output_reports: list[dict]) -> dict:
    workstreams: dict[str, dict] = {}
    unparsed_rows: list[str] = []

    for report in output_reports:
        path = ROOT / report["file"]
        phases, goals, labels, status_labels = parse_report_index(path)
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
                "highlight" if phase["future"] else "li",
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
                or not NEGATIVE_STATUS_RE.search(normalized)
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

    output_reports = []

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
        output_reports.append(
            {
                "id": report["id"],
                "name": report["name"],
                "date": report["date"],
                "file": report["file"],
                "version": version,
                "blocks": blocks,
            }
        )

    payload = {"schemaVersion": 1, "reports": output_reports}
    OUTPUT_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    INDEX_OUTPUT_FILE.write_text(
        json.dumps(build_report_index(output_reports), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    total_blocks = sum(len(report["blocks"]) for report in output_reports)
    print(
        f"Generated {OUTPUT_FILE.name} and {INDEX_OUTPUT_FILE.name}: "
        f"{len(output_reports)} reports, {total_blocks} evidence blocks"
    )


if __name__ == "__main__":
    main()
