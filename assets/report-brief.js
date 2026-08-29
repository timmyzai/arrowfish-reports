(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ArrowfishBrief = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var TIMELINE_ORDER = ['dated', 'now', 'next-release', 'gated', 'year-end', 'ongoing', 'unscheduled'];
  var TIMELINE_LABEL_KEYS = {
    dated: 'ai.bucketDated',
    now: 'ai.bucketNow',
    'next-release': 'ai.bucketNextRelease',
    gated: 'ai.bucketGated',
    'year-end': 'ai.bucketYearEnd',
    ongoing: 'ai.bucketOngoing',
    unscheduled: 'ai.bucketUnscheduled'
  };
  var MAX_CHAIN_BLOCKERS = 6;
  var MAX_BRIEF_SOURCES = 3;
  var MAX_BRIEF_EXCERPT_CHARS = 150;
  var RESULT_PREFIX_RE = /^(?:结果|Result)[:：]\s*/i;

  function evidence() {
    return root.ArrowfishEvidence;
  }

  function workstreamsInOrder(index) {
    if (!index || !index.workstreams) return [];
    return Object.keys(index.workstreams).map(function (key) { return index.workstreams[key]; });
  }

  function allGoals(index) {
    return workstreamsInOrder(index).reduce(function (items, workstream) {
      return items.concat((workstream && workstream.goals) || []);
    }, []);
  }

  function allPhases(index) {
    return workstreamsInOrder(index).reduce(function (items, workstream) {
      return items.concat(((workstream && workstream.phases) || []).map(function (phase) {
        return { phase: phase, workstream: workstream };
      }));
    }, []);
  }

  function indexedSource(reports, entry, id) {
    var report = entry && (reports || []).find(function (item) { return item.id === entry.reportId; });
    var block = report && (report.blocks || []).find(function (item) { return item.id === entry.blockId; });
    if (!report || !block || block.type === 'heading') return null;
    return {
      id: id,
      blockId: block.id,
      reportId: report.id,
      reportKey: report.file,
      reportTitle: report.name,
      reportDate: report.date,
      reportVersion: report.version,
      section: block.section,
      line: block.line,
      text: block.text,
      quote: block.text
    };
  }

  function addIndexedLine(lines, sources, reports, text, entry) {
    var source = indexedSource(reports, entry, 'S' + (sources.length + 1));
    if (!source) return false;
    sources.push(source);
    lines.push(text + ' [' + source.id + ']');
    return true;
  }

  function result(lines, sources) {
    return { content: lines.join('\n').trim(), sources: sources };
  }

  function briefExcerpt(value) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= MAX_BRIEF_EXCERPT_CHARS) return text;
    var candidate = text.slice(0, MAX_BRIEF_EXCERPT_CHARS);
    var boundary = Math.max(
      candidate.lastIndexOf('。'),
      candidate.lastIndexOf('；'),
      candidate.lastIndexOf('. '),
      candidate.lastIndexOf('; ')
    );
    return (boundary >= 80 ? candidate.slice(0, boundary + 1) : candidate).trim();
  }

  function addBriefLine(lines, sources, source) {
    if (!source || sources.length >= MAX_BRIEF_SOURCES) return false;
    var excerpt = briefExcerpt(source.text);
    if (!excerpt) return false;
    source.id = 'S' + (sources.length + 1);
    source.quote = excerpt;
    sources.push(source);
    lines.push('• ' + excerpt + (excerpt.length < source.text.length ? '…' : '') + ' [' + source.id + ']');
    return true;
  }

  function reportBrief(options) {
    options = options || {};
    var report = options.report;
    var index = options.index;
    var reports = options.reports || [];
    var t = options.t;
    var lines = [];
    var sources = [];
    if (!report) return result(lines, sources);

    evidence().selectEvidence(report, t('ai.briefQuery'), [], {
      maxSources: 2,
      maxChars: 2400
    }).forEach(function (source) {
      addBriefLine(lines, sources, source);
    });

    var openItems = ((index && index.blockers) || []).filter(function (blocker) {
      return blocker.reportId === report.id;
    });
    openItems.some(function (blocker) {
      var duplicate = sources.some(function (source) {
        return source.reportId === blocker.reportId && source.blockId === blocker.blockId;
      });
      return !duplicate && addBriefLine(lines, sources, indexedSource(reports, blocker, ''));
    });
    return result(lines, sources);
  }

  function portfolioBrief(options) {
    options = options || {};
    var index = options.index;
    var reports = options.reports || [];
    var t = options.t;
    var lines = [];
    var sources = [];

    workstreamsInOrder(index).forEach(function (workstream) {
      var phases = (workstream && workstream.phases) || [];
      if (!phases.length) return;
      var delivered = phases.filter(function (phase) { return phase.stage === 'complete'; });
      lines.push(workstream.label);
      [
        [t('ai.timelineDelivered'), delivered[delivered.length - 1]],
        [t('ai.timelineNow'), phases.find(function (phase) { return phase.stage === 'current'; })],
        [t('ai.timelineNext'), phases.find(function (phase) { return phase.stage === 'next'; })]
      ].forEach(function (pair) {
        if (!pair[1]) return;
        addIndexedLine(lines, sources, reports, pair[0] + ' - ' + pair[1].title + ' - ' + pair[1].result, pair[1]);
      });
      lines.push('');
    });

    var goals = allGoals(index);
    lines.push(t('ai.portfolioGoalCount', {
      total: goals.length,
      open: goals.filter(function (goal) { return goal.statusGroup !== 'done'; }).length
    }));
    return result(lines, sources);
  }

  function milestoneTimeline(options) {
    options = options || {};
    var index = options.index;
    var reports = options.reports || [];
    var t = options.t;
    var lines = [];
    var sources = [];
    var phases = allPhases(index);

    function section(label, stages) {
      var matching = phases.filter(function (item) { return stages.indexOf(item.phase.stage) !== -1; });
      if (!matching.length) return;
      lines.push(label);
      matching.forEach(function (item) {
        var phase = item.phase;
        var prefix = item.workstream.label + ' · ' + (phase.label || '');
        addIndexedLine(lines, sources, reports, prefix + ' · ' + phase.title + ' - ' + phase.result, phase);
      });
      lines.push('');
    }

    section(t('ai.timelineDelivered'), ['complete']);
    section(t('ai.timelineNow'), ['current']);
    section(t('ai.timelineNext'), ['next', 'planned']);

    var goals = allGoals(index);
    lines.push(t('ai.timelineGoals', { count: goals.length }));
    TIMELINE_ORDER.forEach(function (bucket) {
      var matching = goals.filter(function (goal) { return goal.timeline === bucket; });
      if (!matching.length) return;
      lines.push(t(TIMELINE_LABEL_KEYS[bucket]));
      matching.forEach(function (goal) {
        var text = goal.id + ' ' + goal.title + ' · ' + goal.status + ' · ' + goal.deadline;
        if (goal.atRisk) text += ' ' + t('ai.atRisk');
        addIndexedLine(lines, sources, reports, text, goal);
      });
    });
    return result(lines, sources);
  }

  function deliveryChain(options) {
    options = options || {};
    var index = options.index;
    var reports = options.reports || [];
    var t = options.t;
    var key = options.workstream;
    var workstream = index && index.workstreams && index.workstreams[key];
    var lines = [];
    var sources = [];
    if (!workstream) return result(lines, sources);

    var label = workstream.label || key;
    var goals = (workstream.goals || []);
    lines.push(t('ai.chainHeading', { workstream: label }));
    lines.push('');

    var dated = goals.filter(function (goal) { return goal.timeline === 'dated'; });
    if (dated.length) {
      lines.push(t('ai.chainDated'));
      dated.forEach(function (goal) {
        var text = goal.id + ' ' + goal.title + ' - ' + goal.deadline;
        if (goal.atRisk) text += ' ' + t('ai.atRisk');
        addIndexedLine(lines, sources, reports, text, goal);
      });
      lines.push('');
    }

    var phases = workstream.phases || [];
    var stageLabels = [
      ['current', t('ai.timelineNow')],
      ['next', t('ai.timelineNext')],
      ['planned', t('ai.timelineLater')]
    ];
    var sequenced = stageLabels.filter(function (pair) {
      return phases.some(function (phase) { return phase.stage === pair[0]; });
    });
    if (sequenced.length) {
      lines.push(t('ai.chainSequence'));
      sequenced.forEach(function (pair) {
        phases.filter(function (phase) {
          return phase.stage === pair[0];
        }).forEach(function (phase) {
          var gate = phase.label ? ' (' + phase.label + ')' : '';
          addIndexedLine(lines, sources, reports, pair[1] + ' · ' + phase.title + gate + ' - ' + phase.result, phase);
        });
      });
      lines.push('');
    }

    var open = goals.filter(function (goal) {
      return goal.statusGroup !== 'done' && goal.timeline !== 'dated';
    });
    var gatingOrder = ['now', 'next-release', 'gated'];
    var blocking = open.filter(function (goal) {
      return gatingOrder.indexOf(goal.timeline) !== -1;
    }).sort(function (left, right) {
      return gatingOrder.indexOf(left.timeline) - gatingOrder.indexOf(right.timeline);
    }).slice(0, MAX_CHAIN_BLOCKERS);
    if (blocking.length) {
      lines.push(t('ai.chainBlocking'));
      blocking.forEach(function (goal) {
        addIndexedLine(lines, sources, reports, goal.id + ' ' + goal.title + ' · ' + goal.status + ' - ' + goal.nextAction, goal);
      });
      lines.push('');
    }
    var remaining = open.length - blocking.length;
    if (remaining > 0) {
      lines.push(t('ai.chainMoreGoals', { count: remaining }));
      lines.push('');
    }

    lines.push(t('ai.chainNoDate', { workstream: label }));
    return result(lines, sources);
  }

  function resultsSummary(options) {
    options = options || {};
    var reports = options.reports || [];
    var lines = [];
    var sources = [];
    allPhases(options.index).map(function (item) {
      return item.phase;
    }).filter(function (phase) {
      return phase.stage === 'complete' && RESULT_PREFIX_RE.test(phase.result);
    }).reverse().forEach(function (phase) {
      addIndexedLine(
        lines,
        sources,
        reports,
        phase.label + ' · ' + phase.result.replace(RESULT_PREFIX_RE, ''),
        phase
      );
    });
    return result(lines, sources);
  }

  function blockerSummary(options) {
    options = options || {};
    var index = options.index;
    var reports = options.reports || [];
    var t = options.t;
    var formatDate = options.formatDate || function (value) { return value; };
    var lines = [];
    var sources = [];
    var used = new Set();

    allGoals(index).filter(function (goal) {
      return goal.statusGroup !== 'done';
    }).forEach(function (goal) {
      addIndexedLine(
        lines,
        sources,
        reports,
        goal.id + ' ' + goal.title + ' · ' + goal.status + ' - ' + goal.evidence + ' ' + t('ai.nextStep') + goal.nextAction,
        goal
      );
      used.add(goal.reportId + ' ' + goal.blockId);
    });

    ((index && index.blockers) || []).forEach(function (blocker) {
      var key = blocker.reportId + ' ' + blocker.blockId;
      if (used.has(key)) return;
      used.add(key);
      addIndexedLine(
        lines,
        sources,
        reports,
        formatDate(blocker.reportDate) + ' · ' + blocker.section + ' - ' + blocker.text,
        blocker
      );
    });
    return result(lines, sources);
  }

  return {
    allGoals: allGoals,
    deliveryChain: deliveryChain,
    indexedSource: indexedSource,
    reportBrief: reportBrief,
    portfolioBrief: portfolioBrief,
    milestoneTimeline: milestoneTimeline,
    resultsSummary: resultsSummary,
    blockerSummary: blockerSummary
  };
});
