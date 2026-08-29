(function () {
  'use strict';

  var API_URL = 'https://arrowfish-report-ai.yang-fan-node.workers.dev/api/chat';
  var CONTEXT_URLS = { 'zh-CN': 'report-context.json', en: 'report-context.en.json' };
  var INDEX_URLS = { 'zh-CN': 'report-index.json', en: 'report-index.en.json' };
  var STORAGE_KEY = 'arrowfish_ai_chat';
  var MAX_HISTORY_MESSAGES = 6;
  var MAX_QUESTION_CHARS = 1500;
  var TIMELINE_INTENT_RE = /时间线|时间表|排期|进度表|什么时候|何时|多久|预计|上线时间|发布日期|交付日期|estimate|timeline|schedule|\bwhen\b|\beta\b|launch date|release date|delivery date/i;
  var REQUEST_TIMEOUT_MS = 35000;

  var Evidence = window.ArrowfishEvidence;
  var Brief = window.ArrowfishBrief;
  var frame;
  var strip;
  var stripText;
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
  var handoffEl;
  var clearButton;
  var closeButton;
  var currentReport = null;
  var allReports = [];
  var reportIndex = null;
  var contextPromises = Object.create(null);
  var messages = [];
  var busy = false;
  var lastFocusedElement = null;
  var activeController = null;
  var backdropTimer = null;
  var highlightTimer = null;
  var highlightedElement = null;
  var reportLoadToken = 0;
  var pendingChatNavigation = null;
  var preserveMessagesOnLoad = false;
  var lastPreferenceLanguage = uiLocale();

  function t(key, params) {
    return window.ArrowfishI18n ? window.ArrowfishI18n.t(key, params) : key;
  }

  function tn(key, count, params) {
    return window.ArrowfishI18n ? window.ArrowfishI18n.tn(key, count, params) : String(count);
  }

  function uiLocale() {
    return window.ArrowfishI18n ? window.ArrowfishI18n.getLanguage() : 'zh-CN';
  }

  function responseLocale(question) {
    return window.ArrowfishPreferences
      ? window.ArrowfishPreferences.detectQuestionLanguage(question)
      : (/[\u3400-\u9fff]/.test(String(question || '')) ? 'zh-CN' : 'en');
  }

  function init() {
    var app = document.getElementById('app-content');
    frame = document.getElementById('report-frame');
    if (!app || !frame || !Evidence || !Brief) return;

    buildInterface(app);
    bindEvents();
    loadContext(uiLocale()).catch(function () {});

    new MutationObserver(function (mutations) {
      if (!mutations.some(function (mutation) { return mutation.attributeName === 'src'; })) return;
      resetForReportChange();
    }).observe(frame, { attributes: true, attributeFilter: ['src'] });

    if (frame.getAttribute('src')) handleReportLoad();
  }

  function buildInterface(app) {
    var wrapper = document.createElement('div');
    wrapper.innerHTML = [
      '<button class="ai-launcher" type="button" aria-label="' + t('ai.open') + '" title="' + t('ai.open') + '" aria-expanded="false" aria-controls="ai-drawer">',
      '  <img class="ai-launcher-icon" src="assets/ai-chatbot-icon.svg" width="64" height="64" alt="" aria-hidden="true">',
      '</button>',
      '<div class="ai-backdrop" hidden></div>',
      '<aside class="ai-drawer" id="ai-drawer" role="dialog" aria-modal="true" aria-labelledby="ai-title" aria-hidden="true">',
      '  <header class="ai-header">',
      '    <span class="ai-header-bot" aria-hidden="true"><img src="assets/ai-chatbot-icon.svg" width="40" height="40" alt=""></span>',
      '    <div class="ai-heading">',
      '      <h2 id="ai-title">' + t('ai.title') + '</h2>',
      '      <p class="ai-report-title">' + t('ai.loadingReport') + '</p>',
      '      <div class="ai-report-meta"><span class="ai-connection"><span class="ai-connection-dot" aria-hidden="true"></span><span class="ai-connection-label">' + t('ai.connecting') + '</span></span><time class="ai-report-date"></time></div>',
      '    </div>',
      '    <div class="ai-header-actions">',
      '      <button class="ai-icon-button ai-clear" type="button" aria-label="' + t('ai.clear') + '" title="' + t('ai.clear') + '">',
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>',
      '      </button>',
      '      <button class="ai-icon-button ai-close" type="button" aria-label="' + t('ai.close') + '">',
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
      '      </button>',
      '    </div>',
      '  </header>',
      '  <div class="ai-quick-actions" aria-label="' + t('ai.suggestions') + '">',
      '    <button class="ai-quick-action" type="button" data-action="roadmap"><span aria-hidden="true">⌁</span><span data-ai-label="roadmap">' + t('ai.roadmap') + '</span></button>',
      '    <button class="ai-quick-action" type="button" data-action="results"><span aria-hidden="true">✦</span><span data-ai-label="results">' + t('ai.results') + '</span></button>',
      '    <button class="ai-quick-action" type="button" data-action="blockers"><span aria-hidden="true">!</span><span data-ai-label="blockers">' + t('ai.blockers') + '</span></button>',
      '    <button class="ai-quick-action" type="button" data-action="portfolio"><span aria-hidden="true">◇</span><span data-ai-label="portfolio">' + t('ai.portfolio') + '</span></button>',
      '  </div>',
      '  <div class="ai-handoff" hidden></div>',
      '  <div class="ai-messages" role="log" aria-live="polite" aria-relevant="additions"></div>',
      '  <div class="ai-status" role="alert"></div>',
      '  <form class="ai-composer">',
      '    <label class="ai-sr-only" for="ai-question">' + t('ai.questionLabel') + '</label>',
      '    <div class="ai-composer-row">',
      '      <textarea id="ai-question" rows="1" maxlength="1500" placeholder="' + t('ai.placeholder') + '"></textarea>',
      '      <button class="ai-send" type="submit" aria-label="' + t('ai.send') + '">',
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
      '      </button>',
      '    </div>',
      '    <p class="ai-note">' + t('ai.note') + '</p>',
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
    handoffEl = app.querySelector('.ai-handoff');
    clearButton = app.querySelector('.ai-clear');
    closeButton = app.querySelector('.ai-close');
    strip = document.getElementById('ai-brief-strip');
    stripText = strip && strip.querySelector('.ai-strip-text');
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
    window.addEventListener('arrowfish:preferenceschange', handlePreferenceChange);

    quickButtons.forEach(function (button) {
      button.addEventListener('click', function () { renderShortcut(button.getAttribute('data-action')); });
    });
    handoffEl.addEventListener('click', function (event) {
      var link = event.target.closest('[data-report-key]');
      if (!link) return;
      event.preventDefault();
      pendingChatNavigation = { reportKey: link.dataset.reportKey };
      location.hash = link.getAttribute('href');
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
    if (strip) {
      strip.addEventListener('click', function () { setOpen(true); });
    }
  }

  function localizeInterface() {
    launcher.setAttribute('aria-label', t('ai.open'));
    launcher.title = t('ai.open');
    drawer.querySelector('#ai-title').textContent = t('ai.title');
    clearButton.setAttribute('aria-label', t('ai.clear'));
    clearButton.title = t('ai.clear');
    closeButton.setAttribute('aria-label', t('ai.close'));
    drawer.querySelector('.ai-quick-actions').setAttribute('aria-label', t('ai.suggestions'));
    ['roadmap', 'results', 'blockers', 'portfolio'].forEach(function (action) {
      var label = drawer.querySelector('[data-ai-label="' + action + '"]');
      if (label) label.textContent = t('ai.' + action);
    });
    drawer.querySelector('label[for="ai-question"]').textContent = t('ai.questionLabel');
    input.placeholder = t('ai.placeholder');
    sendButton.setAttribute('aria-label', t('ai.send'));
    drawer.querySelector('.ai-note').textContent = t('ai.note');
  }

  function handlePreferenceChange(event) {
    var nextLanguage = event.detail && event.detail.language || uiLocale();
    if (nextLanguage === lastPreferenceLanguage) return;
    lastPreferenceLanguage = nextLanguage;
    if (activeController) activeController.abort();
    activeController = null;
    busy = false;
    messages = [];
    removeSavedConversation();
    allReports = [];
    reportIndex = null;
    currentReport = null;
    localizeInterface();
    resetForReportChange();
    handleReportLoad();
  }

  async function loadContext(locale) {
    locale = locale === 'en' ? 'en' : 'zh-CN';
    if (contextPromises[locale]) return contextPromises[locale];
    contextPromises[locale] = load();
    return contextPromises[locale];

    async function load() {
    var responses = await Promise.all([
      fetch(CONTEXT_URLS[locale], { cache: 'no-cache' }),
      fetch(INDEX_URLS[locale], { cache: 'no-cache' })
    ]);
    if (!responses[0].ok || !responses[1].ok) throw new Error(t('ai.contextLoadFailed'));
    var payloads = await Promise.all(responses.map(function (response) { return response.json(); }));
    if (!payloads[0] || !Array.isArray(payloads[0].reports)) throw new Error(t('ai.contextInvalid'));
    if (payloads[0].locale && payloads[0].locale !== locale) throw new Error(t('ai.contextInvalid'));
    if (!payloads[1] || !Array.isArray(payloads[1].order) || !payloads[1].workstreams) throw new Error(t('ai.indexInvalid'));
    if (payloads[1].locale && payloads[1].locale !== locale) throw new Error(t('ai.indexInvalid'));
    return { reports: payloads[0].reports, index: payloads[1] };
    }
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
    var nextKey = normalizeReportKey(frame.getAttribute('src'));
    preserveMessagesOnLoad = Boolean(
      pendingChatNavigation && normalizeReportKey(pendingChatNavigation.reportKey) === nextKey
    );
    reportLoadToken += 1;
    if (activeController) activeController.abort();
    activeController = null;
    busy = false;
    clearSourceHighlight();
    currentReport = null;
    if (!preserveMessagesOnLoad) {
      messages = [];
      removeSavedConversation();
    }
    reportTitleEl.textContent = t('ai.loadingReport');
    reportDateEl.textContent = '';
    reportDateEl.removeAttribute('datetime');
    connectionEl.classList.remove('is-ready');
    connectionLabelEl.textContent = t('ai.connecting');
    showStatus('');
    setReady(false);
    updateStrip(null);
    renderMessages();
  }

  async function handleReportLoad() {
    var token = ++reportLoadToken;
    var reportKey = normalizeReportKey(frame.getAttribute('src'));
    if (!reportKey) return;

    reportTitleEl.textContent = t('ai.indexingReport');
    setReady(false);
    try {
      var data = await loadContext(uiLocale());
      if (token !== reportLoadToken) return;
      var reports = data.reports;
      allReports = reports;
      reportIndex = data.index;
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
      if (!nextReport) throw new Error(t('ai.reportNotIndexed'));

      var preserveConversation = preserveMessagesOnLoad && pendingChatNavigation &&
        normalizeReportKey(pendingChatNavigation.reportKey) === normalizeReportKey(nextReport.file);
      if (!preserveConversation && currentReport && (currentReport.file !== nextReport.file || currentReport.version !== nextReport.version)) {
        if (activeController) activeController.abort();
        activeController = null;
        busy = false;
        messages = [];
        removeSavedConversation();
        renderMessages();
      }
      currentReport = nextReport;
      try { annotateReportBlocks(frame.contentDocument, currentReport); } catch (error) {}

      reportTitleEl.textContent = displayReportName(currentReport);
      reportDateEl.textContent = displayReportDate(currentReport.date);
      reportDateEl.setAttribute('datetime', currentReport.date);
      connectionEl.classList.add('is-ready');
      connectionLabelEl.textContent = t('ai.connected');
      if (preserveConversation) {
        pendingChatNavigation = null;
        preserveMessagesOnLoad = false;
        saveConversation();
        renderMessages();
      } else {
        pendingChatNavigation = null;
        preserveMessagesOnLoad = false;
        restoreConversation(currentReport.file);
      }
      updateHandoff();
      showStatus('');
      setReady(true);
      showBrief();
      revealLinkedDetail();
    } catch (error) {
      if (token !== reportLoadToken) return;
      currentReport = null;
      reportTitleEl.textContent = t('ai.reportUnavailable');
      reportDateEl.textContent = '';
      connectionEl.classList.remove('is-ready');
      connectionLabelEl.textContent = t('ai.connectionFailed');
      setReady(false);
      showStatus(error && error.message ? error.message : t('ai.indexFailed'));
    }
  }

  function displayReportName(report) {
    return String(report.name || '').replace(/\s*[·—|-]\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim() || t('ai.selectedReport');
  }

  function displayReportDate(value) {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat(uiLocale() === 'en' ? 'en' : 'zh-CN', {
        dateStyle: 'medium',
        timeZone: 'UTC'
      }).format(new Date(value + 'T00:00:00Z'));
    } catch (error) {
      return value;
    }
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
      if (saved && saved.locale === uiLocale() && saved.reportKey === reportKey && saved.reportVersion === currentReport.version && Array.isArray(saved.messages)) {
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
        locale: uiLocale(),
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
        empty.innerHTML = '<span class="ai-empty-icon" aria-hidden="true">✦</span><strong></strong><span></span>';
        empty.querySelector('strong').textContent = t('ai.emptyTitle');
        empty.querySelector('span:last-child').textContent = t('ai.emptyBody');
        empty.appendChild(renderStarters());
      } else {
        empty.textContent = t('ai.emptyNoReport');
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
      if (message.role === 'assistant' && message.answerable !== false) {
        item.appendChild(renderMessageActions(message, messageIndex));
      }
      if (message.role === 'assistant' && Array.isArray(message.followUps) && message.followUps.length) {
        item.appendChild(renderFollowUps(message.followUps));
      }
      messagesEl.appendChild(item);
    });
    scrollMessages();
  }

  function renderStarters() {
    var wrapper = document.createElement('div');
    wrapper.className = 'ai-starters';
    var heading = document.createElement('span');
    heading.className = 'ai-starters-heading';
    heading.textContent = t('ai.starterHeading');
    wrapper.appendChild(heading);
    ['ai.starter1', 'ai.starter2', 'ai.starter3', 'ai.starter4', 'ai.starter5', 'ai.starter6'].forEach(function (key) {
      var question = t(key);
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ai-starter';
      button.dataset.followUp = question;
      button.textContent = question;
      wrapper.appendChild(button);
    });
    return wrapper;
  }

  function corpusScope() {
    return {
      reports: allReports.length,
      blocks: allReports.reduce(function (total, report) {
        return total + ((report.blocks || []).length);
      }, 0)
    };
  }

  function renderMessageActions(message, messageIndex) {
    var actions = document.createElement('div');
    actions.className = 'ai-message-actions';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ai-message-action';
    copy.dataset.copyMessage = String(messageIndex);
    copy.setAttribute('aria-label', t('ai.copyAnswerLabel'));
    copy.textContent = t('ai.copyAnswer');
    actions.appendChild(copy);

    if (message.meta && message.meta.result === 'local_brief') {
      var explain = document.createElement('button');
      explain.type = 'button';
      explain.className = 'ai-message-action ai-explain';
      explain.dataset.explain = 'brief';
      explain.textContent = t('ai.explain');
      actions.appendChild(explain);
    }

    if (Array.isArray(message.sources) && message.sources.length) {
      var count = document.createElement('span');
      count.textContent = tn('ai.sources', message.sources.length);
      actions.appendChild(count);
    }

    if (message.meta && message.meta.result && message.meta.result.indexOf('local_') !== 0) {
      var scope = document.createElement('span');
      scope.className = 'ai-scope';
      scope.textContent = t('ai.searchScope', corpusScope());
      actions.appendChild(scope);
    }
    return actions;
  }

  function renderAnswer(container, message, messageIndex) {
    var sources = message.sources || [];
    var sourceMap = new Map(sources.map(function (source) { return [source.id, source]; }));
    Evidence.citationParts(message.content, Array.from(sourceMap.keys())).forEach(function (part) {
      if (part.type === 'citation') {
        var source = sourceMap.get(part.sourceId);
        var superscript = document.createElement('sup');
        superscript.className = 'ai-citation-chip';
        var link = document.createElement('a');
        link.className = 'ai-citation';
        link.href = detailHref(source);
        link.dataset.messageIndex = String(messageIndex);
        link.dataset.sourceId = source.id;
        link.setAttribute('aria-label', t('ai.viewEvidence', {
          id: source.id,
          report: source.reportTitle || t('ai.report'),
          section: source.section || t('ai.reportOverview')
        }));
        link.title = [
          source.reportTitle || t('ai.report'),
          displayReportDate(source.reportDate) || '',
          source.section || t('ai.reportOverview'),
          source.quote || source.text || ''
        ].filter(Boolean).join('\n');
        link.textContent = source.id;
        superscript.appendChild(link);
        container.appendChild(superscript);
      } else {
        container.appendChild(document.createTextNode(part.text));
      }
    });
  }

  function renderFollowUps(followUps) {
    var wrapper = document.createElement('div');
    wrapper.className = 'ai-follow-ups';
    followUps.slice(0, 3).forEach(function (followUp) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ai-follow-up';
      button.dataset.followUp = followUp.question;
      button.textContent = followUp.label;
      wrapper.appendChild(button);
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
    var explainTarget = event.target.closest('[data-explain]');
    if (explainTarget) {
      sendQuestion(t('ai.explainQuestion'));
      return;
    }
    var followUpTarget = event.target.closest('[data-follow-up]');
    if (followUpTarget) {
      sendQuestion(followUpTarget.dataset.followUp);
      return;
    }
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
      revealSource(source);
    }
  }

  async function copyMessage(messageIndex, button) {
    var message = messages[messageIndex];
    if (!message || !message.content) return;
    try {
      await navigator.clipboard.writeText(Evidence.stripCitationMarkers(message.content));
      button.textContent = t('ai.copied');
      setTimeout(function () { button.textContent = t('ai.copyAnswer'); }, 1600);
    } catch (error) {
      showStatus(t('ai.copyFailed'));
    }
  }

  function revealSource(source) {
    if (!currentReport) return;
    if (source.reportKey !== currentReport.file) {
      pendingChatNavigation = { reportKey: source.reportKey };
      location.hash = detailHref(source);
      return;
    }
    if (source.reportVersion !== currentReport.version) {
      showStatus(t('ai.evidenceWrongVersion'));
      return;
    }
    var doc;
    try { doc = frame.contentDocument; } catch (error) { doc = null; }
    if (!doc) {
      showStatus(t('ai.evidenceOpenFailed'));
      return;
    }

    var block = source.blockId && (currentReport.blocks || []).find(function (item) {
      return item.id === source.blockId;
    });
    var blockText = Evidence.locatorText(block && block.text);
    var quote = Evidence.locatorText(source.quote || (block && block.text));
    if (!quote) {
      showStatus(t('ai.evidenceMissing'));
      return;
    }
    var stableMatch = source.blockId && doc.querySelector('[data-report-block-id="' + source.blockId.replace(/"/g, '\\"') + '"]');
    var candidates = typedBlockCandidates(doc, block);
    var duplicateIndex = duplicateBlockIndex(currentReport.blocks || [], block);
    var exactMatches = candidates.filter(function (element) {
      return blockText && Evidence.locatorText(element.textContent) === blockText;
    });
    var exactMatch = exactMatches[duplicateIndex] || exactMatches[0] || null;
    var match = candidates.map(function (element) {
      var text = Evidence.locatorText(element.textContent);
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
    match = stableMatch || exactMatch || (match && match.element);

    if (!match) {
      showStatus(t('ai.evidenceNotFound'));
      return;
    }

    var ancestor = match;
    while (ancestor) {
      if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      ancestor = ancestor.parentElement;
    }

    setOpen(false);
    setTimeout(function () {
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
      highlight: 'div, article',
      heading: 'h1, h2, h3, h4, h5, h6'
    };
    var selector = selectors[block && block.type] ||
      'p, li, tr, summary, dt, dd, blockquote, pre, div, article';
    return Array.from(doc.querySelectorAll(selector));
  }

  function annotateReportBlocks(doc, report) {
    if (!doc || !report) return;
    (report.blocks || []).forEach(function (block) {
      var expected = Evidence.locatorText(block.text);
      var occurrence = duplicateBlockIndex(report.blocks || [], block);
      var matches = typedBlockCandidates(doc, block).filter(function (element) {
        return Evidence.locatorText(element.textContent) === expected;
      });
      var element = matches[occurrence] || matches[0];
      if (element) element.dataset.reportBlockId = block.id;
    });
  }

  function duplicateBlockIndex(blocks, target) {
    if (!target) return 0;
    var targetText = Evidence.locatorText(target.text);
    var occurrence = 0;
    for (var index = 0; index < blocks.length; index += 1) {
      var block = blocks[index];
      if (block.id === target.id) return occurrence;
      if (block.type === target.type && Evidence.locatorText(block.text) === targetText) occurrence += 1;
    }
    return 0;
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

  function updateHandoff() {
    handoffEl.textContent = '';
    handoffEl.hidden = true;
    if (!currentReport || !reportIndex || !/\/Goal-|^goal-/.test(currentReport.file + currentReport.id)) return;
    var target = reportIndex.order.map(function (reportId) {
      return allReports.find(function (report) { return report.id === reportId; });
    }).find(function (report) {
      return report && report.id !== currentReport.id && !/\/Goal-|^goal-/.test(report.file + report.id);
    });
    if (!target) return;
    var link = document.createElement('a');
    link.href = '#' + [target.id, target.date].map(encodeURIComponent).join('/');
    link.dataset.reportKey = target.file;
    link.textContent = t('ai.viewReport', { report: displayReportName(target) });
    handoffEl.appendChild(link);
    handoffEl.hidden = false;
  }

  function briefOptions(extra) {
    var options = {
      index: reportIndex,
      reports: allReports,
      t: t,
      formatDate: displayReportDate
    };
    Object.keys(extra || {}).forEach(function (key) { options[key] = extra[key]; });
    return options;
  }

  function followUpsForSources(sources, useFallback) {
    var goals = Brief.allGoals(reportIndex);
    var matched = goals.filter(function (goal) {
      return (sources || []).some(function (source) {
        return (goal.reportId === source.reportId && goal.blockId === source.blockId) ||
          Evidence.normalizeText(source.quote || source.text).indexOf(Evidence.normalizeText(goal.id + ' ' + goal.title)) !== -1;
      });
    });
    if (!matched.length && useFallback) {
      matched = goals.filter(function (goal) { return goal.statusGroup !== 'done'; });
    }
    var seen = new Set();
    return matched.reduce(function (items, goal) {
      var label = goal.id + ' ' + goal.title;
      if (items.length >= 3 || seen.has(label)) return items;
      seen.add(label);
      items.push({ label: label, question: t('ai.goalProgressQuestion', { goal: label }) });
      return items;
    }, []);
  }

  function updateStrip(brief) {
    if (!strip || !stripText) return;
    var lead = brief && brief.content
      ? Evidence.stripCitationMarkers(brief.content).split('\n').find(function (line) { return line.trim(); })
      : '';
    if (!lead) {
      strip.hidden = true;
      stripText.textContent = '';
      return;
    }
    var cta = strip.querySelector('.ai-strip-cta');
    if (cta) cta.textContent = t('ai.stripCta');
    stripText.textContent = lead.trim();
    strip.setAttribute('aria-label', t('ai.briefHeading') + ': ' + lead.trim());
    strip.hidden = false;
  }

  function timelineAnswer(question) {
    if (!reportIndex || !TIMELINE_INTENT_RE.test(question)) return null;
    var workstream = Evidence.detectWorkstream(question, reportIndex);
    if (!workstream) return null;
    var chain = Brief.deliveryChain(briefOptions({ workstream: workstream }));
    return chain.content && chain.sources.length ? chain : null;
  }

  function showBrief() {
    if (!currentReport || !reportIndex) {
      updateStrip(null);
      return;
    }
    var brief = Brief.reportBrief(briefOptions({ report: currentReport }));
    updateStrip(brief);
    if (messages.length || !brief.content) return;
    messages.push({
      role: 'assistant',
      content: brief.content,
      answerable: Boolean(brief.sources.length),
      sources: brief.sources,
      followUps: followUpsForSources(brief.sources, true),
      meta: { result: 'local_brief', reportVersion: currentReport.version }
    });
    renderMessages();
    saveConversation();
  }

  function renderShortcut(action) {
    if (!currentReport || !reportIndex || busy) return;
    var labels = {
      roadmap: t('ai.roadmap'),
      results: t('ai.results'),
      blockers: t('ai.blockers'),
      portfolio: t('ai.portfolio')
    };
    var builders = {
      roadmap: Brief.milestoneTimeline,
      results: Brief.resultsSummary,
      blockers: Brief.blockerSummary,
      portfolio: Brief.portfolioBrief
    };
    if (!builders[action]) return;
    var result = builders[action](briefOptions());
    messages.push({ role: 'user', content: labels[action] });
    messages.push({
      role: 'assistant',
      content: result.content || t('ai.noIndexedContent'),
      answerable: Boolean(result.sources.length),
      sources: result.sources,
      followUps: followUpsForSources(result.sources, false),
      meta: { result: 'local_' + action, reportVersion: currentReport.version }
    });
    messages = messages.slice(-MAX_HISTORY_MESSAGES);
    renderMessages();
    saveConversation();
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    drawer.setAttribute('aria-busy', busy ? 'true' : 'false');
    setReady(Boolean(currentReport));
    if (busy) {
      var loading = document.createElement('div');
      loading.className = 'ai-loading';
      loading.setAttribute('aria-label', t('ai.checkingEvidence'));
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

  function apiErrorMessage(code) {
    var messages = {
      ORIGIN_FORBIDDEN: 'ai.api.originForbidden',
      NOT_FOUND: 'ai.api.invalidRequest',
      METHOD_NOT_ALLOWED: 'ai.api.invalidRequest',
      INVALID_JSON: 'ai.api.invalidRequest',
      PAYLOAD_TOO_LARGE: 'ai.api.payloadTooLarge',
      QUESTION_REQUIRED: 'ai.api.questionRequired',
      INVALID_REPORT: 'ai.api.invalidReport',
      NOT_CONFIGURED: 'ai.api.notConfigured',
      INVALID_CONFIGURATION: 'ai.api.notConfigured',
      UPSTREAM_TIMEOUT: 'ai.timeout',
      INVALID_UPSTREAM_RESPONSE: 'ai.invalidAnswer',
      INVALID_MODEL_RESPONSE: 'ai.invalidAnswer',
      RATE_LIMITED: 'ai.busy',
      TOO_MANY_REQUESTS: 'ai.busy',
      SERVICE_UNAVAILABLE: 'ai.unavailable',
      GENERATION_FAILED: 'ai.unavailable',
      UPSTREAM_FAILED: 'ai.unavailable'
    };
    return t(messages[code] || 'ai.unavailable');
  }

  function scrollMessages() {
    requestAnimationFrame(function () { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  async function sendQuestion(value) {
    var question = String(value || '').trim().slice(0, MAX_QUESTION_CHARS);
    if (!question || !currentReport || busy) return;

    var reportKey = currentReport.file;
    var requestReportToken = reportLoadToken;
    var answerLanguage = responseLocale(question);
    var recentConversation = messages.slice(-MAX_HISTORY_MESSAGES).filter(function (message) {
      return isValidMessage(message) && message.role === 'user';
    }).map(function (message) {
      return message.content;
    });
    var conversation = messages.slice(-MAX_HISTORY_MESSAGES).filter(isValidMessage).map(function (message) {
      return { role: message.role, content: message.content };
    });
    messages.push({ role: 'user', content: question });
    messages = messages.slice(-MAX_HISTORY_MESSAGES);
    input.value = '';
    input.style.height = 'auto';
    showStatus('');

    renderMessages();
    saveConversation();

    var chain = timelineAnswer(question);
    if (chain) {
      messages.push({
        role: 'assistant',
        content: chain.content,
        answerable: true,
        sources: chain.sources,
        followUps: followUpsForSources(chain.sources, false),
        meta: { result: 'local_timeline', reportVersion: currentReport.version }
      });
      messages = messages.slice(-MAX_HISTORY_MESSAGES);
      renderMessages();
      saveConversation();
      input.focus();
      return;
    }

    setBusy(true);

    var responseData;
    try {
      responseData = await loadContext(answerLanguage);
    } catch (error) {
      showStatus(error && error.message ? error.message : t('ai.contextLoadFailed'));
      setBusy(false);
      return;
    }
    var responseReport = responseData.reports.find(function (report) {
      return report.id === currentReport.id && report.file === currentReport.file && report.version === currentReport.version;
    }) || currentReport;
    var sources = Evidence.selectEvidence(responseReport, question, recentConversation, {
      maxSources: 8,
      maxChars: 7000,
      reports: responseData.reports,
      index: responseData.index
    });

    if (!sources.length && !Evidence.reportMetadataIntent(question).allowed) {
      messages.push({
        role: 'assistant',
        content: t('ai.noDirectAnswer', corpusScope()),
        answerable: false,
        sources: [],
        followUps: followUpsForSources([], true),
        meta: { result: 'no_local_evidence', reportVersion: currentReport.version }
      });
      messages = messages.slice(-MAX_HISTORY_MESSAGES);
      renderMessages();
      saveConversation();
      setBusy(false);
      input.focus();
      return;
    }

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
        headers: { 'Content-Type': 'application/json', 'Accept-Language': uiLocale() },
        signal: controller.signal,
        body: JSON.stringify({
          question: question,
          report: {
            id: responseReport.id,
            key: responseReport.file,
            title: responseReport.name,
            date: responseReport.date,
            version: responseReport.version
          },
          sources: sources,
          conversation: conversation,
          uiLocale: uiLocale(),
          responseLocale: answerLanguage
        })
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (response.status === 429) {
          var retrySeconds = Number(response.headers.get('Retry-After') || 0);
          throw new Error(retrySeconds > 0
            ? t('ai.busySeconds', { seconds: Math.ceil(retrySeconds) })
            : t('ai.busy'));
        }
        throw new Error(apiErrorMessage(payload.code));
      }
      if (!currentReport || currentReport.file !== reportKey || reportLoadToken !== requestReportToken) return;
      if (typeof payload.answer !== 'string') throw new Error(t('ai.invalidAnswer'));

      messages.push({
        role: 'assistant',
        content: payload.answer,
        answerable: payload.answerable === true,
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        followUps: followUpsForSources(Array.isArray(payload.sources) ? payload.sources : [], false),
        meta: payload.meta || null
      });
      messages = messages.slice(-MAX_HISTORY_MESSAGES);
      saveConversation();
    } catch (error) {
      if (timedOut) {
        showStatus(t('ai.timeout'));
      } else if (!error || error.name !== 'AbortError') {
        showStatus(error && error.message ? error.message : t('ai.unavailable'));
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
