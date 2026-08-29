#!/usr/bin/env node

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const catalogueSource = await readFile(new URL('../assets/ui-i18n.js', import.meta.url), 'utf8');
const preferencesSource = await readFile(new URL('../assets/site-preferences.js', import.meta.url), 'utf8');
const themeSource = await readFile(new URL('../assets/site-theme.css', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const reports = JSON.parse(await readFile(new URL('../reports.json', import.meta.url), 'utf8'));

function runtime({ languages = ['zh-CN'], dark = false, stored = null, storageThrows = false, locale = '' } = {}) {
  const values = new Map(stored ? [['arrowfish_preferences_v1', JSON.stringify(stored)]] : []);
  const events = {};
  const dispatched = [];
  const mediaListeners = [];
  const assigned = [];
  const media = {
    matches: dark,
    addEventListener(type, listener) { if (type === 'change') mediaListeners.push(listener); }
  };
  const documentElement = {
    lang: locale,
    dataset: locale ? { locale } : {},
    style: {},
    classList: { add() {}, remove() {} }
  };
  const document = {
    currentScript: locale ? { src: `https://example.test/${locale}/assets/site-preferences.js` } : null,
    documentElement,
    readyState: 'loading',
    addEventListener(type, listener) { events[`document:${type}`] = listener; },
    querySelectorAll() { return []; },
    createTreeWalker() { return { nextNode() { return null; } }; }
  };
  const window = {
    document,
    navigator: { languages, language: languages[0] },
    location: {
      href: locale ? `https://example.test/${locale}/index.html?view=current#sprint-10-full/2026-08-26` : 'https://example.test/index.html',
      origin: 'https://example.test',
      pathname: locale ? `/${locale}/index.html` : '/index.html',
      search: locale ? '?view=current' : '',
      hash: locale ? '#sprint-10-full/2026-08-26' : '',
      assign(value) { assigned.push(value); }
    },
    localStorage: {
      getItem(key) { if (storageThrows) throw new Error('disabled'); return values.get(key) || null; },
      setItem(key, value) { if (storageThrows) throw new Error('disabled'); values.set(key, value); }
    },
    matchMedia() { return media; },
    addEventListener(type, listener) { events[type] = listener; },
    dispatchEvent(event) { dispatched.push(event); },
    parent: null,
    self: null,
    top: null
  };
  window.parent = window;
  window.self = window;
  window.top = window;
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    navigator: window.navigator,
    location: window.location,
    CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    URL,
    console,
    Promise,
    Map,
    WeakMap,
    Array,
    Object,
    String,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
  });
  vm.runInContext(catalogueSource, context);
  vm.runInContext(preferencesSource, context);
  return { window, values, media, mediaListeners, events, dispatched, assigned };
}

let app = runtime({ languages: ['en-MY', 'zh-CN'], dark: true });
assert.equal(JSON.stringify(app.window.ArrowfishPreferences.get()), JSON.stringify({ language: 'en', theme: 'dark' }), 'browser language and system theme initialize preferences');
assert.equal(app.window.ArrowfishI18n.tn('ai.sources', 1), '1 verified source', 'English singular messages are selected');
assert.equal(app.window.ArrowfishI18n.tn('ai.sources', 2), '2 verified sources', 'English plural messages are selected');

app = runtime({ languages: ['fr-FR'], dark: false });
assert.equal(app.window.ArrowfishPreferences.get().language, 'zh-CN', 'unsupported browsers fall back to Simplified Chinese');
app.media.matches = true;
app.mediaListeners[0]();
assert.equal(app.window.ArrowfishPreferences.get().theme, 'dark', 'system theme changes remain live before an explicit choice');

app = runtime({ languages: ['en-US'], dark: true, stored: { language: 'zh-CN', theme: 'light' } });
assert.equal(JSON.stringify(app.window.ArrowfishPreferences.get()), JSON.stringify({ language: 'zh-CN', theme: 'light' }), 'saved explicit choices take priority');

app.window.ArrowfishPreferences.toggleLanguage();
app.window.ArrowfishPreferences.toggleTheme();
assert.deepEqual(JSON.parse(app.values.get('arrowfish_preferences_v1')), { language: 'en', theme: 'dark' }, 'explicit choices use the versioned cache key');
assert.deepEqual(Object.keys(app.dispatched[0].detail).sort(), ['language', 'theme'], 'preference events expose the stable two-field contract');
app.media.matches = false;
app.mediaListeners[0]();
assert.equal(app.window.ArrowfishPreferences.get().theme, 'dark', 'an explicit theme choice is not overwritten by later system changes');

app.events.message({ origin: 'https://attacker.test', data: { type: 'arrowfish:preferences', state: { language: 'zh-CN', theme: 'light' } } });
assert.equal(app.window.ArrowfishPreferences.get().theme, 'dark', 'cross-origin preference messages are ignored');
app.events.message({ origin: 'https://example.test', data: { type: 'arrowfish:preferences', state: { language: 'zh-CN', theme: 'light' } } });
assert.equal(app.window.ArrowfishPreferences.get().theme, 'light', 'same-origin preference messages synchronize state');
const synchronizedEventCount = app.dispatched.length;
app.events.message({ origin: 'https://example.test', data: { type: 'arrowfish:preferences', state: { language: 'zh-CN', theme: 'light' } } });
assert.equal(app.dispatched.length, synchronizedEventCount, 'unchanged iframe messages do not create an echo loop');

app = runtime({ languages: ['en-US'], storageThrows: true });
app.window.ArrowfishPreferences.setLanguage('zh-CN');
assert.equal(app.window.ArrowfishPreferences.get().language, 'zh-CN', 'disabled localStorage degrades to in-page memory');
assert.equal(app.window.ArrowfishPreferences.detectQuestionLanguage('What changed?'), 'en');
assert.equal(app.window.ArrowfishPreferences.detectQuestionLanguage('有什么变化？'), 'zh-CN');
assert.equal(app.window.ArrowfishPreferences.detectQuestionLanguage('123'), 'zh-CN', 'symbol-only questions follow the UI language');
assert.equal(app.window.ArrowfishI18n.t('copy.done'), '已复制');
assert.equal(
  app.window.ArrowfishI18n.t('ai.viewReport', { report: '第10阶段' }),
  '查看第10阶段 →',
  'named parameters are interpolated'
);
assert.equal(app.window.ArrowfishI18n.tn('ai.sources', 2), '2 条已验证依据', 'plural counts are interpolated');

app = runtime({ languages: ['zh-CN'], stored: { language: 'zh-CN' }, locale: 'en' });
assert.equal(app.window.ArrowfishPreferences.get().language, 'en', 'an explicit locale route wins over browser and stored preferences');
app.window.ArrowfishPreferences.toggleLanguage();
assert.equal(
  app.assigned[0],
  'https://example.test/zh-CN/index.html?view=current#sprint-10-full/2026-08-26',
  'language switching navigates to the equivalent locale URL and preserves search and hash state'
);
assert.equal(JSON.parse(app.values.get('arrowfish_preferences_v1')).language, 'zh-CN', 'route navigation records the explicit language choice');

assert.match(preferencesSource, /data-language-toggle><\/button><button[^>]+data-theme-toggle/, 'the header adds exactly the language and theme actions together');
assert.match(themeSource, /\.preference-button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/, 'preference actions use a 44 by 44 pixel target');
assert.match(indexSource, /id="goals-tab"[^>]+aria-selected="true"/, 'the Goal tab is selected before report data loads');
assert.match(indexSource, /id="report-frame"[^>]+aria-labelledby="goals-tab"/, 'the initial report frame belongs to the Goal tab');
assert.match(indexSource, /if \(!hash\) \{\s*loadDefault\(\);/, 'an empty URL opens the Goal page by default');
assert.match(indexSource, /function loadDefault\([\s\S]*?loadEntry\(goal, 'goals', updateLocation\)/, 'default navigation prefers the registered Goal entry');
assert.match(indexSource, /select\.value = defaultSprintIndex\(\);/, 'the report selector is initialized independently from the Goal view');
const selectableReports = reports.filter(report => !report.id.startsWith('goal-') && !report.file.includes('/Goal-'));
const defaultReport = [...selectableReports].reverse().find(report => report.defaultForSprintPage !== false);
assert.equal(defaultReport?.id, 'sprint-10-full', 'the Sprint page defaults to the 2026-08-26 Sprint 10 progress report');
assert.equal(defaultReport?.date, '2026-08-26', 'the default Sprint report has the requested publication date');

console.log('Preference and UI i18n tests: all assertions passed');
