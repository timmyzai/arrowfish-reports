#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const Evidence = require('../assets/report-evidence.js');
globalThis.ArrowfishEvidence = Evidence;
const Brief = require('../assets/report-brief.js');
const workerSource = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const browserSource = await readFile(new URL('../assets/ai-chat.js', import.meta.url), 'utf8');
const browserStyles = await readFile(new URL('../assets/ai-chat.css', import.meta.url), 'utf8');
const landingPage = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const syntheticContext = { schemaVersion: 1, reports: [] };
const moduleSource = workerSource.replace(
  "import REPORT_CONTEXT from '../report-context.json';",
  `var REPORT_CONTEXT = ${JSON.stringify(syntheticContext)};`
).replace(
  "import REPORT_CONTEXT_EN from '../report-context.en.json';",
  `var REPORT_CONTEXT_EN = ${JSON.stringify(syntheticContext)};`
);
const Worker = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
const env = { GROQ_MODEL: 'openai/gpt-oss-20b' };
const report = {
  id: 'goal-test',
  key: 'Stakeholder/Goal/test.html',
  title: 'FFF Goal',
  date: '2026-08-28',
  version: 'v1',
  locale: 'zh-CN',
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
assert.ok(cleaned.every((message) => message.role === 'user'), 'Historical assistant answers are never reused as factual context');

const responseFormat = Worker.buildResponseFormat(canonical);
const schema = responseFormat.json_schema.schema;
assert.match(schema.properties.answer.description, /指标主体和值/, 'Answer schema rejects ambiguous bare-number guidance');
assert.match(schema.properties.answer.description, /最多 600 个字符/, 'Answer schema states the short-answer limit as guidance');
assert.match(schema.properties.citations.description, /最多 5 条引用/, 'Citation schema states the citation limit as guidance');
assert.match(schema.properties.citations.items.properties.quote.description, /事实主体/);
const schemaKeywords = new Set();
(function collectKeywords(node) {
  if (!node || typeof node !== 'object') return;
  Object.keys(node).forEach((key) => {
    schemaKeywords.add(key);
    collectKeywords(node[key]);
  });
})(schema);
['maxLength', 'minLength', 'maxItems', 'minItems', 'pattern', 'format'].forEach((keyword) => {
  assert.ok(!schemaKeywords.has(keyword), `Strict schema omits the unsupported keyword ${keyword}`);
});

const overlongAnswer = Worker.validateAnswer({
  kind: 'grounded',
  answer: '客户端支付接口调试尚未完成 [S1]。'.repeat(60),
  citations: [{ source_id: 'S1', quote: '客户端支付接口调试尚未完成' }]
}, '支付接口完成了吗？', report, canonical, env);
assert.notEqual(overlongAnswer.meta.result, 'grounded', 'Worker still rejects answers beyond the character limit');

const overCitedSources = canonical.slice(2, 8);
const overCited = Worker.validateAnswer({
  kind: 'grounded',
  answer: overCitedSources.map((source) => `${source.text.replace(/。$/, '')} [${source.id}]。`).join(''),
  citations: overCitedSources.map((source) => ({ source_id: source.id, quote: source.text }))
}, '平台发布与验收安排是什么？', report, canonical, env);
assert.ok(overCited.sources.length <= 5, 'Worker never returns more than five sources regardless of model output');

const systemPrompt = Worker.buildMessages('支付接口完成了吗？', report, canonical, [], 'zh-CN')[0].content;
assert.match(systemPrompt, /利益相关者报告分析助手/, 'Prompt defines the stakeholder-facing role');
assert.match(systemPrompt, /不能只返回裸数字/, 'Prompt requires self-contained numeric answers');
assert.match(systemPrompt, /值、单位和范围/, 'Prompt constrains period and project comparisons');
assert.match(systemPrompt, /指代只能从先前 user 消息解析/, 'Prompt limits conversation history to referent resolution');
assert.match(systemPrompt, /完成状态仍必须来自 documents/, 'Prompt example keeps follow-up facts grounded');
assert.match(systemPrompt, /不使用模型常识作答/, 'Prompt example refuses unsupported general-knowledge questions');
assert.match(workerSource, /max_completion_tokens:\s*4096/, 'Complex grounded answers retain enough budget after model reasoning');
assert.match(workerSource, /upstream\.status === 400[\s\S]*fallbackOrRefusal/, 'Schema generation failures return grounded fallback evidence');
assert.match(workerSource, /reasoning_effort:\s*'medium'/);
assert.match(workerSource, /include_reasoning:\s*false/);

const summary = Worker.extractiveFallback('请用不超过五个要点总结本报告的主要内容。', report, canonical, env, 'test');
assert.equal(summary.answer.split('\n').length, 5, 'Extractive summary contains exactly five points when five sources are available');
assert.equal(summary.sources.length, 5, 'Extractive summary exposes five verified sources');

const negative = Worker.extractiveFallback('Android 发布完成了吗？', report, canonical, env, 'test');
assert.equal(negative.answerable, true, 'Explicit negative completion status may use extractive fallback');
assert.match(negative.answer, /尚未完成/);

const progressFallback = Worker.extractiveFallback('G10 现在进展如何？', report, canonical, env, 'generation_failed');
assert.equal(progressFallback.answerable, true, 'Grounded questions fall back to the strongest exact evidence');
assert.equal(progressFallback.sources.length, 1, 'Generic extractive fallback stays concise');
assert.ok(progressFallback.answer.length <= 230, 'Generic extractive fallback remains short');

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

const multiUnitMarkers = Worker.validateAnswer({
  kind: 'grounded',
  answer: '客户端支付接口调试尚未完成。Android 发布验收尚未完成。',
  citations: [
    { source_id: 'S1', quote: '客户端支付接口调试尚未完成' },
    { source_id: 'S2', quote: 'Android 发布验收尚未完成' }
  ]
}, '首发前还有哪些未完成项？', report, canonical, env);
assert.equal(multiUnitMarkers.answerable, true, 'Multi-sentence answers keep their citations instead of being refused');
assert.match(multiUnitMarkers.answer, /客户端支付接口调试尚未完成 \[S1\]。/, 'Each fact unit receives the marker of the citation supporting it');
assert.match(multiUnitMarkers.answer, /Android 发布验收尚未完成 \[S2\]。$/, 'Markers stay inside their own fact unit');
assert.equal(multiUnitMarkers.sources.length, 2, 'Both supporting sources are returned');

const unsupportedMarkers = Worker.validateAnswer({
  kind: 'grounded',
  answer: '支付网关前置事项由外部团队负责。',
  citations: [{ source_id: 'S1', quote: '客户端支付接口调试尚未完成' }]
}, '支付接口完成了吗？', report, canonical, env);
assert.equal(unsupportedMarkers.answerable, true, 'A rejected model answer falls back to evidence instead of denying the report has any');
assert.match(unsupportedMarkers.meta.result, /^extractive_.*_missing_citation_markers$/, 'The fallback records why the model answer was rejected');
assert.ok(
  canonical.some((source) => source.text.includes(unsupportedMarkers.sources[0].quote)),
  'The fallback quote is verbatim evidence from the report'
);

const unrelated = Worker.validateAnswer({ kind: 'broken', answer: '', citations: [] }, '今天天气怎么样？', report, canonical, env);
assert.equal(unrelated.answerable, false, 'Invalid unrelated model output is refused');
assert.equal(unrelated.sources.length, 0, 'Refusal never exposes irrelevant sources');
assert.equal(unrelated.meta.locale, 'zh-CN', 'Response metadata declares its locale');

const englishReport = {
  ...report,
  title: 'FFF Goals',
  locale: 'en',
  blocks: report.blocks.map((block, index) => ({
    ...block,
    section: index < 5 ? 'FFF Roadmap' : 'Release status',
    text: index === 0
      ? 'Client payment API debugging is not yet complete and must pass success, failure, and order-status regression before the Android launch.'
      : index === 1
        ? 'Android release acceptance is not yet complete.'
        : `Evidence item ${index + 1} describes platform release and acceptance plans.`
  }))
};
const englishSources = englishReport.blocks.slice(0, 8).map((block, index) => ({
  id: `S${index + 1}`,
  reportId: englishReport.id,
  reportKey: englishReport.key,
  reportTitle: englishReport.title,
  reportDate: englishReport.date,
  reportVersion: englishReport.version,
  blockId: block.id,
  section: block.section,
  line: block.line,
  text: block.text
}));
const englishNegative = Worker.extractiveFallback('Is the Android release complete?', englishReport, englishSources, env, 'test');
assert.equal(englishNegative.answerable, true, 'English negative completion status has an extractive fallback');
assert.match(englishNegative.answer, /not yet complete/i);
const englishRefusal = Worker.validateAnswer({ kind: 'broken', answer: '', citations: [] }, 'What is the weather?', englishReport, englishSources, env);
assert.match(englishRefusal.answer, /does not contain information/i, 'English fallback is localized');
assert.equal(englishRefusal.meta.locale, 'en', 'English response metadata declares its locale');
assert.match(Worker.buildMessages('What changed?', englishReport, englishSources, [], 'en')[0].content, /Answer in English/);
assert.equal(Worker.questionLocale('What changed?', 'zh-CN'), 'en');
assert.equal(Worker.questionLocale('有什么变化？', 'en'), 'zh-CN');
assert.equal(Worker.errorPayload('RATE_LIMITED', 'en').code, 'RATE_LIMITED', 'API errors expose stable codes');
assert.match(Worker.errorPayload('RATE_LIMITED', 'en').error, /busy/i, 'API error text follows the UI locale');
[
  'ORIGIN_FORBIDDEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'PAYLOAD_TOO_LARGE',
  'INVALID_JSON', 'QUESTION_REQUIRED', 'INVALID_REPORT', 'NOT_CONFIGURED',
  'SERVICE_UNAVAILABLE', 'UPSTREAM_TIMEOUT', 'GENERATION_FAILED', 'UPSTREAM_FAILED',
  'INVALID_UPSTREAM_RESPONSE', 'INVALID_MODEL_RESPONSE', 'RATE_LIMITED',
  'TOO_MANY_REQUESTS', 'INVALID_CONFIGURATION'
].forEach((code) => {
  assert.equal(Worker.errorPayload(code, 'zh-CN').code, code);
  assert.equal(Worker.errorPayload(code, 'en').code, code);
  assert.ok(Worker.errorPayload(code, 'zh-CN').error.length > 0 && Worker.errorPayload(code, 'en').error.length > 0);
});

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
const conciseBrief = Brief.reportBrief({
  report: retrievalReport,
  reports: [retrievalReport],
  index: { blockers: [{ reportId: retrievalReport.id, blockId: retrievalReport.blocks[0].id }] },
  t: () => 'summary results risks next steps'
});
assert.ok(conciseBrief.sources.length <= 3, 'Automatic report brief stays within three evidence excerpts');
assert.ok(conciseBrief.content.split('\n').length <= 3, 'Automatic report brief stays within three short lines');
assert.ok(conciseBrief.sources.every((source) => source.quote.length <= 150), 'Brief citations use concise verbatim excerpts');
assert.equal(
  Evidence.locatorText('ARROWFISH · 第10阶段细节 01 缺口已确认 广告追踪与付费分析'),
  Evidence.locatorText('ARROWFISH · 第10阶段细节 01缺口已确认广告追踪与付费分析'),
  'Citation locator ignores whitespace introduced between adjacent inline elements'
);
const inlineCitations = Evidence.citationParts('第一项已完成 [S1]。第二项仍待验收。[S2]', ['S1', 'S2']);
assert.deepEqual(
  inlineCitations.filter((part) => part.type === 'citation').map((part) => part.text),
  ['S1', 'S2'],
  'Citation markers become compact source chips'
);
assert.equal(
  inlineCitations.filter((part) => part.type === 'text').map((part) => part.text).join(''),
  '第一项已完成。第二项仍待验收。',
  'Visible answer text contains no numbered citation markers'
);
assert.equal(Evidence.stripCitationMarkers('事实 [S1]。'), '事实。', 'Copied answers omit citation markers');

assert.match(browserSource, /sessionStorage\.setItem/);
assert.match(browserSource, /responseLocale/);
assert.match(browserSource, /function apiErrorMessage[\s\S]*UPSTREAM_TIMEOUT:[\s\S]*ai\.timeout/, 'Browser localizes stable API error codes');
assert.match(browserSource, /data-report-block-id/);
assert.match(browserSource, /function handlePreferenceChange[\s\S]*nextLanguage === lastPreferenceLanguage[\s\S]*activeController\.abort\(\)[\s\S]*messages = \[\][\s\S]*removeSavedConversation\(\)/, 'Language changes abort requests and clear the active session');
assert.match(browserSource, /reportKey: currentReport\.file/);
assert.match(browserSource, /reportVersion: currentReport\.version/);
assert.match(browserSource, /event\.key === 'Escape'/);
assert.match(browserSource, /ancestor\.tagName === 'DETAILS'/);
assert.match(browserSource, /scrollIntoView/);
assert.match(browserSource, /Evidence\.citationParts/);
assert.match(browserSource, /Evidence\.stripCitationMarkers/);
assert.doesNotMatch(browserSource, /ai-quick-action|renderShortcut/, 'Hard-coded assistant shortcut buttons stay removed');
assert.match(browserSource, /renderMessages\(answerReceived \? 'assistant-start' : 'preserve'\)/, 'Completed answers anchor at their beginning while errors preserve scroll');
assert.match(browserSource, /function scrollToLatestAssistant[\s\S]*getBoundingClientRect/, 'Assistant scroll anchoring targets the latest response');
assert.doesNotMatch(browserSource, /link\.textContent = match\[1\]\.slice/);
assert.match(browserSource, /currentReport\.file !== reportKey \|\| reportLoadToken !== requestReportToken/);
assert.match(browserStyles, /min-height:\s*44px/);
assert.match(browserStyles, /prefers-reduced-motion:\s*reduce/);
assert.doesNotMatch(browserStyles, /\.ai-quick-action/, 'Removed shortcut controls leave no dead CSS');
assert.match(landingPage, /assets\/ai-chat\.css\?v=20260829-13/);
assert.match(landingPage, /assets\/ai-chat\.js\?v=20260829-13/);
assert.match(browserStyles, /\.ai-launcher,\s*\.ai-backdrop,\s*\.ai-drawer,\s*\.ai-brief-strip\s*\{\s*display:\s*none !important;/);

console.log('AI assistant regression tests: all assertions passed');
