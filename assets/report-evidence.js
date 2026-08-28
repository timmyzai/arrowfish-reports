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
    ['risk', 'risks', 'blocker', 'blockers', 'blocked', '风险', '阻塞', '延迟', '缺口'],
    ['next', 'action', 'actions', 'plan', 'plans', 'roadmap', '下一步', '计划', '规划', '门槛'],
    ['status', 'state', 'progress', 'complete', 'completed', '状态', '进展', '完成', '验收'],
    ['revenue', 'income', 'sales', 'payment', 'paid', '收入', '营收', '付费', '订单', '金额'],
    ['user', 'users', 'registration', 'registrations', 'signup', '用户', '注册', '新增'],
    ['date', 'time', 'deadline', 'milestone', '日期', '时间', '截止', '里程碑'],
    ['compare', 'comparison', 'difference', 'versus', 'vs', '比较', '对比', '差异'],
    ['privacy', 'security', 'permission', 'access', '隐私', '安全', '权限', '访问'],
    ['release', 'launch', 'publish', 'deployment', '上线', '发布', '部署'],
    ['cost', 'saving', 'budget', '成本', '节省', '预算'],
    ['backup', 'restore', 'recovery', '备份', '恢复', '异地']
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

    function appendCitationText(text, sourceId) {
      var trailingWhitespace = (text.match(/\s*$/) || [''])[0];
      var visibleText = text.slice(0, text.length - trailingWhitespace.length);
      var sentenceEnd = visibleText.length;
      while (sentenceEnd > 0 && /[。！？；.!?;]/.test(visibleText.charAt(sentenceEnd - 1))) sentenceEnd -= 1;
      var boundary = -1;
      var sentencePattern = /[\n。！？；.!?;]/g;
      var sentenceMatch;
      while ((sentenceMatch = sentencePattern.exec(visibleText.slice(0, sentenceEnd)))) {
        boundary = sentenceMatch.index;
      }

      var linkStart = boundary + 1;
      while (/\s/.test(visibleText.charAt(linkStart))) linkStart += 1;
      appendText(visibleText.slice(0, linkStart));
      if (visibleText.slice(linkStart)) {
        parts.push({ type: 'citation', text: visibleText.slice(linkStart), sourceId: sourceId });
      }
    }

    while ((match = markerPattern.exec(content))) {
      var precedingText = content.slice(cursor, match.index);
      if (sourceIds.has(match[1])) appendCitationText(precedingText, match[1]);
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
      if (group.some(function (term) { return normalized.indexOf(term) !== -1; })) {
        tokens = tokens.concat(group);
      }
    });
    return Array.from(new Set(tokens));
  }

  function scoreBlock(report, block, currentTokens, contextTokens, overview, followUp) {
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

    var ranked = (report.blocks || []).map(function (block, index) {
      return {
        block: block,
        index: index,
        score: scoreBlock(report, block, currentTokens, contextTokens, overview, followUp)
      };
    }).filter(function (item) {
      return item.score >= (overview ? 5 : 3);
    }).sort(function (left, right) {
      return right.score - left.score || left.index - right.index;
    });

    var selected = [];
    var sectionCounts = Object.create(null);
    var usedChars = 0;

    function addItem(item) {
      var block = item.block;
      var sectionKey = normalizeText(block.section);
      if (overview && (sectionCounts[sectionKey] || 0) >= 2) return false;
      if (isNearDuplicate(block.text, selected)) return false;

      var cost = block.text.length + block.section.length + report.name.length + 40;
      if (selected.length && usedChars + cost > maxChars) return false;
      if (!selected.length && cost > maxChars) block = Object.assign({}, block, { text: block.text.slice(0, maxChars - 300) });

      selected.push({
        id: 'S' + (selected.length + 1),
        blockId: block.id,
        reportId: report.id,
        reportKey: report.file,
        reportTitle: report.name,
        reportDate: report.date,
        reportVersion: report.version,
        section: block.section,
        line: block.line,
        text: block.text
      });
      sectionCounts[sectionKey] = (sectionCounts[sectionKey] || 0) + 1;
      usedChars += cost;
      return true;
    }

    if (overview) {
      OVERVIEW_CATEGORIES.forEach(function (pattern) {
        if (selected.length >= maxSources) return;
        var candidate = ranked.find(function (item) {
          return pattern.test(item.block.section + ' ' + item.block.text) && !isNearDuplicate(item.block.text, selected);
        });
        if (candidate) addItem(candidate);
      });
    }

    ranked.some(function (item) {
      if (selected.length >= maxSources) return true;
      addItem(item);
      return selected.length >= maxSources;
    });

    return selected;
  }

  return {
    citationParts: citationParts,
    locatorText: locatorText,
    normalizeText: normalizeText,
    selectEvidence: selectEvidence,
    stripCitationMarkers: stripCitationMarkers
  };
});
