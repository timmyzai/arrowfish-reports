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

BLOCK_TAGS = {"p", "li", "summary", "dt", "dd", "blockquote", "pre"}
HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
SKIP_TAGS = {"script", "style", "noscript", "template", "svg"}
SEMANTIC_CLASS = re.compile(
    r"(^|[-_])(tldr|callout|note|metric|titem|ttext|flow-step|update-card|risk-card|kpi|highlight)([-_]|$)",
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


def parse_report(path: Path) -> list[dict]:
    parser = ReportParser()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    return parser.blocks


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
    total_blocks = sum(len(report["blocks"]) for report in output_reports)
    print(f"Generated {OUTPUT_FILE.name}: {len(output_reports)} reports, {total_blocks} evidence blocks")


if __name__ == "__main__":
    main()
