#!/usr/bin/env python3
"""Extract, validate, report, and initially seed report translation sidecars."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from collections import defaultdict
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

from generate_report_context import parse_report


ROOT = Path(__file__).resolve().parents[1]
REPORTS_FILE = ROOT / "reports.json"
SIDE_CAR_ROOT = ROOT / "locales" / "en" / "reports"
TRANSLATABLE_ATTRIBUTES = {"aria-label", "title", "placeholder", "content"}
SKIP_TAGS = {"script", "style", "noscript", "template", "svg"}
CJK_RE = re.compile(r"[\u3400-\u9fff]")
SPACE_RE = re.compile(r"\s+")
FACT_RE = re.compile(r"(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)%?")
MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}
NUMBER_WORDS = {
    0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
    6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven",
    12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen", 16: "sixteen",
    17: "seventeen", 18: "eighteen", 19: "nineteen", 20: "twenty",
}
CHINESE_NUMERALS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
ROMAN_NUMERALS = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10}
SOURCE_NEGATIVE_RE = re.compile(
    r"尚未|尚无|从未|并未|仍未|未完成|未启用|未上线|未发布|未验收|未关闭|"
    r"未(?!来)|没有|还没|无任何|无需|无须|不需要|不再|无法|不能|不可用|"
    r"待完成|待验收|待发布|待上线|尚待"
)
TARGET_NEGATIVE_RE = re.compile(
    r"\b(?:not|no|never|cannot|can't|unable|unavailable|pending|incomplete|outstanding|without|"
    r"remains?|awaiting|yet|requires?|to\s+be|lacks?|lacking|missing|failed|failure|zero|avoiding|eliminating|"
    r"unknown|unused|unpaid|non-paying|undecided|unresolved|untested|unverified|unreleased|unsupported|unconfigured|undeployed|unupgradeable|"
    r"unconfirmed|unrecorded|unregistered|unautomated|unfixed|unaddressed|unimplemented|invalidation|"
    r"not\s+started|not\s+included)\b",
    re.IGNORECASE,
)
PRESERVED_TERMS = (
    "Arrowfish", "FFF", "SkyTunnel", "VPN", "Android", "Windows", "macOS", "iOS", "Linux",
    "staging", "Google Play", "App Store", "Google AdMob", "AdMob", "Back Office", "BO", "Shadowsocks", "Singbox", "sing-box",
    "Azure", "Apple", "Flutter", "Kotlin", "Java", "Nginx", "Docker", "Redis", "Rust", "Tauri",
    "Cloudflare", "Samsung", "Swagger", "Groq", "Roy", "Lex", "Morgan", "Amy", "Jianyu", "Roman",
    "Tein", "Siqo", "Reheal",
)
EXACT_GLOSSARY = {
    "状态": "Status",
    "当前状态": "Current Status",
    "风险": "Risk",
    "下一步": "Next Step",
    "说明": "Description",
    "问题": "Issue",
    "影响": "Impact",
    "结果": "Result",
    "负责人": "Owner",
    "优先级": "Priority",
    "已完成": "Completed",
    "已执行": "Implemented",
    "进行中": "In Progress",
    "开发中": "In Development",
    "测试中": "In Testing",
    "未开始": "Not Started",
    "下一阶段": "Next Sprint",
    "当前阶段": "Current Sprint",
    "每台一个进度条": "One Progress Bar per Host",
    "版本迭代": "Version Iterations",
    "目标": "Goal",
    "统一标准": "Unified Standard",
    "规格": "Specification",
    "调用": "Calls",
    "已下线": "Decommissioned",
    "优化中": "Optimization in Progress",
    "决策已定，待执行": "Decision Made, Pending Implementation",
    "同步进行": "In Progress Simultaneously",
    "开发与验证中": "Development and Validation in Progress",
    "待调试": "Pending Debugging",
    "设计中": "In Design",
    "验证中": "In Validation",
    "🔄 进行中": "🔄 In Progress",
    "决策 / 现况": "Decision / Current Situation",
}
AUDIT_ALLOWED_COLLISIONS = {
    "Current Status": {"当前状态", "现状", "目前情况"},
    "Status": {"本阶段状态", "状态"},
}


def normalized(value: str) -> str:
    return SPACE_RE.sub(" ", value.replace("\xa0", " ")).strip()


def fact_tokens(value: str) -> list[str]:
    def scaled(match: re.Match, multiplier: int) -> str:
        number = float(match.group(1).replace(",", "")) * multiplier
        return f" {int(number) if number.is_integer() else number} "

    expanded = re.sub(
        r"第([一二三四五六七八九十])节",
        lambda match: f" Section {CHINESE_NUMERALS[match.group(1)]} ",
        value,
    )
    expanded = re.sub(
        r"^([一二三四五六七八九十])[、.]",
        lambda match: f" {CHINESE_NUMERALS[match.group(1)]}. ",
        expanded,
    )
    expanded = re.sub(
        r"^\s*(X|IX|IV|V?I{1,3})\.",
        lambda match: f" {ROMAN_NUMERALS[match.group(1).upper()]}. ",
        expanded,
        flags=re.IGNORECASE,
    )
    expanded = re.sub(
        r"([一二三四五六七八九])成",
        lambda match: f" {CHINESE_NUMERALS[match.group(1)] * 10}% ",
        expanded,
    )
    expanded = re.sub(r"(\d+(?:\.\d+)?)\s*万", lambda match: scaled(match, 10_000), expanded)
    expanded = re.sub(r"(\d+(?:\.\d+)?)\s*亿", lambda match: scaled(match, 100_000_000), expanded)
    expanded = re.sub(r"(\d+(?:\.\d+)?)\s*(?:million)\b", lambda match: scaled(match, 1_000_000), expanded, flags=re.IGNORECASE)
    expanded = re.sub(r"(\d+(?:\.\d+)?)\s*(?:billion)\b", lambda match: scaled(match, 1_000_000_000), expanded, flags=re.IGNORECASE)
    for month, number in MONTHS.items():
        expanded = re.sub(rf"\b{month}\b", f" {number} ", expanded, flags=re.IGNORECASE)
    output = []
    for token in FACT_RE.findall(expanded):
        suffix = "%" if token.endswith("%") else ""
        core = token.removesuffix("%").replace(",", "")
        if core.isdigit():
            core = str(int(core))
        output.append(core + suffix)
    years = {token for token in output if token.isdigit() and 1900 <= int(token) <= 2100}
    if years:
        output = [token for index, token in enumerate(output) if token not in years or token not in output[:index]]
    return sorted(set(output))


def report_name(report: dict, language: str) -> str:
    value = report.get("name", "")
    if isinstance(value, dict):
        return str(value.get(language) or value.get("zh-CN") or "")
    return str(value)


def unit_key(unit: dict) -> tuple[str, str, str, int]:
    return (
        unit["kind"],
        unit.get("attribute", ""),
        unit["source"],
        int(unit.get("occurrence", 0)),
    )


def unit_id(report_id: str, key: tuple[str, str, str, int]) -> str:
    material = "\0".join((report_id, key[0], key[1], key[2], str(key[3])))
    return "u_" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def target_hash(catalog: dict) -> str:
    material = json.dumps(
        [(unit.get("id", ""), normalized_target(unit.get("target", ""))) for unit in catalog.get("units", [])],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


class VisibleTextParser(HTMLParser):
    def __init__(self, report_id: str, source_lines: list[str] | None = None) -> None:
        super().__init__(convert_charrefs=True)
        self.report_id = report_id
        self.stack: list[dict] = []
        self.skip_depth = 0
        self.units: list[dict] = []
        self.counts: defaultdict[tuple[str, str, str], int] = defaultdict(int)
        self.source_lines = source_lines or []

    def add_unit(self, kind: str, source: str, attribute: str = "") -> None:
        if not source or not CJK_RE.search(source):
            return
        counter_key = (kind, attribute, source)
        occurrence = self.counts[counter_key]
        self.counts[counter_key] += 1
        key = (kind, attribute, source, occurrence)
        current = self.stack[-1] if self.stack else {"tag": "document", "attrs": {}, "line": 1}
        classes = (current["attrs"].get("class") or "").strip().replace(" ", ".")
        line_number = self.getpos()[0] or current["line"]
        context = current["tag"] + (("." + classes) if classes else "") + f" @ line {line_number}"
        if 0 < line_number <= len(self.source_lines):
            line_text = normalized(unescape(re.sub(r"<[^>]+>", " ", self.source_lines[line_number - 1])))
            if line_text and line_text != source:
                context += " · surrounding text: " + line_text[:400]
        unit = {
            "id": unit_id(self.report_id, key),
            "kind": kind,
            "source": source,
            "occurrence": occurrence,
            "target": "",
            "context": context,
        }
        if attribute:
            unit["attribute"] = attribute
        self.units.append(unit)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attributes = dict(attrs)
        if tag in SKIP_TAGS:
            self.skip_depth += 1
        self.stack.append({"tag": tag, "attrs": attributes, "line": self.getpos()[0]})
        if self.skip_depth:
            return
        for name, value in attrs:
            if name in TRANSLATABLE_ATTRIBUTES and value:
                self.add_unit("attribute", value, name)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in SKIP_TAGS:
            self.skip_depth = max(0, self.skip_depth - 1)
        if not self.stack:
            return
        index = len(self.stack) - 1
        while index >= 0 and self.stack[index]["tag"] != tag:
            index -= 1
        self.stack = self.stack[: max(index, 0)]

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        source = data.strip()
        if source:
            self.add_unit("text", source)


def block_catalog(path: Path) -> dict[str, dict]:
    blocks = parse_report(path)
    counts: defaultdict[tuple[str, str], int] = defaultdict(int)
    output = {}
    for block in blocks:
        key = (block["type"], normalized(block["text"]))
        occurrence = counts[key]
        counts[key] += 1
        output[block["id"]] = {
            "type": block["type"],
            "source": key[1],
            "occurrence": occurrence,
        }
    return output


def extract_report(report: dict) -> dict:
    report_id = report["id"]
    source_path = ROOT / report["file"]
    source_html = source_path.read_text(encoding="utf-8")
    parser = VisibleTextParser(report_id, source_html.splitlines())
    parser.feed(source_html)
    parser.close()
    version_material = json.dumps(
        [(unit["kind"], unit.get("attribute", ""), unit["source"], unit["occurrence"]) for unit in parser.units],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return {
        "schemaVersion": 1,
        "reportId": report_id,
        "sourceFile": report["file"],
        "sourceVersion": hashlib.sha256(version_material.encode("utf-8")).hexdigest()[:16],
        "units": parser.units,
        "blocks": block_catalog(source_path),
    }


def sidecar_path(report: dict) -> Path:
    declared = (report.get("translations") or {}).get("en")
    return ROOT / declared if declared else SIDE_CAR_ROOT / f"{report['id']}.json"


def load_reports() -> list[dict]:
    reports = json.loads(REPORTS_FILE.read_text(encoding="utf-8"))
    if not isinstance(reports, list) or not reports:
        raise ValueError("reports.json must contain a non-empty array")
    return reports


def load_sidecar(path: Path) -> dict | None:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def merge_existing(extracted: dict, existing: dict | None) -> dict:
    targets = {unit_key(unit): normalized_target(unit.get("target", "")) for unit in (existing or {}).get("units", [])}
    for unit in extracted["units"]:
        unit["target"] = targets.get(unit_key(unit), "")
    if existing and existing.get("reviewedTargetHash"):
        extracted["reviewedTargetHash"] = existing["reviewedTargetHash"]
    return extracted


def normalized_target(value: object) -> str:
    if isinstance(value, dict):
        return str(value.get("translation") or value.get("target") or value.get("text") or "").strip()
    text = str(value or "").strip()
    if text.startswith("{") and ("'text':" in text or '"text":' in text):
        try:
            parsed = ast.literal_eval(text)
            if isinstance(parsed, dict):
                return str(parsed.get("translation") or parsed.get("target") or parsed.get("text") or "").strip()
        except (SyntaxError, ValueError):
            pass
    return text


def target_error(unit: dict, target_value: object) -> str:
    source = str(unit.get("source", ""))
    target = normalized_target(target_value)
    if not target:
        return "empty target"
    if CJK_RE.search(target):
        return "target contains CJK text"
    glossary_target = EXACT_GLOSSARY.get(source)
    if glossary_target and target != glossary_target:
        return f'target must match glossary value "{glossary_target}"'
    source_length = len(normalized(source))
    target_length = len(target)
    if target_length > max(40, source_length * 7):
        return "target is implausibly long for this source unit"
    if source_length >= 24 and target_length < max(4, source_length // 4):
        return "target is implausibly short for this source unit"
    source_facts = fact_tokens(source)
    target_facts = set(fact_tokens(target))
    lowered_target = target.lower()
    for fact in source_facts:
        if fact.isdigit() and int(fact) in NUMBER_WORDS and re.search(rf"\b{NUMBER_WORDS[int(fact)]}\b", lowered_target):
            target_facts.add(fact)
    if source_facts != sorted(target_facts):
        expected = ", ".join(source_facts) if source_facts else "none (do not add numbers)"
        return "numeric facts changed; preserve these values: " + expected
    if SOURCE_NEGATIVE_RE.search(source) and not TARGET_NEGATIVE_RE.search(target):
        return "negative status was lost"
    node_source = re.sub(r"(?:关键)?时间节点|关键节点|里程碑节点", "", source)
    terminology = (
        ("日总", re.compile(r"\bGeneral Manager Ri\b", re.IGNORECASE), "日总 must be General Manager Ri"),
        ("后台", re.compile(r"\bBack Office(?:\s*\(BO\))?\b", re.IGNORECASE), "后台 must be Back Office (BO)"),
        ("节点" if "节点" in node_source else "", re.compile(r"\bVPN nodes?\b", re.IGNORECASE), "节点 must be VPN node"),
        ("验收", re.compile(r"\bacceptance\b", re.IGNORECASE), "验收 must use acceptance testing"),
        ("收口", re.compile(r"\b(?:closure|stabili[sz]ation)\b", re.IGNORECASE), "收口 must use closure or stabilization"),
    )
    for chinese, pattern, issue in terminology:
        if chinese and chinese in source and not pattern.search(target):
            return issue
    sprint_range = re.search(r"第\s*(\d+)\s*[-–—]\s*(\d+)\s*阶段", source)
    if sprint_range and not re.search(
        rf"\bSprints\s+{re.escape(sprint_range.group(1))}\s*[-–—]\s*{re.escape(sprint_range.group(2))}\b",
        target,
        re.IGNORECASE,
    ):
        return f"第{sprint_range.group(1)}–{sprint_range.group(2)}阶段 must use Sprints {sprint_range.group(1)}–{sprint_range.group(2)}"
    sprint = re.search(r"第\s*(\d+)\s*阶段", source)
    if sprint and not re.search(rf"\bSprint\s+{re.escape(sprint.group(1))}\b", target, re.IGNORECASE):
        return f"第{ sprint.group(1) }阶段 must use Sprint { sprint.group(1) }"
    missing_term = next((term for term in PRESERVED_TERMS if term in source and term not in target), None)
    if missing_term:
        return f"{missing_term} was changed"
    if target.startswith("{") and ("'text':" in target or '"text":' in target):
        return "structured model output leaked into target"
    return ""


def repair_target(unit: dict, target_value: object) -> str:
    source = str(unit.get("source", ""))
    target = normalized_target(target_value)
    for term in PRESERVED_TERMS:
        term_pattern = rf"(?<!\w){re.escape(term)}(?!\w)"
        if term in source and term not in target and re.search(term_pattern, target, re.IGNORECASE):
            target = re.sub(term_pattern, term, target, flags=re.IGNORECASE)
    if "VPN" in source and "VPN" not in target:
        target = re.sub(r"\bvirtual private network\b", "VPN", target, flags=re.IGNORECASE)
        if "后台" not in source and "BO" not in source:
            target = re.sub(r"\bBack Office(?:\s*\(BO\))?\b", "VPN", target, flags=re.IGNORECASE)
    if "BO" in source and "BO" not in target:
        target = re.sub(r"\bBack Office\b(?!\s*\(BO\))", "Back Office (BO)", target, flags=re.IGNORECASE)
    node_source = re.sub(r"(?:关键)?时间节点|关键节点|里程碑节点", "", source)
    if "节点" in node_source and not re.search(r"\bVPN nodes?\b", target, re.IGNORECASE):
        target = re.sub(r"\bnodes\b", "VPN nodes", target, flags=re.IGNORECASE)
        target = re.sub(r"\bnode\b", "VPN node", target, flags=re.IGNORECASE)
    sprint_range = re.search(r"第\s*(\d+)\s*[-–—]\s*(\d+)\s*阶段", source)
    if sprint_range:
        target = re.sub(
            rf"\b(?:Phases?|Stages?|Sprints?)\s+{re.escape(sprint_range.group(1))}\s*[-–—]\s*{re.escape(sprint_range.group(2))}\b",
            f"Sprints {sprint_range.group(1)}–{sprint_range.group(2)}",
            target,
            flags=re.IGNORECASE,
        )
    sprint = re.search(r"第\s*(\d+)\s*阶段", source)
    if sprint:
        target = re.sub(
            rf"\b(?:Phase|Stage)\s+{re.escape(sprint.group(1))}\b",
            f"Sprint {sprint.group(1)}",
            target,
            flags=re.IGNORECASE,
        )
    return target


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def command_extract(_: argparse.Namespace) -> int:
    catalogue_errors = ui_catalog_errors()
    if catalogue_errors:
        raise ValueError("UI catalogue validation failed: " + "; ".join(catalogue_errors))
    total = 0
    reports = load_reports()
    for report in reports:
        path = sidecar_path(report)
        payload = merge_existing(extract_report(report), load_sidecar(path))
        write_json(path, payload)
        total += len(payload["units"])
        print(f"{report['id']}: {len(payload['units'])} units -> {path.relative_to(ROOT)}")
    print(f"Extracted {total} translation units from {len(reports)} reports")
    print("Scanned index.html and shared preference, authentication, copy, and AI UI message usage")
    return 0


def validation_errors(report: dict, extracted: dict, existing: dict | None) -> list[str]:
    errors: list[str] = []
    path = sidecar_path(report)
    if existing is None:
        return [f"{path.relative_to(ROOT)} is missing"]
    if existing.get("schemaVersion") != 1 or existing.get("reportId") != report["id"] or existing.get("sourceFile") != report["file"]:
        errors.append(f"{path.relative_to(ROOT)} has invalid sidecar metadata")
    if existing.get("sourceVersion") != extracted["sourceVersion"]:
        errors.append(f"{path.relative_to(ROOT)} has a stale sourceVersion")
    expected = {unit_key(unit): unit for unit in extracted["units"]}
    actual = {unit_key(unit): unit for unit in existing.get("units", [])}
    if len(actual) != len(existing.get("units", [])):
        errors.append(f"{report['id']} contains conflicting duplicate units")
    missing = expected.keys() - actual.keys()
    stale = actual.keys() - expected.keys()
    if missing:
        errors.append(f"{report['id']} is missing {len(missing)} units")
    if stale:
        errors.append(f"{report['id']} contains {len(stale)} stale units")
    blank = [unit for unit in actual.values() if not str(unit.get("target", "")).strip()]
    if blank:
        errors.append(f"{report['id']} contains {len(blank)} blank translations")
    untranslated = [unit for unit in actual.values() if CJK_RE.search(str(unit.get("target", "")))]
    if untranslated:
        errors.append(f"{report['id']} contains {len(untranslated)} translations with CJK text")
    fact_errors = []
    for unit in actual.values():
        issue = target_error(unit, unit.get("target", ""))
        if issue and issue not in {"empty target", "target contains CJK text"}:
            fact_errors.append(f"{unit.get('id')}: {issue}")
    if fact_errors:
        errors.append(f"{report['id']} contains {len(fact_errors)} factual translation errors (first: {fact_errors[0]})")
    if existing.get("blocks") != extracted.get("blocks"):
        errors.append(f"{report['id']} has stale block locators")
    reviewed_hash = existing.get("reviewedTargetHash")
    current_hash = target_hash(existing)
    if reviewed_hash != current_hash:
        errors.append(
            f"{report['id']} targets require human review "
            f"(reviewedTargetHash must be {current_hash})"
        )
    source_html = (ROOT / report["file"]).read_text(encoding="utf-8")
    required_markup = {
        f'data-report-id="{report["id"]}"': "report ID",
        "assets/ui-i18n.js": "shared UI catalogue",
        "assets/site-preferences.js": "shared preferences runtime",
        "assets/site-theme.css": "shared theme",
        "data-report-header": "semantic report header",
    }
    for marker, label in required_markup.items():
        if marker not in source_html:
            errors.append(f"{report['id']} is missing its {label} wiring")
    svg_text = re.findall(r"<text\b[^>]*>([\s\S]*?)</text>", source_html, flags=re.IGNORECASE)
    if any(CJK_RE.search(re.sub(r"<[^>]+>", "", value)) for value in svg_text):
        errors.append(f"{report['id']} contains translatable SVG <text>, which is not supported")
    return errors


def ui_catalog_errors() -> list[str]:
    path = ROOT / "assets" / "ui-i18n.js"
    if not path.is_file():
        return ["assets/ui-i18n.js is missing"]
    source = path.read_text(encoding="utf-8")
    try:
        chinese, english = source.split("    en: {", 1)
    except ValueError:
        return ["assets/ui-i18n.js does not contain the English catalogue"]
    key_re = re.compile(r"^\s*'([^']+)'\s*:\s*'(.+)'[,]?$", re.MULTILINE)
    zh_entries = dict(key_re.findall(chinese.split("'zh-CN': {", 1)[-1]))
    en_entries = dict(key_re.findall(english))
    errors = []
    for key in sorted(zh_entries.keys() - en_entries.keys()):
        errors.append(f"UI catalogue English is missing {key}")
    for key in sorted(en_entries.keys() - zh_entries.keys()):
        errors.append(f"UI catalogue Chinese is missing {key}")
    placeholder_re = re.compile(r"\{([a-zA-Z0-9_]+)\}")
    for key in sorted(zh_entries.keys() & en_entries.keys()):
        if set(placeholder_re.findall(zh_entries[key])) != set(placeholder_re.findall(en_entries[key])):
            errors.append(f"UI catalogue placeholder mismatch for {key}")
    if any(not value.strip() for value in zh_entries.values()) or any(not value.strip() for value in en_entries.values()):
        errors.append("UI catalogue contains an empty message")
    if not zh_entries:
        errors.append("UI catalogue contains no messages")
    shell_parser = VisibleTextParser("site-shell")
    shell_parser.feed((ROOT / "index.html").read_text(encoding="utf-8"))
    shell_parser.close()
    catalogue_values = set(zh_entries.values())
    for unit in shell_parser.units:
        if unit["source"] not in catalogue_values:
            errors.append(f"index.html contains unregistered visible UI text: {unit['source']}")
    usage_files = [
        ROOT / "index.html",
        ROOT / "assets" / "site-preferences.js",
        ROOT / "assets" / "auth-gate.js",
        ROOT / "assets" / "copy-markdown.js",
        ROOT / "assets" / "ai-chat.js",
    ] + list((ROOT / "Stakeholder").rglob("*.html"))
    known = set(zh_entries)
    call_re = re.compile(r"\b(t|tn|tr)\(\s*['\"]([^'\"]+)['\"]")
    for usage_path in usage_files:
        usage_source = usage_path.read_text(encoding="utf-8")
        for function, key in call_re.findall(usage_source):
            if key.endswith("."):
                continue
            expected = {f"{key}.one", f"{key}.other"} if function == "tn" else {key}
            for missing in sorted(expected - known):
                errors.append(f"{usage_path.relative_to(ROOT)} uses missing UI message {missing}")
    return errors


def command_validate(_: argparse.Namespace) -> int:
    errors: list[str] = ui_catalog_errors()
    seen_files = set()
    for report in load_reports():
        if not isinstance(report.get("name"), dict) or not report["name"].get("zh-CN") or not report["name"].get("en"):
            errors.append(f"{report['id']} must have localized zh-CN and en names")
        declared = (report.get("translations") or {}).get("en")
        if not declared:
            errors.append(f"{report['id']} has no English sidecar declaration")
        if report["file"] in seen_files:
            errors.append(f"duplicate report file: {report['file']}")
        seen_files.add(report["file"])
        extracted = extract_report(report)
        errors.extend(validation_errors(report, extracted, load_sidecar(sidecar_path(report))))
    registered = {report["file"] for report in load_reports()}
    published = {path.relative_to(ROOT).as_posix() for path in (ROOT / "Stakeholder").rglob("*.html")}
    for path in sorted(published - registered):
        errors.append(f"unregistered report: {path}")
    if errors:
        print("Translation validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"Translation validation passed: {len(registered)} reports are complete")
    return 0


def command_stats(_: argparse.Namespace) -> int:
    total = complete = changed_total = stale_total = outdated_total = 0
    print(f"{'REPORT':<34} {'COMPLETE':>13} {'RATE':>8} {'NEW':>6} {'STALE':>7} {'OUTDATED':>9}")
    for report in load_reports():
        sidecar = load_sidecar(sidecar_path(report)) or {"units": []}
        extracted = extract_report(report)
        count = len(sidecar["units"])
        done = sum(not target_error(unit, unit.get("target", "")) for unit in sidecar["units"])
        expected_keys = {unit_key(unit) for unit in extracted["units"]}
        actual_keys = {unit_key(unit) for unit in sidecar["units"]}
        changed = len(expected_keys - actual_keys)
        stale = len(actual_keys - expected_keys)
        outdated = int(sidecar.get("sourceVersion") != extracted["sourceVersion"])
        total += count
        complete += done
        changed_total += changed
        stale_total += stale
        outdated_total += outdated
        percent = 100 if not count else done * 100 / count
        print(f"{report['id']:<34} {done:>4}/{count:<4} {percent:7.2f}% {changed:>6} {stale:>7} {outdated:>9}")
    percent = 100 if not total else complete * 100 / total
    print(f"{'TOTAL':<34} {complete:>4}/{total:<4} {percent:7.2f}% {changed_total:>6} {stale_total:>7} {outdated_total:>9}")
    return 0


def command_repair(_: argparse.Namespace) -> int:
    changed_units = 0
    changed_reports = 0
    for report in load_reports():
        path = sidecar_path(report)
        payload = merge_existing(extract_report(report), load_sidecar(path))
        report_changes = 0
        for unit in payload["units"]:
            preferred = EXACT_GLOSSARY.get(unit["source"])
            if preferred and normalized_target(unit.get("target", "")) != preferred:
                unit["target"] = preferred
                report_changes += 1
        if report_changes:
            payload.pop("reviewedTargetHash", None)
            write_json(path, payload)
            changed_reports += 1
            changed_units += report_changes
            print(f"{report['id']}: repaired {report_changes} glossary targets")
    print(f"Repaired {changed_units} glossary targets in {changed_reports} reports")
    return 0


def command_audit(_: argparse.Namespace) -> int:
    by_target: defaultdict[str, set[str]] = defaultdict(set)
    locations: defaultdict[str, list[str]] = defaultdict(list)
    for report in load_reports():
        payload = load_sidecar(sidecar_path(report)) or {"units": []}
        for unit in payload.get("units", []):
            source = normalized(unit.get("source", ""))
            target = normalized_target(unit.get("target", ""))
            if not source or not target or len(source) > 16 or len(target) > 48:
                continue
            by_target[target].add(source)
            locations[target].append(f"{report['id']}:{unit.get('id', 'unknown')}")
    suspicious = [
        (target, sorted(sources), locations[target])
        for target, sources in by_target.items()
        if len(sources) >= 3 and sources != AUDIT_ALLOWED_COLLISIONS.get(target, set())
    ]
    suspicious.sort(key=lambda item: (-len(item[1]), item[0].lower()))
    if not suspicious:
        print("Translation collision audit found no suspicious short-target collisions")
        return 0
    print("Suspicious short-target collisions (review context before changing):")
    for target, sources, target_locations in suspicious:
        print(f"- {target!r} <- {', '.join(repr(source) for source in sources)}")
        print(f"  units: {', '.join(target_locations[:8])}")
    print(f"Audit reported {len(suspicious)} candidate collisions")
    return 0


def command_review(args: argparse.Namespace) -> int:
    reports = load_reports()
    if args.report_id:
        reports = [report for report in reports if report["id"] == args.report_id]
        if not reports:
            raise ValueError(f"Unknown report ID: {args.report_id}")
    for report in reports:
        path = sidecar_path(report)
        payload = load_sidecar(path)
        if payload is None:
            raise FileNotFoundError(f"Missing English sidecar: {path.relative_to(ROOT)}")
        payload["reviewedTargetHash"] = target_hash(payload)
        errors = validation_errors(report, extract_report(report), payload)
        if errors:
            raise ValueError("; ".join(errors))
        write_json(path, payload)
        print(f"{report['id']}: recorded reviewed target hash {payload['reviewedTargetHash']}")
    return 0


def command_wire(_: argparse.Namespace) -> int:
    """Wire the shared preference assets into every registered report."""
    for report in load_reports():
        path = ROOT / report["file"]
        source = path.read_text(encoding="utf-8")
        updated = re.sub(
            r"<html(?![^>]*\bdata-report-id=)([^>]*)>",
            rf'<html\1 data-report-id="{report["id"]}">',
            source,
            count=1,
            flags=re.IGNORECASE,
        )
        preference_assets = (
            '  <script src="../../assets/ui-i18n.js"></script>\n'
            '  <script src="../../assets/site-preferences.js"></script>\n'
        )
        if "../../assets/site-preferences.js" not in updated:
            viewport = re.search(r"<meta\s+name=[\"']viewport[\"'][^>]*>\s*", updated, re.IGNORECASE)
            if viewport:
                updated = updated[:viewport.end()] + "\n" + preference_assets + updated[viewport.end():]
            else:
                updated = updated.replace("<head>", "<head>\n" + preference_assets, 1)
        if "../../assets/site-theme.css" not in updated:
            updated = updated.replace(
                "</head>",
                '  <link rel="stylesheet" href="../../assets/site-theme.css">\n</head>',
                1,
            )
        if "data-report-header" not in updated:
            if re.search(r"<header\b", updated, re.IGNORECASE):
                updated = re.sub(r"<header(\s|>)", r"<header data-report-header\1", updated, count=1, flags=re.IGNORECASE)
            elif re.search(r'<div\s+class=["\']report-header["\']', updated, re.IGNORECASE):
                updated = re.sub(
                    r'(<div\s+class=["\']report-header["\'])',
                    r"\1 data-report-header",
                    updated,
                    count=1,
                    flags=re.IGNORECASE,
                )
            elif re.search(r'<nav\s+class=["\']page-nav["\']', updated, re.IGNORECASE):
                updated = re.sub(
                    r'(<nav\s+class=["\']page-nav["\'])',
                    r"\1 data-report-header",
                    updated,
                    count=1,
                    flags=re.IGNORECASE,
                )
            else:
                heading = re.search(
                    r"(?P<indent>^[ \t]*)(?P<h1><h1\b[\s\S]*?</h1>)(?P<after>\s*)(?P<subtitle><div\s+class=[\"']subtitle[\"'][\s\S]*?</div>)?",
                    updated,
                    re.IGNORECASE | re.MULTILINE,
                )
                if heading:
                    indent = heading.group("indent")
                    h1 = heading.group("h1")
                    subtitle = heading.group("subtitle") or ""
                    replacement = (
                        f'{indent}<header class="standalone-report-header" data-report-header>\n'
                        f'{indent}  {h1}\n'
                        + (f'{indent}  {subtitle}\n' if subtitle else "")
                        + f"{indent}</header>"
                    )
                    updated = updated[:heading.start()] + replacement + updated[heading.end():]
        if updated != source:
            path.write_text(updated, encoding="utf-8")
            print(f"wired {report['file']}")
    return 0


def ollama_translate(batch: list[dict], model: str, correction: str = "") -> dict[str, str]:
    inputs = {
        unit["id"]: {"text": unit["source"], "context": unit.get("context", "")}
        for unit in batch
    }
    prompt = (
        "Translate the text field of every value in the JSON object from Simplified Chinese into concise, natural, professional "
        "international business English. This is an engineering stakeholder report. Preserve every number, date, "
        "percentage, currency, version, product name, personal name, code identifier, HTML entity and factual status. "
        "Translate 阶段 as Sprint when it has a number; 后台 as Back Office (BO); 节点 as VPN node; 验收 as acceptance "
        "testing; 日总 as General Manager Ri; 上线 as release or go live according to context; 收口 as closure or "
        "stabilization. Preserve negative "
        "meaning exactly. The English target must contain no Chinese Han characters; transliterate a Chinese personal name when "
        "necessary while preserving the person's identity. The context field is only a translation hint. Return only a JSON "
        "object with the exact same keys and "
        "translated string values; never omit duplicate or very short entries.\n\n" +
        (("CORRECTION REQUIRED: " + correction + ".\n\n") if correction else "") +
        json.dumps(inputs, ensure_ascii=False)
    )
    body = json.dumps({
        "model": model,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 3500},
        "messages": [
            {"role": "system", "content": "You are a meticulous professional Chinese-to-English translator."},
            {"role": "user", "content": prompt},
        ],
    }).encode("utf-8")
    request = urllib.request.Request("http://127.0.0.1:11434/api/chat", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = json.load(response)
    content = payload.get("message", {}).get("content", "")
    translated = json.loads(content)
    if not isinstance(translated, dict):
        raise ValueError("Ollama returned a non-object translation")
    return {str(key): normalized_target(value) for key, value in translated.items()}


def translation_batches(units: list[dict], max_units: int, max_chars: int) -> list[list[dict]]:
    batches: list[list[dict]] = []
    current: list[dict] = []
    chars = 0
    for unit in units:
        length = len(unit["source"])
        if current and (len(current) >= max_units or chars + length > max_chars):
            batches.append(current)
            current = []
            chars = 0
        current.append(unit)
        chars += length
    if current:
        batches.append(current)
    return batches


def command_translate(args: argparse.Namespace) -> int:
    reports = load_reports()
    if args.report_id:
        reports = [report for report in reports if report["id"] == args.report_id]
        if not reports:
            raise ValueError(f"Unknown report ID: {args.report_id}")
    elif args.start_at:
        start = next((index for index, report in enumerate(reports) if report["id"] == args.start_at), None)
        if start is None:
            raise ValueError(f"Unknown start report ID: {args.start_at}")
        reports = reports[start:]
    if args.force:
        for report in reports:
            path = sidecar_path(report)
            payload = merge_existing(extract_report(report), load_sidecar(path))
            for unit in payload["units"]:
                unit["target"] = ""
            write_json(path, payload)
        print(f"Cleared existing targets in {len(reports)} reports for a full replacement pass")

    for report in reports:
        path = sidecar_path(report)
        payload = merge_existing(extract_report(report), load_sidecar(path))
        for unit in payload["units"]:
            unit["target"] = repair_target(unit, unit.get("target", ""))
        write_json(path, payload)
        pending = [
            unit for unit in payload["units"]
            if target_error(unit, unit.get("target", ""))
        ]
        batches = translation_batches(pending, args.batch_size, args.batch_chars)
        print(f"{report['id']}: translating {len(pending)} units in {len(batches)} batches")
        for index, batch in enumerate(batches, 1):
            for attempt in range(1, 4):
                try:
                    translated = ollama_translate(batch, args.model)
                    for unit in batch:
                        if unit["id"] in translated:
                            unit["target"] = repair_target(unit, translated[unit["id"]])
                    missing_units = [unit for unit in batch if target_error(unit, unit.get("target", ""))]
                    if args.draft:
                        for missing_unit in missing_units:
                            print(f"    draft retained {missing_unit['id']}: {target_error(missing_unit, missing_unit.get('target', ''))}")
                    else:
                        for missing_unit in missing_units:
                            for unit_attempt in range(1, 3):
                                try:
                                    correction = target_error(missing_unit, missing_unit.get("target", ""))
                                    single = ollama_translate([missing_unit], args.model, correction)
                                    target = repair_target(missing_unit, single.get(missing_unit["id"], ""))
                                    issue = target_error(missing_unit, target)
                                    if issue:
                                        missing_unit["target"] = target
                                        raise ValueError(f"{missing_unit['id']}: {issue}")
                                    missing_unit["target"] = target
                                    break
                                except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
                                    if unit_attempt == 2:
                                        print(f"    retained {missing_unit['id']} for review: {target_error(missing_unit, missing_unit.get('target', ''))}")
                                        break
                                    time.sleep(unit_attempt)
                    write_json(path, payload)
                    print(f"  batch {index}/{len(batches)} complete")
                    break
                except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as error:
                    if args.draft:
                        print(f"  batch {index} malformed ({error}); retrying in small draft groups")
                        for small_batch in translation_batches(batch, 8, 800):
                            try:
                                translated = ollama_translate(small_batch, args.model)
                                for unit in small_batch:
                                    if unit["id"] in translated:
                                        unit["target"] = repair_target(unit, translated[unit["id"]])
                            except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as small_error:
                                print(f"    draft group retained for strict repair: {small_error}")
                        write_json(path, payload)
                        print(f"  batch {index}/{len(batches)} complete (draft split)")
                        break
                    if attempt == 3:
                        print(f"  batch {index} remained malformed; translating its units individually")
                        for unit in batch:
                            if not target_error(unit, unit.get("target", "")):
                                continue
                            for unit_attempt in range(1, 3):
                                try:
                                    correction = target_error(unit, unit.get("target", ""))
                                    single = ollama_translate([unit], args.model, correction)
                                    target = repair_target(unit, single.get(unit["id"], "").strip())
                                    issue = target_error(unit, target)
                                    if issue:
                                        unit["target"] = target
                                        raise ValueError(f"{unit['id']}: {issue}")
                                    unit["target"] = target
                                    write_json(path, payload)
                                    break
                                except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
                                    if unit_attempt == 2:
                                        print(f"    retained {unit['id']} for review: {target_error(unit, unit.get('target', ''))}")
                                        break
                                    time.sleep(unit_attempt)
                        write_json(path, payload)
                        print(f"  batch {index}/{len(batches)} complete (individual fallback)")
                        break
                    print(f"  batch {index} attempt {attempt} failed: {error}; retrying")
                    time.sleep(attempt)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("extract").set_defaults(handler=command_extract)
    subparsers.add_parser("validate").set_defaults(handler=command_validate)
    subparsers.add_parser("stats").set_defaults(handler=command_stats)
    subparsers.add_parser("repair", help="Apply the enforced exact glossary").set_defaults(handler=command_repair)
    subparsers.add_parser("audit", help="Report suspicious short translation collisions").set_defaults(handler=command_audit)
    review = subparsers.add_parser("review", help="Record that current targets passed human review")
    review.add_argument("--report-id", help="Review only the matching registered report ID")
    review.set_defaults(handler=command_review)
    subparsers.add_parser("wire").set_defaults(handler=command_wire)
    translate = subparsers.add_parser("translate", help="Seed blank targets using a local Ollama model")
    translate.add_argument("--model", default="qwen2.5:7b")
    translate.add_argument("--batch-size", type=int, default=16)
    translate.add_argument("--batch-chars", type=int, default=2400)
    translate.add_argument("--force", action="store_true", help="Replace every existing target")
    translate.add_argument(
        "--draft",
        action="store_true",
        help="Keep invalid batch results for a fast first pass; rerun without this flag for strict repair",
    )
    translate.add_argument("--report-id", help="Translate only the matching registered report ID")
    translate.add_argument("--start-at", help="Resume at this registered report ID and continue in catalogue order")
    translate.set_defaults(handler=command_translate)
    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
