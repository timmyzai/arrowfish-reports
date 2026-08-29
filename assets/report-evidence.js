(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ArrowfishEvidence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i',
    'in', 'is', 'it', 'me', 'of', 'on', 'or', 'report', 'that', 'the', 'this',
    'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with'
  ]);
  var STOP_CJK = new Set([
    '报告', '本报', '提到', '中提', '相关', '信息', '问题', '请问', '什么',
    '是否', '多少', '当前', '里面', '如何', '可以', '了吗', '一下', '说明',
    '有没', '没有'
  ]);

  var SYNONYM_GROUPS = [
    ['summary', 'summarize', 'overview', 'highlight', 'main', 'point', '摘要', '概述', '重点', '要点', '总结'],
    ['risk', 'risks', 'blocker', 'blockers', 'blocked', '风险', '阻塞', '阻塞中', '卡住', '延迟', '缺口', '欠', '缺', '待办', '未完成'],
    ['next', 'action', 'actions', 'plan', 'plans', 'roadmap', '下一步', '计划', '规划', '门槛', '什么时候', '上线时间'],
    ['status', 'state', 'progress', 'complete', 'completed', '状态', '进展', '完成', '验收'],
    ['revenue', 'income', 'sales', 'payment', 'paid', '收入', '营收', '付费', '订单', '金额'],
    ['user', 'users', 'registration', 'registrations', 'signup', '用户', '注册', '新增'],
    ['date', 'time', 'deadline', 'milestone', '日期', '时间', '截止', '里程碑'],
    ['compare', 'comparison', 'difference', 'versus', 'vs', '比较', '对比', '差异'],
    ['privacy', 'security', 'permission', 'access', '隐私', '安全', '权限', '访问'],
    ['release', 'launch', 'publish', 'deployment', '上线', '发布', '部署'],
    ['cost', 'saving', 'budget', '成本', '节省', '预算'],
    ['backup', 'restore', 'recovery', '备份', '恢复', '异地'],
    ['routing', 'route', 'splitting', 'split', '智能路由', '智能连接', '自动选线', '流量分流', '分流']
  ];

  var OVERVIEW_RE = /summary|summarize|overview|main points?|highlights?|摘要|概述|重点|要点|总结|主要内容|报告内容|说了什么|讲了什么|看到了什么|看到什么|说说.*报告|介绍.*报告|这份报告.*(?:讲|说)/i;
  var OVERVIEW_SECTION_RE = /tldr|summary|overview|highlights?|摘要|概述|重点|关键|成果|状态|风险|阻塞|下一步|计划|结论/i;
  var OVERVIEW_CATEGORIES = [
    /tldr|summary|overview|摘要|概述|一句话|报告总览/i,
    /成果|进展|指标|营收|结果|outcome|result|progress/i,
    /决定|决策|状态|decision|status/i,
    /风险|阻塞|挑战|限制|安全|risk|blocker|challenge/i,
    /下一步|计划|行动|规划|next|plan|action|roadmap/i
  ];

  function isLowInformationBlock(block) {
    return block.type === 'table-row' && block.text.length < 32 && !/\d/.test(block.text);
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\s\u200b]+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function locatorText(value) {
    return normalizeText(value).replace(/\s+/g, '');
  }

  function stripCitationMarkers(value) {
    return String(value || '').replace(/\s*\[S\d+\]/g, '');
  }

  function reportMetadataIntent(value) {
    var text = normalizeText(value).replace(/[.!?。！？,，;；:：'"“”‘’]+/g, ' ').trim();
    var reportContext = /报告|报表|页面|文档|内容|report|page|document/.test(text);
    var viewingContext = /(?:我|我们|当前|现在|正在|这|此).{0,8}(?:看|浏览|打开|阅读)|(?:看|浏览|打开|阅读).{0,8}(?:什么|哪|名称|标题)|\b(?:i|we)\b.{0,20}\b(?:view|viewing|look|looking|open|opened|read|reading)\b|\b(?:current|open)\b.{0,12}\b(?:report|page|document)\b/i.test(text);
    var asksDate = /日期|哪天|什么时候|何时|更新时间|\bdate\b|\bwhen\b|last updated/i.test(text);
    var asksIdentity = /什么|哪(?:一)?(?:份|个)|名称|名字|标题|叫什|\bwhat\b|\bwhich\b|\bname\b|\btitle\b/i.test(text);
    var explicitTitle = /哪(?:一)?份|哪(?:一)?个报告|什么报告|报告.{0,8}(?:名称|名字|标题|叫什么)|(?:名称|名字|标题).{0,8}报告|\b(?:which|what)\s+(?:report|document)\b|\bwhat\s+is\s+(?:this|the)\s+(?:report|document)\b|\b(?:report|document)\b.{0,12}\b(?:name|title)\b/i.test(text);
    var titleIntent = explicitTitle || (asksIdentity && viewingContext);
    var dateIntent = asksDate && (reportContext || viewingContext);
    return {
      allowed: titleIntent || dateIntent,
      asksDate: dateIntent,
      asksTitle: titleIntent
    };
  }

  function citationParts(value, validSourceIds) {
    var content = String(value || '');
    var sourceIds = new Set(validSourceIds || []);
    var parts = [];
    var markerPattern = /\[(S\d+)\]/g;
    var cursor = 0;
    var match;

    function appendText(text) {
      if (!text) return;
      var previous = parts[parts.length - 1];
      if (previous && previous.type === 'text') previous.text += text;
      else parts.push({ type: 'text', text: text });
    }

    while ((match = markerPattern.exec(content))) {
      var precedingText = content.slice(cursor, match.index);
      if (sourceIds.has(match[1])) {
        appendText(precedingText.replace(/\s+$/, ''));
        parts.push({ type: 'citation', text: match[1], sourceId: match[1] });
      }
      else appendText(precedingText + match[0]);
      cursor = markerPattern.lastIndex;
    }
    appendText(content.slice(cursor));
    return parts;
  }

  function baseTokens(value) {
    var normalized = normalizeText(value);
    var tokens = normalized.match(/[a-z][a-z0-9.+%-]{1,}|\d+(?:[.,:/-]\d+)*%?|[\u3400-\u9fff]{2,}/g) || [];
    var output = [];

    tokens.forEach(function (token) {
      if (/^[\u3400-\u9fff]+$/.test(token)) {
        if (token.length <= 4 && !STOP_CJK.has(token)) output.push(token);
        for (var index = 0; index < token.length - 1; index += 1) {
          var pair = token.slice(index, index + 2);
          if (!STOP_CJK.has(pair)) output.push(pair);
        }
      } else if (!STOP_WORDS.has(token)) {
        output.push(token);
      }
    });
    return Array.from(new Set(output));
  }

  function expandedTokens(value) {
    var normalized = normalizeText(value);
    var tokens = baseTokens(value);
    SYNONYM_GROUPS.forEach(function (group) {
      if (group.some(function (term) {
        // Latin synonym terms must match whole tokens. Substring matching made
        // words such as "remains" trigger the "main" summary synonym group,
        // which displaced the relevant evidence for focused English queries.
        return /[\u3400-\u9fff]/.test(term)
          ? normalized.indexOf(term) !== -1
          : tokens.indexOf(term) !== -1;
      })) {
        tokens = tokens.concat(group);
      }
    });
    return Array.from(new Set(tokens));
  }

  function scoreBlock(report, block, currentTokens, contextTokens, overview, followUp, goalTerms) {
    if (!block || !block.text || block.type === 'heading') return -1;
    if (isLowInformationBlock(block)) return -1;
    if (overview && block.id === 'b0001' && block.text.length < 120) return -1;
    var body = normalizeText(block.text);
    var section = normalizeText(block.section);
    var reportName = normalizeText(report.name + ' ' + report.date);
    var score = 0;

    currentTokens.forEach(function (token) {
      if (body.indexOf(token) !== -1) score += /^\d/.test(token) ? 8 : 3;
      if (section.indexOf(token) !== -1) score += 4;
      if (reportName.indexOf(token) !== -1) score += 2;
    });
    contextTokens.forEach(function (token) {
      if (body.indexOf(token) !== -1) score += followUp ? 3 : 1;
      if (section.indexOf(token) !== -1) score += followUp ? 4 : 1;
    });

    if (overview) {
      if (OVERVIEW_SECTION_RE.test(block.section)) score += 8;
      if (block.type === 'highlight') score += 6;
      if (block.id === 'b0002' || block.id === 'b0003') score += 16;
    }
    if (block.type === 'table-row') score += 1;
    if ((goalTerms || []).some(function (term) {
      return body.indexOf(term) !== -1 || section.indexOf(term) !== -1;
    })) score += 12;
    return score;
  }

  function isNearDuplicate(text, selected) {
    var normalized = normalizeText(text);
    return selected.some(function (item) {
      var existing = normalizeText(item.text);
      return normalized === existing ||
        (normalized.length > 80 && existing.indexOf(normalized) !== -1) ||
        (existing.length > 80 && normalized.indexOf(existing) !== -1);
    });
  }

  function selectEvidence(report, question, recentConversation, options) {
    options = options || {};
    var maxSources = options.maxSources || 8;
    var maxChars = options.maxChars || 7000;
    var currentTokens = expandedTokens(question);
    var contextTokens = expandedTokens((recentConversation || []).join(' '));
    var overview = OVERVIEW_RE.test(question);
    var followUp = (
      /(它|这个|那个|这项|那项|上述|前面|刚才|其)(?:\s|在|的|是|有|已|还|呢|吗|么|中|里|后|前|要|会|可|能)/.test(question) ||
      /\b(?:it|this|that|these|those|them|this one|that one|the former|the latter)\b/i.test(question)
    ) && contextTokens.length > 0;
    var reportMap = new Map((options.reports || [report]).map(function (item) { return [item.id, item]; }));
    reportMap.set(report.id, report);
    var reports = [report];
    if (!overview && options.index && Array.isArray(options.index.order)) {
      options.index.order.forEach(function (reportId) {
        var candidate = reportMap.get(reportId);
        if (candidate && candidate.id !== report.id) reports.push(candidate);
      });
    }
    var normalizedQuestion = normalizeText(question);
    var goalTerms = [];
    if (options.index && options.index.workstreams) {
      Object.keys(options.index.workstreams).forEach(function (key) {
        (options.index.workstreams[key].goals || []).forEach(function (goal) {
          var goalId = normalizeText(goal.id);
          var title = normalizeText(goal.title);
          var idPattern = goalId && new RegExp('(?:^|[^a-z0-9])' + goalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^a-z0-9])', 'i');
          if ((idPattern && idPattern.test(normalizedQuestion)) || (title && normalizedQuestion.indexOf(title) !== -1)) {
            goalTerms.push(goalId, title);
          }
        });
      });
    }
    goalTerms = Array.from(new Set(goalTerms.filter(Boolean)));
    var selected = [];
    var sectionCounts = Object.create(null);
    var usedChars = 0;

    function addItem(item, sourceReport) {
      var block = item.block;
      var sectionKey = normalizeText(block.section);
      if (overview && (sectionCounts[sectionKey] || 0) >= 2) return false;
      if (isNearDuplicate(block.text, selected)) return false;

      var cost = block.text.length + block.section.length + sourceReport.name.length + 40;
      if (selected.length && usedChars + cost > maxChars) return false;
      if (!selected.length && cost > maxChars) block = Object.assign({}, block, { text: block.text.slice(0, maxChars - 300) });

      selected.push({
        id: 'S' + (selected.length + 1),
        blockId: block.id,
        reportId: sourceReport.id,
        reportKey: sourceReport.file,
        reportTitle: sourceReport.name,
        reportDate: sourceReport.date,
        reportVersion: sourceReport.version,
        section: block.section,
        line: block.line,
        text: block.text
      });
      sectionCounts[sectionKey] = (sectionCounts[sectionKey] || 0) + 1;
      usedChars += cost;
      return true;
    }

    var scannedReports = 0;
    reports.some(function (sourceReport) {
      if (selected.length >= maxSources || selected.length >= 4 || scannedReports >= 3) return true;
      scannedReports += 1;
      var ranked = (sourceReport.blocks || []).map(function (block, index) {
        return {
          block: block,
          index: index,
          score: scoreBlock(sourceReport, block, currentTokens, contextTokens, overview, followUp, goalTerms)
        };
      }).filter(function (item) {
        return item.score >= 0;
      }).sort(function (left, right) {
        return right.score - left.score || left.index - right.index;
      });
      var topScore = ranked.length ? ranked[0].score : 0;
      var scoreFloor = overview ? 5 : Math.max(3, topScore * 0.25);
      ranked = ranked.filter(function (item) { return item.score >= scoreFloor; });
      var reportSourceCount = 0;
      var reportSourceLimit = overview ? maxSources : 3;

      if (overview) {
        OVERVIEW_CATEGORIES.forEach(function (pattern) {
          if (selected.length >= maxSources || reportSourceCount >= reportSourceLimit) return;
          var candidate = ranked.find(function (item) {
            return pattern.test(item.block.section + ' ' + item.block.text) && !isNearDuplicate(item.block.text, selected);
          });
          if (candidate && addItem(candidate, sourceReport)) reportSourceCount += 1;
        });
      }

      ranked.some(function (item) {
        if (selected.length >= maxSources || reportSourceCount >= reportSourceLimit) return true;
        if (addItem(item, sourceReport)) reportSourceCount += 1;
        return selected.length >= maxSources || reportSourceCount >= reportSourceLimit;
      });
      return selected.length >= 4 || scannedReports >= 3;
    });

    return selected;
  }

  return {
    citationParts: citationParts,
    locatorText: locatorText,
    normalizeText: normalizeText,
    reportMetadataIntent: reportMetadataIntent,
    selectEvidence: selectEvidence,
    stripCitationMarkers: stripCitationMarkers
  };
});
