(function (root) {
  'use strict';

  const kinds = ['correction', 'summary', 'report', 'addendum', 'study'];
  const recommendationKinds = ['summary', 'report', 'correction', 'addendum', 'study'];
  const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const isGoal = report => report.id.startsWith('goal-') || report.file.includes('/Goal-');
  const compareReports = (a, b) => compareText(b.date, a.date)
    || kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || compareText(a.id, b.id);

  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  }

  function groupReports(reports) {
    if (!Array.isArray(reports) || !reports.length) throw new Error('Empty report catalogue');
    const ids = new Set();
    const groups = new Map();
    let goalCount = 0;
    reports.forEach(report => {
      if (!report.id || ids.has(report.id)) throw new Error('Duplicate or missing report ID: ' + report.id);
      ids.add(report.id);
      if (!report.file || !validDate(report.date)) throw new Error('Invalid report: ' + report.id);
      if (isGoal(report)) {
        if (++goalCount > 1) throw new Error('Multiple goal dashboards');
        return;
      }
      const sprint = report.sprint;
      if (!sprint || !Number.isInteger(sprint.start) || !Number.isInteger(sprint.end)
          || sprint.start < 0 || sprint.end < sprint.start) throw new Error('Invalid sprint: ' + report.id);
      if (!kinds.includes(report.kind) || !report.shortName?.['zh-CN'] || !report.shortName?.en) {
        throw new Error('Missing navigation metadata: ' + report.id);
      }
      ['publishedAt', 'contentThrough', 'periodStart', 'periodEnd'].forEach(key => {
        if (report[key] !== undefined && !validDate(report[key])) throw new Error('Invalid ' + key + ': ' + report.id);
      });
      if (Boolean(report.periodStart) !== Boolean(report.periodEnd)
          || (report.periodStart && report.periodStart > report.periodEnd)) throw new Error('Invalid period: ' + report.id);
      const key = sprint.start + '-' + sprint.end;
      if (!groups.has(key)) groups.set(key, { key, ...sprint, reports: [] });
      groups.get(key).reports.push(report);
    });
    return [...groups.values()].sort((a, b) => b.end - a.end || b.start - a.start).map(group => {
      const explicit = group.reports.filter(report => report.defaultForSprintPage === true);
      if (explicit.length > 1) throw new Error('Multiple recommended reports: ' + group.key);
      const ordered = [...group.reports].sort(compareReports);
      const eligible = ordered.filter(report => report.defaultForSprintPage !== false).sort((a, b) =>
        recommendationKinds.indexOf(a.kind) - recommendationKinds.indexOf(b.kind) || compareReports(a, b));
      const recommended = explicit[0] || eligible[0] || ordered[0];
      return { ...group, recommendedId: recommended.id,
        reports: [recommended, ...ordered.filter(report => report.id !== recommended.id)] };
    });
  }

  const api = { groupReports, isGoal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ArrowfishReportCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
