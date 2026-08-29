#!/usr/bin/env python3
"""Build the deploy-only bilingual static site."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path

from i18n_catalog import (
    CJK_RE,
    ROOT,
    SKIP_TAGS,
    TRANSLATABLE_ATTRIBUTES,
    load_reports,
    load_sidecar,
    normalized,
    normalized_target,
    sidecar_path,
    unit_key,
)


DEFAULT_OUTPUT = ROOT / "_site"
LOCALES = ("zh-CN", "en")
BLOCK_TAGS = {
    "p": "p",
    "li": "li",
    "tr": "table-row",
    "summary": "details-summary",
    "dt": "dt",
    "dd": "dd",
    "blockquote": "blockquote",
    "pre": "pre",
    "div": "highlight",
    "article": "highlight",
    "h1": "heading",
    "h2": "heading",
    "h3": "heading",
    "h4": "heading",
    "h5": "heading",
    "h6": "heading",
}
RAW_TEXT_TAGS = {"script", "style"}
TEXT_ASSET_SUFFIXES = {".css", ".js", ".svg"}
UI_ENTRY_RE = re.compile(r"^\s*'([^']+)'\s*:\s*'(.+)'[,]?$", re.MULTILINE)
ASSET_REFERENCE_RE = re.compile(r"(?P<prefix>(?:\.\./)*assets/)(?P<name>[A-Za-z0-9_.-]+)(?:\?[^\"'<>\s]*)?")


def short_hash(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()[:12]


def gzip_size(value: bytes | str) -> int:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return len(gzip.compress(value, compresslevel=9))


def locator_text(value: str) -> str:
    return re.sub(r"\s+", "", normalized(value))


def load_ui_messages() -> dict[str, dict[str, str]]:
    source = (ROOT / "assets" / "ui-i18n.js").read_text(encoding="utf-8")
    chinese, english = source.split("    en: {", 1)
    zh_entries = dict(UI_ENTRY_RE.findall(chinese.split("'zh-CN': {", 1)[-1]))
    en_entries = dict(UI_ENTRY_RE.findall(english))
    return {"zh-CN": zh_entries, "en": en_entries}


class BlockMarker(HTMLParser):
    """Find report block start tags while preserving the original source text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict] = []
        self.matches: defaultdict[tuple[str, str], list[tuple[int, int]]] = defaultdict(list)
        self.line_offsets: list[int] = [0]

    def configure_source(self, source: str) -> None:
        self.line_offsets = [0]
        for match in re.finditer(r"\n", source):
            self.line_offsets.append(match.end())

    def absolute_offset(self) -> int:
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        raw = self.get_starttag_text() or ""
        node = {
            "tag": tag.lower(),
            "attrs": dict(attrs),
            "text": [],
            "start": self.absolute_offset(),
            "insert": self.absolute_offset() + max(0, len(raw) - 1),
        }
        self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self._finish(len(self.stack) - 1)

    def handle_data(self, data: str) -> None:
        if any(node["tag"] in {"script", "style", "noscript", "template"} for node in self.stack):
            return
        for node in self.stack:
            node["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        index = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i]["tag"] == tag), -1)
        if index >= 0:
            self._finish(index)

    def _finish(self, index: int) -> None:
        nodes = self.stack[index:]
        self.stack = self.stack[:index]
        for node in reversed(nodes):
            block_type = BLOCK_TAGS.get(node["tag"])
            if not block_type or "data-report-block-id" in node["attrs"]:
                continue
            text = normalized("".join(node["text"]))
            if text:
                self.matches[(block_type, locator_text(text))].append((node["start"], node["insert"]))


def annotate_blocks(source: str, blocks: dict[str, dict]) -> str:
    if not blocks:
        return source
    parser = BlockMarker()
    parser.configure_source(source)
    parser.feed(source)
    parser.close()
    patches: list[tuple[int, str]] = []
    for block_id, block in blocks.items():
        matches = sorted(parser.matches.get((block["type"], locator_text(block["source"])), []))
        occurrence = int(block.get("occurrence", 0))
        if occurrence >= len(matches):
            raise ValueError(f"Unable to locate evidence block {block_id}")
        patches.append((matches[occurrence][1], f' data-report-block-id="{block_id}"'))
    for offset, insertion in sorted(patches, reverse=True):
        source = source[:offset] + insertion + source[offset:]
    return source


class LocalizedHTMLRenderer(HTMLParser):
    def __init__(
        self,
        locale: str,
        unit_targets: dict[tuple[str, str, str, int], str] | None = None,
        ui_targets: dict[str, str] | None = None,
        source_version: str = "",
    ) -> None:
        super().__init__(convert_charrefs=True)
        self.locale = locale
        self.unit_targets = unit_targets or {}
        self.ui_targets = ui_targets or {}
        self.source_version = source_version
        self.output: list[str] = []
        self.stack: list[str] = []
        self.skip_depth = 0
        self.text_counts: defaultdict[str, int] = defaultdict(int)
        self.attribute_counts: defaultdict[tuple[str, str], int] = defaultdict(int)

    def render_attrs(self, tag: str, attrs: list[tuple[str, str | None]], skipped: bool) -> str:
        rendered = []
        seen_locale = False
        seen_version = False
        for name, value in attrs:
            if tag == "html" and name in {"lang", "data-locale", "data-language"}:
                value = self.locale
                seen_locale = seen_locale or name == "data-locale"
            if tag == "html" and name == "data-source-version":
                value = self.source_version
                seen_version = True
            if value is not None and not skipped and name in TRANSLATABLE_ATTRIBUTES and CJK_RE.search(value):
                source = value.strip()
                key = (name, source)
                occurrence = self.attribute_counts[key]
                self.attribute_counts[key] += 1
                target = self.translate("attribute", source, occurrence, name)
                leading = value[: len(value) - len(value.lstrip())]
                trailing = value[len(value.rstrip()):]
                value = leading + target + trailing
            if value is None:
                rendered.append(name)
            else:
                rendered.append(f'{name}="{html.escape(value, quote=True)}"')
        if tag == "html":
            if not seen_locale:
                rendered.append(f'data-locale="{self.locale}"')
            if self.source_version and not seen_version:
                rendered.append(f'data-source-version="{self.source_version}"')
        return (" " + " ".join(rendered)) if rendered else ""

    def translate(self, kind: str, source: str, occurrence: int, attribute: str = "") -> str:
        if self.locale == "zh-CN":
            return source
        if self.ui_targets and source in self.ui_targets:
            return self.ui_targets[source]
        key = (kind, attribute, source, occurrence)
        if key not in self.unit_targets:
            raise ValueError(f"Missing {self.locale} translation for {key}")
        return self.unit_targets[key]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        skipped = self.skip_depth > 0 or tag in SKIP_TAGS
        self.output.append(f"<{tag}{self.render_attrs(tag, attrs, skipped)}>")
        self.stack.append(tag)
        if tag in SKIP_TAGS:
            self.skip_depth += 1

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        skipped = self.skip_depth > 0 or tag in SKIP_TAGS
        self.output.append(f"<{tag}{self.render_attrs(tag, attrs, skipped)} />")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        self.output.append(f"</{tag}>")
        if tag in SKIP_TAGS:
            self.skip_depth = max(0, self.skip_depth - 1)
        if self.stack:
            index = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i] == tag), -1)
            if index >= 0:
                self.stack = self.stack[:index]

    def handle_data(self, data: str) -> None:
        if self.skip_depth or (self.stack and self.stack[-1] in RAW_TEXT_TAGS):
            self.output.append(data)
            return
        source = data.strip()
        if source and CJK_RE.search(source):
            occurrence = self.text_counts[source]
            self.text_counts[source] += 1
            target = self.translate("text", source, occurrence)
            leading = data[: len(data) - len(data.lstrip())]
            trailing = data[len(data.rstrip()):]
            data = leading + target + trailing
        self.output.append(html.escape(data, quote=False))

    def handle_comment(self, data: str) -> None:
        self.output.append(f"<!--{data}-->")

    def handle_decl(self, decl: str) -> None:
        self.output.append(f"<!{decl}>")

    def handle_pi(self, data: str) -> None:
        self.output.append(f"<?{data}>")

    def unknown_decl(self, data: str) -> None:
        self.output.append(f"<![{data}]>")

    def html(self) -> str:
        return "".join(self.output)


def render_html(
    source: str,
    locale: str,
    units: list[dict] | None = None,
    ui_targets: dict[str, str] | None = None,
    source_version: str = "",
) -> str:
    targets = {unit_key(unit): normalized_target(unit["target"]) for unit in units or []}
    renderer = LocalizedHTMLRenderer(locale, targets, ui_targets, source_version)
    renderer.feed(source)
    renderer.close()
    return renderer.html()


def asset_filename(path: Path, content: bytes) -> str:
    return f"{path.stem}.{short_hash(content)}{path.suffix}"


def build_assets(data_versions: dict[str, str]) -> tuple[dict[str, str], dict[str, bytes]]:
    asset_paths = sorted(path for path in (ROOT / "assets").iterdir() if path.is_file())
    originals = {path.name: path.read_bytes() for path in asset_paths}
    output: dict[str, bytes] = {}
    names: dict[str, str] = {}

    icon_name = "ai-chatbot-icon.svg"
    icon_content = originals[icon_name]
    names[icon_name] = asset_filename(Path(icon_name), icon_content)
    output[names[icon_name]] = icon_content

    for original_name, original_content in originals.items():
        if original_name == icon_name:
            continue
        content = original_content
        if Path(original_name).suffix in TEXT_ASSET_SUFFIXES:
            text = content.decode("utf-8")
            text = text.replace(f"assets/{icon_name}", f"assets/{names[icon_name]}")
            if original_name == "ai-chat.js":
                for filename, version in data_versions.items():
                    text = text.replace(f"'{filename}'", f"'{filename}?v={version}'")
            content = text.encode("utf-8")
        hashed_name = asset_filename(Path(original_name), content)
        names[original_name] = hashed_name
        output[hashed_name] = content
    return names, output


def rewrite_asset_references(source: str, asset_names: dict[str, str]) -> str:
    def replace(match: re.Match) -> str:
        name = match.group("name")
        return match.group("prefix") + asset_names.get(name, name)

    return ASSET_REFERENCE_RE.sub(replace, source)


def locale_router() -> str:
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Arrowfish VPN</title>
  <script>
  (function () {
    var language = '';
    try {
      var saved = JSON.parse(localStorage.getItem('arrowfish_preferences_v1') || '{}');
      if (saved.language === 'en' || saved.language === 'zh-CN') language = saved.language;
    } catch (error) {}
    if (!language) {
      var values = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
      for (var index = 0; index < values.length; index += 1) {
        var value = String(values[index] || '').toLowerCase();
        if (value === 'en' || value.indexOf('en-') === 0) { language = 'en'; break; }
        if (value === 'zh' || value === 'zh-cn' || value === 'zh-sg' || value === 'zh-hans' || value.indexOf('zh-hans-') === 0) { language = 'zh-CN'; break; }
      }
    }
    language = language || 'zh-CN';
    var target = new URL(language + '/', location.href);
    target.search = location.search;
    target.hash = location.hash;
    location.replace(target.href);
  })();
  </script>
</head>
<body><p><a href="zh-CN/">简体中文</a> · <a href="en/">English</a></p></body>
</html>
"""


def legacy_report_router(report: dict) -> str:
    relative_target = report["file"]
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Arrowfish VPN</title>
<script>(function(){{var l='zh-CN';try{{var p=JSON.parse(localStorage.getItem('arrowfish_preferences_v1')||'{{}}');if(p.language==='en'||p.language==='zh-CN')l=p.language;}}catch(e){{}}var u=new URL('../../'+l+'/{relative_target}',location.href);u.search=location.search;u.hash=location.hash;location.replace(u.href);}})();</script>
</head><body></body></html>"""


def visible_cjk(source: str) -> list[str]:
    class VisibleParser(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self.skip = 0
            self.values: list[str] = []

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            if tag.lower() in SKIP_TAGS:
                self.skip += 1
            if self.skip:
                return
            for name, value in attrs:
                if name in TRANSLATABLE_ATTRIBUTES and value and CJK_RE.search(value):
                    self.values.append(value)

        def handle_endtag(self, tag: str) -> None:
            if tag.lower() in SKIP_TAGS:
                self.skip = max(0, self.skip - 1)

        def handle_data(self, data: str) -> None:
            if not self.skip and CJK_RE.search(data):
                self.values.append(normalized(data))

    parser = VisibleParser()
    parser.feed(source)
    parser.close()
    return [value for value in parser.values if value]


def build(output: Path) -> None:
    subprocess.run([sys.executable, str(ROOT / "tools" / "i18n_catalog.py"), "validate"], check=True)
    reports = load_reports()
    ui_messages = load_ui_messages()
    ui_targets = {
        source: ui_messages["en"][key]
        for key, source in ui_messages["zh-CN"].items()
        if key in ui_messages["en"]
    }

    requested_output = output.absolute()
    if requested_output != DEFAULT_OUTPUT.absolute() or output.is_symlink():
        raise ValueError("Build output must be the repository's non-symlink _site directory")
    output = output.resolve()
    if output == ROOT or ROOT not in output.parents:
        raise ValueError("Build output must be a dedicated directory below the repository root")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    data_files = ["reports.json", "report-context.json", "report-context.en.json", "report-index.json", "report-index.en.json"]
    data_versions = {
        filename: short_hash((ROOT / filename).read_bytes())
        for filename in data_files
        if filename != "reports.json"
    }
    asset_names, asset_contents = build_assets(data_versions)

    rendered_reports: dict[str, dict[str, str]] = {locale: {} for locale in LOCALES}
    report_versions: dict[str, dict[str, str]] = {locale: {} for locale in LOCALES}
    total_previous = total_english = 0

    for report in reports:
        source_path = ROOT / report["file"]
        source = source_path.read_text(encoding="utf-8")
        catalog = load_sidecar(sidecar_path(report))
        if catalog is None:
            raise FileNotFoundError(f"Missing English sidecar for {report['id']}")
        annotated = annotate_blocks(source, catalog.get("blocks", {}))
        chinese = render_html(annotated, "zh-CN", source_version=catalog["sourceVersion"])
        english = render_html(
            annotated,
            "en",
            units=catalog["units"],
            source_version=catalog["sourceVersion"],
        )
        chinese = rewrite_asset_references(chinese, asset_names)
        english = rewrite_asset_references(english, asset_names)
        remaining = visible_cjk(english)
        if remaining:
            raise ValueError(f"{report['id']} generated English contains visible Chinese: {remaining[:3]}")
        rendered_reports["zh-CN"][report["id"]] = chinese
        rendered_reports["en"][report["id"]] = english
        report_versions["zh-CN"][report["id"]] = short_hash(chinese)
        report_versions["en"][report["id"]] = short_hash(english)
        previous_size = gzip_size(source) + gzip_size(json.dumps(catalog, ensure_ascii=False))
        english_size = gzip_size(english)
        if english_size >= previous_size:
            raise ValueError(f"{report['id']} generated English is not smaller than the previous runtime payload")
        total_previous += previous_size
        total_english += english_size

    shell_source = (ROOT / "index.html").read_text(encoding="utf-8")
    shells = {
        "zh-CN": render_html(shell_source, "zh-CN"),
        "en": render_html(shell_source, "en", ui_targets=ui_targets),
    }

    for locale in LOCALES:
        locale_root = output / locale
        (locale_root / "assets").mkdir(parents=True)
        for filename, content in asset_contents.items():
            (locale_root / "assets" / filename).write_bytes(content)
        for filename in data_files[1:]:
            shutil.copy2(ROOT / filename, locale_root / filename)

        manifest = []
        for report in reports:
            entry = dict(report)
            entry.pop("translations", None)
            entry["version"] = report_versions[locale][report["id"]]
            manifest.append(entry)
            destination = locale_root / report["file"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(rendered_reports[locale][report["id"]], encoding="utf-8")
        manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
        (locale_root / "reports.json").write_text(manifest_text, encoding="utf-8")
        manifest_version = short_hash(manifest_text)
        shell = shells[locale].replace("fetch('reports.json')", f"fetch('reports.json?v={manifest_version}')")
        shell = rewrite_asset_references(shell, asset_names)
        (locale_root / "index.html").write_text(shell, encoding="utf-8")

    (output / "index.html").write_text(locale_router(), encoding="utf-8")
    root_manifest = []
    for report in reports:
        entry = dict(report)
        entry.pop("translations", None)
        entry["versions"] = {locale: report_versions[locale][report["id"]] for locale in LOCALES}
        root_manifest.append(entry)
    (output / "reports.json").write_text(
        json.dumps(root_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    for filename in data_files[1:]:
        shutil.copy2(ROOT / filename, output / filename)
    for report in reports:
        destination = output / report["file"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(legacy_report_router(report), encoding="utf-8")

    reduction = 100 * (1 - total_english / total_previous) if total_previous else 0
    print(f"Built {len(reports)} reports in {len(LOCALES)} locales at {output.relative_to(ROOT)}")
    print(f"English report transfer estimate: {total_english:,} bytes gzip ({reduction:.1f}% below the previous runtime payload)")
    print(f"Hashed {len(asset_contents)} shared assets per locale; authoring catalogues were not published")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    build(args.output)


if __name__ == "__main__":
    main()
