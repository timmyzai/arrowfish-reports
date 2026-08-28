#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const Evidence = require('../assets/report-evidence.js');
const workerSource = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const browserSource = await readFile(new URL('../assets/ai-chat.js', import.meta.url), 'utf8');
const browserStyles = await readFile(new URL('../assets/ai-chat.css', import.meta.url), 'utf8');
const landingPage = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const syntheticContext = { schemaVersion: 1, reports: [] };
const moduleSource = workerSource.replace(
  "import REPORT_CONTEXT from '../report-context.json';",
  `var REPORT_CONTEXT = ${JSON.stringify(syntheticContext)};`
);
const Worker = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
const env = { GROQ_MODEL: 'openai/gpt-oss-20b' };
const report = {
  id: 'goal-test',
  key: 'Stakeholder/Goal/test.html',
  title: 'FFF Goal',
  date: '2026-08-28',
  version: 'v1',
  blocks: Array.from({ length: 10 }, (_, index) => ({
    id: `b${String(index + 1).padStart(4, '0')}`,
    section: index < 5 ? 'FFF 路线图' : '发布状态',
    type: 'p',
    line: index + 10,
    text: index === 0
      ? '客户端支付接口调试尚未完成，必须在 Android 首发前完成成功、失败与订单状态回归。'
      : index === 1
        ? 'Android 发布验收尚未完成。'
        : `第 ${index + 1} 项证据说明平台发布与验收安排。`
  }))
};
const clientSources = report.blocks.map((block, index) => ({ id: `S${index + 1}`, blockId: block.id }));
const canonical = Worker.canonicalSources(clientSources, report);

assert.equal(canonical.length, 8, 'Worker accepts at most eight canonical evidence blocks');
assert.ok(canonical.reduce((total, source) => total + source.text.length, 0) <= 7000, 'Worker caps canonical evidence text at 7,000 characters');

const conversation = Array.from({ length: 9 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  content: index % 2 ? `回答 ${index} [S1]` : `问题 ${index}`
}));
const cleaned = Worker.cleanConversation(conversation);
assert.ok(cleaned.length <= 6, 'Worker keeps at most six conversation messages');
assert.equal(cleaned[0].role, 'user', 'Conversation never begins with an assistant message');
assert.ok(cleaned.every((message) => !/\[S\d+\]/.test(message.content)), 'Old citation markers are removed from conversation context');

const responseFormat = Worker.buildResponseFormat(canonical);
const schema = responseFormat.json_schema.schema;
assert.equal(schema.properties.answer.maxLength, 600, 'Answer schema enforces the short-answer limit');
assert.equal(schema.properties.citations.maxItems, 5, 'Citation schema permits at most five sources');
assert.match(schema.properties.citations.items.properties.quote.description, /事实主体/);

const summary = Worker.extractiveFallback('请用不超过五个要点总结本报告的主要内容。', report, canonical, env, 'test');
assert.equal(summary.answer.split('\n').length, 5, 'Extractive summary contains exactly five points when five sources are available');
assert.equal(summary.sources.length, 5, 'Extractive summary exposes five verified sources');

const negative = Worker.extractiveFallback('Android 发布完成了吗？', report, canonical, env, 'test');
assert.equal(negative.answerable, true, 'Explicit negative completion status may use extractive fallback');
assert.match(negative.answer, /尚未完成/);

const grounded = Worker.validateAnswer({
  kind: 'grounded',
  answer: '客户端支付接口调试尚未完成 [S1]。',
  citations: [{ source_id: 'S1', quote: '客户端支付接口调试尚未完成' }]
}, '支付接口完成了吗？', report, canonical, env);
assert.equal(grounded.answerable, true, 'Grounded answer with an exact quote passes validation');
assert.equal(grounded.sources[0].quote, '客户端支付接口调试尚未完成');

const numericSource = [{
  ...canonical[0],
  text: 'G1 广告归因与付费分析：第10阶段确认 97.6% 的新注册缺少营销归因，现有数据无法判断增长来源。'
}];
const numeric = Worker.validateAnswer({
  kind: 'grounded',
  answer: '缺少营销归因的新注册比例是 97.6% [S1]。',
  citations: [{ source_id: 'S1', quote: '97.6%' }]
}, '缺少营销归因的新注册比例是多少？', report, numericSource, env);
assert.equal(numeric.answerable, true, 'Worker expands an insufficient isolated value to a canonical supporting excerpt');
assert.match(numeric.sources[0].quote, /97\.6% 的新注册缺少营销归因/);

const normalizedMarker = Worker.validateAnswer({
  kind: 'grounded',
  answer: '缺少营销归因的新注册比例是 97.6%。',
  citations: [{ source_id: 'S1', quote: '97.6%' }]
}, '缺少营销归因的新注册比例是多少？', report, numericSource, env);
assert.equal(normalizedMarker.answerable, true, 'Worker adds verified markers to a single grounded fact unit');
assert.match(normalizedMarker.answer, /\[S1\]。$/);

const unrelated = Worker.validateAnswer({ kind: 'broken', answer: '', citations: [] }, '今天天气怎么样？', report, canonical, env);
assert.equal(unrelated.answerable, false, 'Invalid unrelated model output is refused');
assert.equal(unrelated.sources.length, 0, 'Refusal never exposes irrelevant sources');

assert.equal(Worker.parseRetrySeconds('12.2'), 13, 'Retry-After seconds are rounded up');
const keys = { GROQ_API_KEY_1: 'a', GROQ_API_KEY_2: 'b', GROQ_API_KEY_3: 'c' };
const firstSlots = [Worker.orderedKeys(keys)[0].slot, Worker.orderedKeys(keys)[0].slot, Worker.orderedKeys(keys)[0].slot];
assert.equal(new Set(firstSlots).size, 3, 'Normal requests rotate across all three Groq keys');

const retrievalReport = {
  id: report.id,
  file: report.key,
  name: report.title,
  date: report.date,
  version: report.version,
  blocks: report.blocks
};
const selected = Evidence.selectEvidence(retrievalReport, '平台发布与验收安排是什么？', [], { maxSources: 8, maxChars: 7000 });
assert.ok(selected.length <= 8, 'Browser retrieval observes the eight-block contract');

assert.match(browserSource, /sessionStorage\.setItem/);
assert.match(browserSource, /reportKey: currentReport\.file/);
assert.match(browserSource, /reportVersion: currentReport\.version/);
assert.match(browserSource, /event\.key === 'Escape'/);
assert.match(browserSource, /ancestor\.tagName === 'DETAILS'/);
assert.match(browserSource, /scrollIntoView/);
assert.match(browserSource, /currentReport\.file !== reportKey \|\| reportLoadToken !== requestReportToken/);
assert.match(browserStyles, /min-height:\s*44px/);
assert.match(browserStyles, /prefers-reduced-motion:\s*reduce/);
assert.match(landingPage, /assets\/ai-chat\.css\?v=20260828-8/);
assert.match(landingPage, /assets\/ai-chat\.js\?v=20260828-8/);

console.log('AI assistant regression tests: all assertions passed');
