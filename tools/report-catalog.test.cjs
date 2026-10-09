const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { groupReports } = require('../assets/report-catalog.js');
const reports = JSON.parse(readFileSync(join(__dirname, '../reports.json'), 'utf8'));
const fixture = (id, overrides = {}) => ({ id, file: id + '.html', date: '2026-10-09',
  sprint: { start: 14, end: 14 }, kind: 'report', shortName: { 'zh-CN': id, en: id }, ...overrides });

test('actual catalogue groups every report once and recommends the current main report', () => {
  const groups = groupReports(reports);
  assert.equal(groups.flatMap(group => group.reports).length, 27);
  assert.equal(new Set(groups.flatMap(group => group.reports.map(report => report.id))).size, 27);
  assert.deepEqual(groups.slice(0, 5).map(group => group.key), ['14-14', '13-13', '12-12', '11-11', '10-10']);
  assert.deepEqual(groups[0].reports.map(report => report.id), [
    'sprint-14-progress-20261009', 'sprint-14-android-qa-20261009', 'sprint-14-fff-progress-20261009'
  ]);
  assert.equal(groups[2].recommendedId, 'sprint-12-progress-20261009');
  assert.equal(groups.at(-2).key, '0-1');
  assert.equal(groups.at(-1).key, '0-0');
});

test('input registration order cannot affect reading order', () => {
  assert.deepEqual(groupReports([...reports].reverse()), groupReports(reports));
  assert.deepEqual(groupReports([...reports.slice(10), ...reports.slice(0, 10)]), groupReports(reports));
});

test('explicit recommendation wins over newer reports', () => {
  const main = fixture('main', { defaultForSprintPage: true, date: '2026-10-08' });
  const supplement = fixture('supplement', { kind: 'addendum' });
  assert.equal(groupReports([supplement, main])[0].recommendedId, 'main');
});

test('summary fallback, exclusion and all-excluded fallback are deterministic', () => {
  const summary = fixture('summary', { kind: 'summary', date: '2026-10-01' });
  const report = fixture('report');
  assert.equal(groupReports([report, summary])[0].recommendedId, 'summary');
  summary.defaultForSprintPage = false;
  assert.equal(groupReports([report, summary])[0].recommendedId, 'report');
  report.defaultForSprintPage = false;
  assert.equal(groupReports([summary, report])[0].recommendedId, 'report');
});

test('same-date supplements use type then ID ordering', () => {
  const group = groupReports([fixture('main', { defaultForSprintPage: true }),
    fixture('z-study', { kind: 'study' }), fixture('b-addendum', { kind: 'addendum' }),
    fixture('a-addendum', { kind: 'addendum' }), fixture('correction', { kind: 'correction' })])[0];
  assert.deepEqual(group.reports.map(report => report.id), ['main', 'correction', 'a-addendum', 'b-addendum', 'z-study']);
});

test('single-sprint groups precede ranges with the same endpoint; numbers are numeric', () => {
  const list = [[9, 9], [4, 6], [6, 6], [14, 14]].map(([start, end]) => fixture(`${start}-${end}`, { sprint: { start, end } }));
  assert.deepEqual(groupReports(list).map(group => group.key), ['14-14', '9-9', '6-6', '4-6']);
});

test('duplicate IDs, multiple recommendations and invalid metadata fail validation', () => {
  assert.throws(() => groupReports([fixture('a'), fixture('a')]), /Duplicate/);
  assert.throws(() => groupReports([fixture('a', { defaultForSprintPage: true }), fixture('b', { defaultForSprintPage: true })]), /Multiple recommended/);
  assert.throws(() => groupReports([fixture('a', { sprint: undefined })]), /Invalid sprint/);
  assert.throws(() => groupReports([fixture('a', { date: '2026-02-30' })]), /Invalid report/);
  assert.throws(() => groupReports([fixture('a', { kind: 'unknown' })]), /metadata/);
  assert.throws(() => groupReports([fixture('a', { periodStart: '2026-10-09' })]), /Invalid period/);
});

test('publication and coverage dates retain their distinct meanings', () => {
  const sprint13 = reports.find(report => report.id === 'sprint-13-summary');
  const sprint14 = reports.find(report => report.id === 'sprint-14-progress-20261009');
  assert.equal(sprint13.date, '2026-10-02');
  assert.equal(sprint13.periodEnd, '2026-10-02');
  assert.equal(sprint13.publishedAt, '2026-10-09');
  assert.equal(sprint14.contentThrough, '2026-10-08');
  assert.equal(sprint14.publishedAt, '2026-10-09');
});
