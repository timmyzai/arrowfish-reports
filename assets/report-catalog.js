(function (root) {
  'use strict';

  const isGoal = report => report.id.startsWith('goal-') || report.file.includes('/Goal-');

  const api = { isGoal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ArrowfishReportCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
