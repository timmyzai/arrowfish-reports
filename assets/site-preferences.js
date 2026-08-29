(function (root) {
  'use strict';

  var STORAGE_KEY = 'arrowfish_preferences_v1';
  var SUPPORTED_LANGUAGES = ['zh-CN', 'en'];
  var memoryPreference = {};
  var listeners = [];
  var script = typeof document !== 'undefined' ? document.currentScript : null;
  var scriptUrl = script && script.src ? new URL(script.src, location.href) : null;
  var localeRoot = scriptUrl ? new URL('../', scriptUrl) : null;
  var dictionaries = root.ARROWFISH_UI_MESSAGES || { 'zh-CN': {}, en: {} };
  var media = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;
  var state = resolveState(readPreference());

  function normalizeLanguage(value) {
    value = String(value || '').toLowerCase();
    if (value === 'en' || value.indexOf('en-') === 0) return 'en';
    if (value === 'zh-cn' || value === 'zh-sg' || value === 'zh-hans' || value === 'zh' || value.indexOf('zh-hans-') === 0) return 'zh-CN';
    return '';
  }

  function documentLanguage() {
    if (!root.document) return '';
    var element = root.document.documentElement;
    return normalizeLanguage(element.dataset.locale || element.lang);
  }

  function detectedLanguage() {
    var values = root.navigator && Array.isArray(root.navigator.languages) && root.navigator.languages.length
      ? root.navigator.languages
      : [root.navigator && root.navigator.language];
    for (var index = 0; index < values.length; index += 1) {
      var normalized = normalizeLanguage(values[index]);
      if (normalized) return normalized;
    }
    return 'zh-CN';
  }

  function readPreference() {
    try {
      var value = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || '{}');
      if (!value || typeof value !== 'object') return {};
      var preference = {};
      if (SUPPORTED_LANGUAGES.indexOf(value.language) !== -1) preference.language = value.language;
      if (value.theme === 'light' || value.theme === 'dark') preference.theme = value.theme;
      return preference;
    } catch (error) {
      return memoryPreference;
    }
  }

  function writePreference(value) {
    memoryPreference = value;
    try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch (error) {}
  }

  function resolveState(preference) {
    var language = documentLanguage() || (
      SUPPORTED_LANGUAGES.indexOf(preference.language) !== -1 ? preference.language : detectedLanguage()
    );
    var theme = preference.theme === 'light' || preference.theme === 'dark'
      ? preference.theme
      : (media && media.matches ? 'dark' : 'light');
    return { language: language, theme: theme };
  }

  function interpolate(value, params) {
    return String(value || '').replace(/\{([a-zA-Z0-9_]+)\}/g, function (_, key) {
      return params && params[key] !== undefined ? String(params[key]) : '{' + key + '}';
    });
  }

  function t(key, params) {
    var active = dictionaries[state.language] || dictionaries['zh-CN'] || {};
    var fallback = dictionaries['zh-CN'] || {};
    return interpolate(active[key] || fallback[key] || key, params);
  }

  function tn(key, count, params) {
    var category = 'other';
    try { category = new Intl.PluralRules(state.language).select(Number(count)); } catch (error) {}
    var active = dictionaries[state.language] || {};
    var suffix = active[key + '.' + category] ? '.' + category : '.other';
    return t(key + suffix, Object.assign({ count: count }, params || {}));
  }

  function applyRoot() {
    if (!root.document) return;
    var element = root.document.documentElement;
    element.lang = state.language;
    element.dataset.locale = state.language;
    element.dataset.language = state.language;
    element.dataset.theme = state.theme;
    element.style.colorScheme = state.theme;
  }

  function notify(previous) {
    applyRoot();
    renderControls();
    var detail = { language: state.language, theme: state.theme };
    listeners.slice().forEach(function (listener) { listener(detail); });
    if (root.dispatchEvent && typeof CustomEvent === 'function') {
      root.dispatchEvent(new CustomEvent('arrowfish:preferenceschange', { detail: detail }));
    }
    if (root.parent && root.parent !== root) {
      try { root.parent.postMessage({ type: 'arrowfish:preferences', state: state }, location.origin); } catch (error) {}
    }
  }

  function localeUrl(language) {
    if (!localeRoot || !root.location) return null;
    var deploymentRoot = new URL('../', localeRoot);
    var relative = root.location.pathname.slice(localeRoot.pathname.length).replace(/^\/+/, '');
    var target = new URL(language + '/' + relative, deploymentRoot);
    target.search = root.location.search;
    target.hash = root.location.hash;
    return target;
  }

  function setLanguage(language) {
    language = normalizeLanguage(language);
    if (!language || language === state.language) return;
    var preference = readPreference();
    preference.language = language;
    writePreference(preference);
    var target = localeUrl(language);
    if (target && root.location.assign) {
      root.location.assign(target.href);
      return;
    }
    var previous = state;
    state = { language: language, theme: state.theme };
    notify(previous);
  }

  function setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark' || theme === state.theme) return;
    var previous = state;
    var preference = readPreference();
    preference.theme = theme;
    writePreference(preference);
    state = { language: state.language, theme: theme };
    notify(previous);
  }

  function iconMarkup(kind) {
    if (kind === 'language') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
    }
    if (state.theme === 'light') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.7 6.7 0 0 0 21 12.8Z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>';
  }

  function renderControls() {
    if (!root.document) return;
    root.document.querySelectorAll('[data-preference-controls]').forEach(function (controls) {
      controls.setAttribute('aria-label', t('preferences.group'));
      var language = controls.querySelector('[data-language-toggle]');
      var theme = controls.querySelector('[data-theme-toggle]');
      if (language) {
        var languageLabel = t(state.language === 'zh-CN' ? 'preferences.switchToEnglish' : 'preferences.switchToChinese');
        language.setAttribute('aria-label', languageLabel);
        language.title = languageLabel;
        language.innerHTML = iconMarkup('language');
      }
      if (theme) {
        var themeLabel = t(state.theme === 'light' ? 'preferences.enableDark' : 'preferences.enableLight');
        theme.setAttribute('aria-label', themeLabel);
        theme.title = themeLabel;
        theme.innerHTML = iconMarkup('theme');
      }
    });
  }

  function createControls() {
    var controls = root.document.createElement('div');
    controls.className = 'preference-controls';
    controls.dataset.preferenceControls = '';
    controls.setAttribute('role', 'group');
    controls.innerHTML = '<button class="preference-button" type="button" data-language-toggle></button><button class="preference-button" type="button" data-theme-toggle></button>';
    controls.querySelector('[data-language-toggle]').addEventListener('click', function () {
      setLanguage(state.language === 'zh-CN' ? 'en' : 'zh-CN');
    });
    controls.querySelector('[data-theme-toggle]').addEventListener('click', function () {
      setTheme(state.theme === 'light' ? 'dark' : 'light');
    });
    return controls;
  }

  function installControls() {
    if (!root.document || root.document.querySelector('[data-preference-controls]')) return;
    var embedded = false;
    try { embedded = root.self !== root.top; } catch (error) { embedded = true; }
    if (embedded) return;
    var target = root.document.querySelector('[data-site-header], [data-report-header], header, .report-header, .page-nav');
    if (!target) return;
    target.appendChild(createControls());
    renderControls();
  }

  function initializeDocument() {
    installControls();
    renderControls();
  }

  function applyExternal(next) {
    if (!next || ['light', 'dark'].indexOf(next.theme) === -1 || next.theme === state.theme) return;
    var previous = state;
    state = { language: state.language, theme: next.theme };
    notify(previous);
  }

  applyRoot();
  root.ArrowfishPreferences = {
    get: function () { return { language: state.language, theme: state.theme }; },
    setLanguage: setLanguage,
    toggleLanguage: function () { setLanguage(state.language === 'zh-CN' ? 'en' : 'zh-CN'); },
    setTheme: setTheme,
    toggleTheme: function () { setTheme(state.theme === 'light' ? 'dark' : 'light'); },
    subscribe: function (listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.push(listener);
      return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
    },
    detectQuestionLanguage: function (value) {
      value = String(value || '');
      if (/[\u3400-\u9fff]/.test(value)) return 'zh-CN';
      if (/[a-z]/i.test(value)) return 'en';
      return state.language;
    }
  };
  root.ArrowfishI18n = {
    t: t,
    tn: tn,
    getLanguage: function () { return state.language; },
    translateDocument: function () { return Promise.resolve(); },
    ready: Promise.resolve()
  };

  if (media) {
    var mediaListener = function () {
      var preference = readPreference();
      if (preference.theme) return;
      var previous = state;
      state = { language: state.language, theme: media.matches ? 'dark' : 'light' };
      notify(previous);
    };
    if (media.addEventListener) media.addEventListener('change', mediaListener);
    else if (media.addListener) media.addListener(mediaListener);
  }

  root.addEventListener('storage', function (event) {
    if (event.key !== STORAGE_KEY) return;
    var preference = readPreference();
    if (preference.language && preference.language !== state.language) {
      var target = localeUrl(preference.language);
      if (target && root.location.assign) {
        root.location.assign(target.href);
        return;
      }
    }
    var nextTheme = preference.theme || (media && media.matches ? 'dark' : 'light');
    if (nextTheme === state.theme) return;
    var previous = state;
    state = { language: state.language, theme: nextTheme };
    notify(previous);
  });
  root.addEventListener('message', function (event) {
    if (event.origin !== location.origin || !event.data || event.data.type !== 'arrowfish:preferences') return;
    applyExternal(event.data.state);
  });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', initializeDocument);
    else initializeDocument();
  }
})(typeof window !== 'undefined' ? window : globalThis);
