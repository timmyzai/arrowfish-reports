#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const Evidence = require('../assets/report-evidence.js');
const suites = await Promise.all([
  ['zh-CN', '../report-context.json', '../evaluation/ai-chat-p0-cases.json'],
  ['en', '../report-context.en.json', '../evaluation/ai-chat-p0-cases.en.json']
].map(async ([locale, contextPath, casesPath]) => ({
  locale,
  context: JSON.parse(await readFile(new URL(contextPath, import.meta.url), 'utf8')),
  cases: JSON.parse(await readFile(new URL(casesPath, import.meta.url), 'utf8'))
})));

let passed = 0;
let total = 0;
for (const suite of suites) {
  for (const testCase of suite.cases) {
    const label = `${suite.locale}/${testCase.id}`;
    const report = suite.context.reports.find((item) => item.id === testCase.reportId);
    assert.ok(report, `${label}: report is registered`);
    const sources = Evidence.selectEvidence(
      report,
      testCase.question,
      testCase.conversation || [],
      { maxSources: 8, maxChars: 7000 }
    );
    const evidence = sources.map((source) => `${source.section}\n${source.text}`).join('\n');

    if (testCase.answerable === false) {
      assert.equal(sources.length, 0, `${label}: unrelated query is rejected locally`);
    } else {
      assert.ok(sources.length > 0 && sources.length <= 8, `${label}: evidence count is within limit`);
      assert.ok(sources.reduce((sum, source) => sum + source.text.length, 0) <= 7000, `${label}: evidence text is within limit`);
      for (const expected of testCase.expectedAll || []) {
        const contains = suite.locale === 'en'
          ? evidence.toLowerCase().includes(expected.toLowerCase())
          : evidence.includes(expected);
        assert.ok(contains, `${label}: evidence contains ${expected}`);
      }
      if (testCase.minimumSources) {
        assert.ok(sources.length >= testCase.minimumSources, `${label}: enough summary evidence is selected`);
      }
    }
    passed += 1;
    total += 1;
  }
}

assert.equal(passed, total);
console.log(`Bilingual AI retrieval evaluation: ${passed}/${total} passed (100%)`);
