(function () {
  'use strict';

  var API_URL = 'https://arrowfish-report-ai.yang-fan-node.workers.dev/api/chat';
  var CONTEXT_URL = 'report-context.json';
  var STORAGE_KEY = 'arrowfish_ai_chat';
  var MAX_HISTORY_MESSAGES = 6;
  var MAX_QUESTION_CHARS = 1500;
  var REQUEST_TIMEOUT_MS = 35000;

  var Evidence = window.ArrowfishEvidence;
  var frame;
  var drawer;
  var backdrop;
  var launcher;
  var messagesEl;
  var reportTitleEl;
  var reportDateEl;
  var connectionEl;
  var connectionLabelEl;
  var form;
  var input;
  var sendButton;
  var statusEl;
  var quickButtons;
  var clearButton;
  var closeButton;
  var currentReport = null;
  var contextPromise = null;
  var messages = [];
  var busy = false;
  var lastFocusedElement = null;
  var activeController = null;
  var backdropTimer = null;
  var highlightTimer = null;
  var highlightedElement = null;
  var reportLoadToken = 0;

  function init() {
    var app = document.getElementById('app-content');
    frame = document.getElementById('report-frame');
    if (!app || !frame || !Evidence) return;

    buildInterface(app);
    bindEvents();
    contextPromise = loadContext();
    contextPromise.catch(function () {});

    new MutationObserver(function (mutations) {
      if (!mutations.some(function (mutation) { return mutation.attributeName === 'src'; })) return;
      resetForReportChange();
    }).observe(frame, { attributes: true, attributeFilter: ['src'] });

    if (frame.getAttribute('src')) handleReportLoad();
  }

  function buildInterface(app) {
    var wrapper = document.createElement('div');
    wrapper.innerHTML = [
      '<button class="ai-launcher" type="button" aria-label="打开 AI 报告助手" title="打开 AI 报告助手" aria-expanded="false" aria-controls="ai-drawer">',
      '  <img class="ai-launcher-icon" src="assets/ai-chatbot-icon.svg" width="64" height="64" alt="" aria-hidden="true">',
      '</button>',
      '<div class="ai-backdrop" hidden></div>',
      '<aside class="ai-drawer" id="ai-drawer" role="dialog" aria-modal="true" aria-labelledby="ai-title" aria-hidden="true">',
      '  <header class="ai-header">',
      '    <span class="ai-header-bot" aria-hidden="true"><img src="assets/ai-chatbot-icon.svg" width="40" height="40" alt=""></span>',
      '    <div class="ai-heading">',
      '      <h2 id="ai-title">AI 报告助手</h2>',
      '      <p class="ai-report-title">正在加载所选报告…</p>',
      '      <div class="ai-report-meta"><span class="ai-connection"><span class="ai-connection-dot" aria-hidden="true"></span><span class="ai-connection-label">正在连接</span></span><time class="ai-report-date"></time></div>',
      '    </div>',
      '    <div class="ai-header-actions">',
      '      <button class="ai-icon-button ai-clear" type="button" aria-label="清空对话" title="清空对话">',
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>',
      '      </button>',
      '      <button class="ai-icon-button ai-close" type="button" aria-label="关闭报告助手">',
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
      '      </button>',
      '    </div>',
      '  </header>',
      '  <div class="ai-quick-actions" aria-label="建议问题">',
      '    <button class="ai-quick-action" type="button" data-prompt="请用不超过五个要点总结本报告的主要内容。"><span aria-hidden="true">✦</span>主要内容</button>',
      '    <button class="ai-quick-action" type="button" data-prompt="请提供一份简短的执行摘要。"><span aria-hidden="true">≡</span>简短摘要</button>',
      '    <button class="ai-quick-action" type="button" data-prompt="本报告有哪些主要风险、阻碍和下一步行动？"><span aria-hidden="true">↗</span>风险与下一步</button>',
      '  </div>',
      '  <div class="ai-messages" role="log" aria-live="polite" aria-relevant="additions"></div>',
      '  <div class="ai-status" role="alert"></div>',
      '  <form class="ai-composer">',
      '    <label class="ai-sr-only" for="ai-question">询问所选报告的内容</label>',
      '    <div class="ai-composer-row">',
      '      <textarea id="ai-question" rows="1" maxlength="1500" placeholder="请输入关于本报告的问题…"></textarea>',
      '      <button class="ai-send" type="submit" aria-label="发送问题">',
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
      '      </button>',
      '    </div>',
      '    <p class="ai-note">回答仅基于本报告中的已验证依据。相关报告片段将发送至 Groq。</p>',
      '  </form>',
      '</aside>'
    ].join('');

    while (wrapper.firstChild) app.appendChild(wrapper.firstChild);

    launcher = app.querySelector('.ai-launcher');
    backdrop = app.querySelector('.ai-backdrop');
    drawer = app.querySelector('.ai-drawer');
    messagesEl = app.querySelector('.ai-messages');
    reportTitleEl = app.querySelector('.ai-report-title');
    reportDateEl = app.querySelector('.ai-report-date');
    connectionEl = app.querySelector('.ai-connection');
    connectionLabelEl = app.querySelector('.ai-connection-label');
    form = app.querySelector('.ai-composer');
    input = app.querySelector('#ai-question');
    sendButton = app.querySelector('.ai-send');
    statusEl = app.querySelector('.ai-status');
    quickButtons = Array.from(app.querySelectorAll('.ai-quick-action'));
    clearButton = app.querySelector('.ai-clear');
    closeButton = app.querySelector('.ai-close');
    drawer.inert = true;
    setReady(false);
    renderMessages();
  }

  function bindEvents() {
    launcher.addEventListener('click', function () { setOpen(true); });
    closeButton.addEventListener('click', function () { setOpen(false); });
    backdrop.addEventListener('click', function () { setOpen(false); });
    clearButton.addEventListener('click', clearConversation);
    frame.addEventListener('load', handleReportLoad);
    messagesEl.addEventListener('click', handleMessageClick);
    window.addEventListener('hashchange', revealLinkedDetail);
    window.addEventListener('popstate', revealLinkedDetail);

    quickButtons.forEach(function (button) {
      button.addEventListener('click', function () { sendQuestion(button.getAttribute('data-prompt')); });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      sendQuestion(input.value);
    });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    drawer.addEventListener('keydown', trapFocus);
  }

  async function loadContext() {
    var response = await fetch(CONTEXT_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error('无法加载报告上下文。');
    var payload = await response.json();
    if (!payload || !Array.isArray(payload.reports)) throw new Error('报告上下文格式无效。');
    return payload.reports;
  }

  function normalizeReportKey(value) {
    var key = String(value || '').replace(/^\.\//, '').split('#')[0];
    try {
      return decodeURIComponent(key);
    } catch (error) {
      return key;
    }
  }

  function resetForReportChange() {
    reportLoadToken += 1;
    if (activeController) activeController.abort();
    activeController = null;
    busy = false;
    clearSourceHighlight();
    currentReport = null;
    messages = [];
    removeSavedConversation();
    reportTitleEl.textContent = '正在加载所选报告…';
    reportDateEl.textContent = '';
    reportDateEl.removeAttribute('datetime');
    connectionEl.classList.remove('is-ready');
    connectionLabelEl.textContent = '正在连接';
    showStatus('');
    setReady(false);
    renderMessages();
  }

  async function handleReportLoad() {
    var token = ++reportLoadToken;
    var reportKey = normalizeReportKey(frame.getAttribute('src'));
    if (!reportKey) return;

    reportTitleEl.textContent = '正在索引所选报告…';
    setReady(false);
    try {
      var reports = await contextPromise;
      if (token !== reportLoadToken) return;
      var activePath = '';
      try {
        activePath = decodeURIComponent(frame.contentWindow.location.pathname || '');
      } catch (error) {}
      var nextReport = reports.find(function (report) {
        var key = normalizeReportKey(report.file);
        return activePath === '/' + key || activePath.endsWith('/' + key);
      }) || reports.find(function (report) {
        return normalizeReportKey(report.file) === reportKey;
      }) || null;
      if (!nextReport) throw new Error('所选报告尚未建立索引。');

      if (currentReport && (currentReport.file !== nextReport.file || currentReport.version !== nextReport.version)) {
        if (activeController) activeController.abort();
        activeController = null;
        busy = false;
        messages = [];
        removeSavedConversation();
        renderMessages();
      }
      currentReport = nextReport;

      reportTitleEl.textContent = displayReportName(currentReport);
      reportDateEl.textContent = currentReport.date;
      reportDateEl.setAttribute('datetime', currentReport.date);
      connectionEl.classList.add('is-ready');
      connectionLabelEl.textContent = '报告已连接';
      restoreConversation(currentReport.file);
      showStatus('');
      setReady(true);
      revealLinkedDetail();
    } catch (error) {
      if (token !== reportLoadToken) return;
      currentReport = null;
      reportTitleEl.textContent = '所选报告不可用';
      reportDateEl.textContent = '';
      connectionEl.classList.remove('is-ready');
      connectionLabelEl.textContent = '连接失败';
      setReady(false);
      showStatus(error && error.message ? error.message : '无法为所选报告建立索引。');
    }
  }

  function displayReportName(report) {
    return String(report.name || '').replace(/\s*[·—|-]\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim() || '所选报告';
  }

  function setOpen(open) {
    if (backdropTimer) {
      clearTimeout(backdropTimer);
      backdropTimer = null;
    }

    if (open) {
      lastFocusedElement = document.activeElement;
      backdrop.hidden = false;
      requestAnimationFrame(function () {
        backdrop.classList.add('is-open');
        drawer.classList.add('is-open');
      });
      drawer.setAttribute('aria-hidden', 'false');
      drawer.inert = false;
      launcher.setAttribute('aria-expanded', 'true');
      setTimeout(function () {
        if (!drawer.classList.contains('is-open')) return;
        var preferredFocus = input.disabled ? closeButton : input;
        preferredFocus.focus();
      }, 230);
      return;
    }

    backdrop.classList.remove('is-open');
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.inert = true;
    launcher.setAttribute('aria-expanded', 'false');
    backdropTimer = setTimeout(function () {
      backdrop.hidden = true;
      backdropTimer = null;
    }, 220);
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') lastFocusedElement.focus();
  }

  function trapFocus(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;

    var focusable = Array.from(drawer.querySelectorAll('button:not(:disabled), textarea:not(:disabled)'));
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function restoreConversation(reportKey) {
    messages = [];
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
      if (saved && saved.reportKey === reportKey && saved.reportVersion === currentReport.version && Array.isArray(saved.messages)) {
        messages = saved.messages.slice(-MAX_HISTORY_MESSAGES).filter(isValidMessage);
      }
    } catch (error) {}
    renderMessages();
  }

  function isValidMessage(message) {
    return message && (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' && message.content.length > 0;
  }

  function saveConversation() {
    if (!currentReport) return;
    messages = messages.slice(-MAX_HISTORY_MESSAGES);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        reportKey: currentReport.file,
        reportVersion: currentReport.version,
        messages: messages
      }));
    } catch (error) {}
  }

  function removeSavedConversation() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (error) {}
  }

  function clearConversation() {
    messages = [];
    removeSavedConversation();
    showStatus('');
    renderMessages();
    input.focus();
  }

  function renderMessages() {
    messagesEl.textContent = '';
    if (!messages.length) {
      var empty = document.createElement('div');
      empty.className = 'ai-empty';
      if (currentReport) {
        empty.innerHTML = '<span class="ai-empty-icon" aria-hidden="true">✦</span><strong>从这份报告开始</strong><span>询问进展、数字、决定或风险。每个事实都会附上可点击的原文依据。</span>';
      } else {
        empty.textContent = '请先打开一份报告，然后开始提问。';
      }
      messagesEl.appendChild(empty);
      return;
    }

    messages.forEach(function (message, messageIndex) {
      var item = document.createElement('div');
      item.className = 'ai-message-group ' + message.role;
      var bubble = document.createElement('div');
      bubble.className = 'ai-message ' + message.role + (message.answerable === false ? ' refusal' : '');

      if (message.role === 'assistant') renderAnswer(bubble, message, messageIndex);
      else bubble.textContent = message.content;

      item.appendChild(bubble);
      if (message.role === 'assistant' && Array.isArray(message.sources) && message.sources.length) {
        item.appendChild(renderSourceList(message.sources, messageIndex));
      }
      if (message.role === 'assistant' && message.answerable !== false) {
        item.appendChild(renderMessageActions(message, messageIndex));
      }
      messagesEl.appendChild(item);
    });
    scrollMessages();
  }

  function renderMessageActions(message, messageIndex) {
    var actions = document.createElement('div');
    actions.className = 'ai-message-actions';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ai-message-action';
    copy.dataset.copyMessage = String(messageIndex);
    copy.setAttribute('aria-label', '复制这条回答');
    copy.textContent = '复制回答';
    actions.appendChild(copy);

    if (Array.isArray(message.sources) && message.sources.length) {
      var count = document.createElement('span');
      count.textContent = message.sources.length + ' 条已验证依据';
      actions.appendChild(count);
    }
    return actions;
  }

  function renderAnswer(container, message, messageIndex) {
    var sourceIds = new Set((message.sources || []).map(function (source) { return source.id; }));
    var pattern = /\[(S\d+)\]/g;
    var cursor = 0;
    var match;

    while ((match = pattern.exec(message.content))) {
      container.appendChild(document.createTextNode(message.content.slice(cursor, match.index)));
      if (sourceIds.has(match[1])) {
        var source = (message.sources || []).find(function (item) { return item.id === match[1]; });
        var link = document.createElement('a');
        link.className = 'ai-citation';
        link.href = detailHref(source);
        link.dataset.messageIndex = String(messageIndex);
        link.dataset.sourceId = match[1];
        link.setAttribute('aria-label', '查看报告详情：' + (source.section || match[1]));
        link.title = '查看报告详情';
        link.textContent = match[1].slice(1);
        container.appendChild(link);
      } else {
        container.appendChild(document.createTextNode(match[0]));
      }
      cursor = pattern.lastIndex;
    }
    container.appendChild(document.createTextNode(message.content.slice(cursor)));
  }

  function renderSourceList(sources, messageIndex) {
    var wrapper = document.createElement('div');
    wrapper.className = 'ai-sources';
    var label = document.createElement('div');
    label.className = 'ai-sources-label';
    label.textContent = '相关详情';
    wrapper.appendChild(label);

    sources.forEach(function (source) {
      var link = document.createElement('a');
      link.className = 'ai-source-link';
      link.href = detailHref(source);
      link.dataset.messageIndex = String(messageIndex);
      link.dataset.sourceId = source.id;

      var content = document.createElement('span');
      content.className = 'ai-source-content';
      var heading = document.createElement('strong');
      heading.textContent = (source.reportTitle || '当前报告') + ' · ' + (source.section || '报告概览');
      var quote = document.createElement('q');
      quote.textContent = source.quote || '';
      content.appendChild(heading);
      content.appendChild(quote);
      var arrow = document.createElement('span');
      arrow.className = 'ai-source-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↗';
      link.appendChild(content);
      link.appendChild(arrow);
      wrapper.appendChild(link);
    });
    return wrapper;
  }

  function detailHref(source) {
    if (!source) return '#';
    return '#' + [source.reportId, source.reportDate, source.blockId]
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
  }

  function handleMessageClick(event) {
    var copyTarget = event.target.closest('[data-copy-message]');
    if (copyTarget) {
      copyMessage(Number(copyTarget.dataset.copyMessage), copyTarget);
      return;
    }
    var target = event.target.closest('[data-source-id]');
    if (!target) return;
    event.preventDefault();
    var message = messages[Number(target.dataset.messageIndex)];
    var source = message && (message.sources || []).find(function (item) {
      return item.id === target.dataset.sourceId;
    });
    if (source) {
      history.pushState(null, '', detailHref(source));
      revealSource(source);
    }
  }

  async function copyMessage(messageIndex, button) {
    var message = messages[messageIndex];
    if (!message || !message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      button.textContent = '已复制';
      setTimeout(function () { button.textContent = '复制回答'; }, 1600);
    } catch (error) {
      showStatus('无法复制回答，请手动选择文字。');
    }
  }

  function revealSource(source) {
    if (!currentReport || source.reportKey !== currentReport.file || source.reportVersion !== currentReport.version) {
      showStatus('这条依据不属于当前报告版本，无法打开。');
      return;
    }
    var doc;
    try { doc = frame.contentDocument; } catch (error) { doc = null; }
    if (!doc) {
      showStatus('无法打开报告依据。');
      return;
    }

    var block = source.blockId && (currentReport.blocks || []).find(function (item) {
      return item.id === source.blockId;
    });
    var blockText = Evidence.normalizeText(block && block.text);
    var quote = Evidence.normalizeText(source.quote || (block && block.text));
    if (!quote) {
      showStatus('这条依据没有可定位的报告内容。');
      return;
    }
    var candidates = typedBlockCandidates(doc, block);
    var duplicateIndex = duplicateBlockIndex(currentReport.blocks || [], block);
    var exactMatches = candidates.filter(function (element) {
      return blockText && Evidence.normalizeText(element.textContent) === blockText;
    });
    var exactMatch = exactMatches[duplicateIndex] || exactMatches[0] || null;
    var match = candidates.map(function (element) {
      var text = Evidence.normalizeText(element.textContent);
      var score = 0;
      if (blockText && text === blockText) score = 100;
      else if (blockText && text.indexOf(blockText) !== -1) score = 70;
      else if (text === quote) score = 60;
      else if (text.indexOf(quote) !== -1) score = 40;
      return { element: element, score: score, length: text.length };
    }).filter(function (candidate) {
      return candidate.score > 0;
    }).sort(function (left, right) {
      return right.score - left.score || left.length - right.length;
    })[0];
    match = exactMatch || (match && match.element);

    if (!match) {
      showStatus('当前报告版本中已找不到这段引用内容。');
      return;
    }

    var ancestor = match;
    while (ancestor) {
      if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      ancestor = ancestor.parentElement;
    }

    setOpen(false);
    setTimeout(function () {
      installHighlightStyle(doc);
      clearSourceHighlight();
      highlightedElement = match;
      match.classList.add('ai-report-highlight');
      if (!match.hasAttribute('tabindex')) match.setAttribute('tabindex', '-1');
      var reduceMotion = frame.contentWindow && frame.contentWindow.matchMedia &&
        frame.contentWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
      match.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      match.focus({ preventScroll: true });
      highlightTimer = setTimeout(function () {
        clearSourceHighlight();
      }, 4000);
    }, 230);
  }

  function typedBlockCandidates(doc, block) {
    var selectors = {
      p: 'p',
      li: 'li',
      'table-row': 'tr',
      'details-summary': 'summary',
      dt: 'dt',
      dd: 'dd',
      blockquote: 'blockquote',
      pre: 'pre',
      highlight: 'div, article'
    };
    var selector = selectors[block && block.type] ||
      'p, li, tr, summary, dt, dd, blockquote, pre, div, article';
    return Array.from(doc.querySelectorAll(selector));
  }

  function duplicateBlockIndex(blocks, target) {
    if (!target) return 0;
    var targetText = Evidence.normalizeText(target.text);
    var occurrence = 0;
    for (var index = 0; index < blocks.length; index += 1) {
      var block = blocks[index];
      if (block.id === target.id) return occurrence;
      if (block.type === target.type && Evidence.normalizeText(block.text) === targetText) occurrence += 1;
    }
    return 0;
  }

  function installHighlightStyle(doc) {
    if (doc.getElementById('ai-report-highlight-style')) return;
    var style = doc.createElement('style');
    style.id = 'ai-report-highlight-style';
    style.textContent = '.ai-report-highlight{outline:3px solid #b45309!important;outline-offset:4px!important;background:#fff4ce!important;border-radius:4px;scroll-margin-block:24px}.ai-report-highlight:focus{outline:3px solid #b45309!important}';
    (doc.head || doc.documentElement).appendChild(style);
  }

  function clearSourceHighlight() {
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = null;
    if (highlightedElement && highlightedElement.isConnected) {
      highlightedElement.classList.remove('ai-report-highlight');
    }
    highlightedElement = null;
  }

  function revealLinkedDetail() {
    if (!currentReport) return;
    var parts;
    try {
      parts = decodeURIComponent(location.hash.slice(1)).split('/');
    } catch (error) {
      return;
    }
    var blockId = parts[2];
    if (!blockId || parts[0] !== currentReport.id || parts[1] !== currentReport.date) return;
    var block = (currentReport.blocks || []).find(function (item) { return item.id === blockId; });
    if (!block) return;
    revealSource({
      reportKey: currentReport.file,
      reportVersion: currentReport.version,
      reportId: currentReport.id,
      reportDate: currentReport.date,
      blockId: block.id,
      section: block.section,
      quote: block.text
    });
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    drawer.setAttribute('aria-busy', busy ? 'true' : 'false');
    setReady(Boolean(currentReport));
    if (busy) {
      var loading = document.createElement('div');
      loading.className = 'ai-loading';
      loading.setAttribute('aria-label', '报告助手正在核对报告依据');
      loading.innerHTML = '<span></span><span></span><span></span>';
      messagesEl.appendChild(loading);
      scrollMessages();
    }
  }

  function setReady(ready) {
    var disabled = !ready || busy;
    input.disabled = disabled;
    sendButton.disabled = disabled;
    clearButton.disabled = busy;
    quickButtons.forEach(function (button) { button.disabled = disabled; });
  }

  function showStatus(message) {
    statusEl.textContent = message || '';
  }

  function scrollMessages() {
    requestAnimationFrame(function () { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  async function sendQuestion(value) {
    var question = String(value || '').trim().slice(0, MAX_QUESTION_CHARS);
    if (!question || !currentReport || busy) return;

    var reportKey = currentReport.file;
    var requestReportToken = reportLoadToken;
    var recentConversation = messages.slice(-MAX_HISTORY_MESSAGES).filter(function (message) {
      return isValidMessage(message) && message.role === 'user';
    }).map(function (message) {
      return message.content;
    });
    var conversation = messages.slice(-MAX_HISTORY_MESSAGES).filter(isValidMessage).map(function (message) {
      return { role: message.role, content: message.content };
    });
    var sources = Evidence.selectEvidence(currentReport, question, recentConversation, {
      maxSources: 8,
      maxChars: 7000
    });

    messages.push({ role: 'user', content: question });
    messages = messages.slice(-MAX_HISTORY_MESSAGES);
    input.value = '';
    input.style.height = 'auto';
    showStatus('');

    renderMessages();
    saveConversation();

    if (!sources.length) {
      messages.push({
        role: 'assistant',
        content: '本报告没有可直接支持该问题的相关信息。',
        answerable: false,
        sources: [],
        meta: { result: 'no_local_evidence', reportVersion: currentReport.version }
      });
      messages = messages.slice(-MAX_HISTORY_MESSAGES);
      renderMessages();
      saveConversation();
      input.focus();
      return;
    }

    setBusy(true);

    var controller = new AbortController();
    var timedOut = false;
    var timeout = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    activeController = controller;

    try {
      var response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          question: question,
          report: {
            id: currentReport.id,
            key: currentReport.file,
            title: currentReport.name,
            date: currentReport.date,
            version: currentReport.version
          },
          sources: sources,
          conversation: conversation
        })
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (response.status === 429) {
          var retrySeconds = Number(response.headers.get('Retry-After') || 0);
          throw new Error(retrySeconds > 0
            ? '报告助手当前繁忙，请约 ' + Math.ceil(retrySeconds) + ' 秒后再试。'
            : '报告助手当前繁忙，请稍后再试。');
        }
        throw new Error(payload.error || '报告助手暂时无法回答，请稍后再试。');
      }
      if (!currentReport || currentReport.file !== reportKey || reportLoadToken !== requestReportToken) return;
      if (typeof payload.answer !== 'string') throw new Error('报告助手返回了无效回答。');

      messages.push({
        role: 'assistant',
        content: payload.answer,
        answerable: payload.answerable === true,
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        meta: payload.meta || null
      });
      messages = messages.slice(-MAX_HISTORY_MESSAGES);
      saveConversation();
    } catch (error) {
      if (timedOut) {
        showStatus('报告助手响应超时，请重试。');
      } else if (!error || error.name !== 'AbortError') {
        showStatus(error && error.message ? error.message : '报告助手暂时无法回答，请稍后再试。');
      }
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) {
        activeController = null;
        renderMessages();
        setBusy(false);
        input.focus();
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
