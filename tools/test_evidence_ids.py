"""Regressions for citations when a living dashboard changes reading order."""
import unittest

from generate_report_context import ReportParser
from build_localized_site import annotate_blocks


def parse(source, translations=None):
    parser = ReportParser(translations)
    parser.feed(source)
    parser.close()
    return parser.blocks


class EvidenceIdsTest(unittest.TestCase):
    def test_reordering_keeps_explicit_ids(self):
        one = '<p data-evidence-id="b0001">First fact</p>'
        two = '<p data-evidence-id="b0002">Second fact</p>'
        original = {b['id']: b['text'] for b in parse(one + two)}
        reordered = {b['id']: b['text'] for b in parse(two + one)}
        self.assertEqual(original, reordered)

    def test_new_summary_does_not_reuse_legacy_id(self):
        blocks = parse('<html data-evidence-prefix="reading-"><p>New summary</p>'
                       '<p data-evidence-id="b0001">Original fact</p></html>')
        self.assertEqual([b['id'] for b in blocks], ['reading-b0001', 'b0001'])

    def test_distinct_pinned_repeated_text_is_not_discarded(self):
        blocks = parse('<p data-evidence-id="b0001">Same fact</p><p data-evidence-id="b0002">Same fact</p>')
        self.assertEqual(len(blocks), 2)

    def test_duplicate_or_unsafe_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate evidence ID'):
            parse('<p data-evidence-id="x">One</p><p data-evidence-id="x">Two</p>')
        with self.assertRaisesRegex(ValueError, 'Invalid'):
            parse('<p data-evidence-id="unsafe id">One</p>')

    def test_historical_unmarked_reports_keep_sequential_ids(self):
        self.assertEqual([b['id'] for b in parse('<h1>Report</h1><p>Fact</p>')], ['b0001', 'b0002'])

    def test_translation_keeps_canonical_ids_and_build_locator(self):
        source = '<p data-evidence-id="b0042">测试未完成</p>'
        translated = parse(source, [{'kind': 'text', 'source': '测试未完成', 'target': 'Testing is not complete.'}])
        self.assertEqual(translated[0]['id'], 'b0042')
        self.assertEqual(translated[0]['text'], 'Testing is not complete.')
        built = annotate_blocks(source, {'b0042': {'type': 'p', 'source': '测试未完成', 'occurrence': 0}})
        self.assertEqual(built.count('data-report-block-id="b0042"'), 1)


if __name__ == '__main__':
    unittest.main()
