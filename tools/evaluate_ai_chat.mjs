#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const Evidence = require('../assets/report-evidence.js');
const context = JSON.parse(await readFile(new URL('../report-context.json', import.meta.url), 'utf8'));
const cases = JSON.parse(await readFile(new URL('../evaluation/ai-chat-p0-cases.json', import.meta.url), 'utf8'));

let passed = 0;
for (const testCase of cases) {
  const report = context.reports.find((item) => item.id === testCase.reportId);
  assert.ok(report, `${testCase.id}: report is registered`);
  const sources = Evidence.selectEvidence(
    report,
    testCase.question,
    testCase.conversation || [],
    { maxSources: 8, maxChars: 7000 }
  );
  const evidence = sources.map((source) => `${source.section}\n${source.text}`).join('\n');

  if (testCase.answerable === false) {
    assert.equal(sources.length, 0, `${testCase.id}: unrelated query is rejected locally`);
  } else {
    assert.ok(sources.length > 0 && sources.length <= 8, `${testCase.id}: evidence count is within limit`);
    assert.ok(sources.reduce((total, source) => total + source.text.length, 0) <= 7000, `${testCase.id}: evidence text is within limit`);
    for (const expected of testCase.expectedAll || []) {
      assert.ok(evidence.includes(expected), `${testCase.id}: evidence contains ${expected}`);
    }
    if (testCase.minimumSources) {
      assert.ok(sources.length >= testCase.minimumSources, `${testCase.id}: enough summary evidence is selected`);
    }
  }
  passed += 1;
}

assert.equal(passed, cases.length);
console.log(`AI retrieval evaluation: ${passed}/${cases.length} passed (100%)`);
