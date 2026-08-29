#!/usr/bin/env python3
"""Regression checks for the staged bilingual Pages artifact."""

from __future__ import annotations

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

from build_localized_site import ROOT, visible_cjk
from i18n_catalog import load_reports, load_sidecar, sidecar_path


SITE = ROOT / "_site"
LOCALES = ("zh-CN", "en")
HASHED_ASSET_RE = re.compile(r"^.+\.[0-9a-f]{12}\.[a-z0-9]+$")


class RootMetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.html_attrs: dict[str, str | None] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "html" and not self.html_attrs:
            self.html_attrs = dict(attrs)


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    assert_true(SITE.is_dir(), "_site is missing; run tools/build_localized_site.py first")
    root_router = (SITE / "index.html").read_text(encoding="utf-8")
    assert_true("location.replace(target.href)" in root_router, "root locale router is missing")
    assert_true(not (SITE / "locales").exists(), "authoring catalogues must not be deployed")
    assert_true(not (SITE / "tools").exists(), "authoring tools must not be deployed")

    reports = load_reports()
    expected_block_ids = {
        report["id"]: set((load_sidecar(sidecar_path(report)) or {}).get("blocks", {}))
        for report in reports
    }

    for locale in LOCALES:
        locale_root = SITE / locale
        manifest_source = (locale_root / "reports.json").read_text(encoding="utf-8")
        manifest = json.loads(manifest_source)
        assert_true(len(manifest) == len(reports), f"{locale} manifest report count changed")
        assert_true(all(entry.get("version") for entry in manifest), f"{locale} report version missing")
        assert_true("locales/" not in manifest_source, f"{locale} manifest exposes authoring catalogues")
        assert_true(all("translations" not in entry for entry in manifest), f"{locale} manifest exposes translation metadata")

        assets = list((locale_root / "assets").iterdir())
        assert_true(assets and all(HASHED_ASSET_RE.match(path.name) for path in assets), f"{locale} assets are not content hashed")
        preference_source = next(path for path in assets if path.name.startswith("site-preferences.")).read_text(encoding="utf-8")
        assert_true("createTreeWalker" not in preference_source, "runtime DOM translation returned")
        assert_true("locales/" not in preference_source, "runtime translation catalogue request returned")

        shell = (locale_root / "index.html").read_text(encoding="utf-8")
        parser = RootMetadataParser()
        parser.feed(shell)
        assert_true(parser.html_attrs.get("lang") == locale, f"{locale} shell lang is incorrect")
        assert_true(parser.html_attrs.get("data-locale") == locale, f"{locale} shell data-locale is incorrect")
        if locale == "en":
            assert_true(not visible_cjk(shell), "visible Chinese remains in the English site shell")

        for report in reports:
            path = locale_root / report["file"]
            assert_true(path.is_file(), f"{locale} report missing: {report['file']}")
            source = path.read_text(encoding="utf-8")
            parser = RootMetadataParser()
            parser.feed(source)
            assert_true(parser.html_attrs.get("lang") == locale, f"{locale} lang missing for {report['id']}")
            assert_true(parser.html_attrs.get("data-locale") == locale, f"{locale} route metadata missing for {report['id']}")
            found_ids = set(re.findall(r'data-report-block-id="([^"]+)"', source))
            assert_true(found_ids == expected_block_ids[report["id"]], f"evidence blocks changed for {locale}/{report['id']}")
            if locale == "en":
                assert_true(not visible_cjk(source), f"visible Chinese remains in en/{report['id']}")

    print("Localized deployment artifact tests: all assertions passed")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print(f"Localized deployment artifact test failed: {error}", file=sys.stderr)
        raise SystemExit(1)
