(function (root) {
  'use strict';

  var PASS_HASH = '32175efd700d4c53192a163db93422d939d5523c9d6e90c7dfd52558075ec2b4';
  var CACHE_KEY = 'project_auth';
  var CACHE_TTL = 30 * 60 * 1000;
  var script = document.currentScript;
  var contentSelector = script && script.dataset.content || '';
  var requiresGate = !isCacheValid();
  if (requiresGate) document.documentElement.classList.add('auth-pending');

  function t(key) {
    return root.ArrowfishI18n ? root.ArrowfishI18n.t(key) : key;
  }

  function isCacheValid() {
    try {
      var timestamp = parseInt(localStorage.getItem(CACHE_KEY), 10);
      return Boolean(timestamp && Date.now() - timestamp < CACHE_TTL);
    } catch (error) {
      return false;
    }
  }

  function setCache() {
    try { localStorage.setItem(CACHE_KEY, Date.now().toString()); } catch (error) {}
  }

  function dispatchUnlocked(cached) {
    document.documentElement.classList.remove('auth-pending');
    document.body.classList.remove('auth-locked');
    var content = contentSelector && document.querySelector(contentSelector);
    if (content) content.style.display = 'flex';
    root.dispatchEvent(new CustomEvent('arrowfish:auth-unlocked', { detail: { cached: Boolean(cached) } }));
  }

  function gateMarkup() {
    return [
      '<div class="gate-grid" aria-hidden="true"></div>',
      '<div class="gate-orb gate-orb-1" aria-hidden="true"></div>',
      '<div class="gate-orb gate-orb-2" aria-hidden="true"></div>',
      '<div class="gate-card" id="gate-card">',
      '  <div class="gate-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>',
      '  <h2 class="gate-title">Arrowfish VPN</h2>',
      '  <p class="gate-subtitle" data-auth-text="subtitle"></p>',
      '  <form id="gate-form" autocomplete="off">',
      '    <div class="gate-input-group">',
      '      <input type="password" id="gate-password" class="gate-input" autocomplete="off" spellcheck="false">',
      '      <button type="button" class="gate-toggle" id="gate-toggle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>',
      '    </div>',
      '    <div class="gate-error" id="gate-error" role="alert"></div>',
      '    <button type="submit" class="gate-submit" id="gate-submit"><span class="btn-text" data-auth-text="unlock"></span><span class="spinner" aria-hidden="true"></span></button>',
      '  </form>',
      '  <div class="gate-footer" data-auth-text="protected"></div>',
      '</div>'
    ].join('');
  }

  function localize(gate) {
    gate.querySelector('[data-auth-text="subtitle"]').textContent = t('auth.subtitle');
    gate.querySelector('[data-auth-text="unlock"]').textContent = t('auth.unlock');
    gate.querySelector('[data-auth-text="protected"]').textContent = t('auth.protected');
    var input = gate.querySelector('#gate-password');
    input.placeholder = t('auth.password');
    input.setAttribute('aria-label', t('auth.password'));
    var toggle = gate.querySelector('#gate-toggle');
    var toggleLabel = t(input.type === 'text' ? 'auth.hidePassword' : 'auth.showPassword');
    toggle.setAttribute('aria-label', toggleLabel);
    toggle.title = toggleLabel;
  }

  function createGate() {
    if (!requiresGate) {
      dispatchUnlocked(true);
      return;
    }

    document.body.classList.add('auth-locked');
    var gate = document.createElement('div');
    gate.id = 'auth-gate';
    gate.innerHTML = gateMarkup();
    document.body.insertBefore(gate, document.body.firstChild);
    localize(gate);

    var form = gate.querySelector('#gate-form');
    var input = gate.querySelector('#gate-password');
    var toggle = gate.querySelector('#gate-toggle');
    var errorElement = gate.querySelector('#gate-error');
    var submit = gate.querySelector('#gate-submit');
    var card = gate.querySelector('#gate-card');
    var visible = false;

    input.focus();
    toggle.addEventListener('click', function () {
      visible = !visible;
      input.type = visible ? 'text' : 'password';
      localize(gate);
      input.focus();
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      submit.disabled = true;
      submit.classList.add('loading');
      errorElement.textContent = '';
      input.classList.remove('error');
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(function (buffer) {
        return Array.from(new Uint8Array(buffer)).map(function (byte) {
          return byte.toString(16).padStart(2, '0');
        }).join('');
      }).then(function (hash) {
        if (hash !== PASS_HASH) {
          input.classList.add('error');
          errorElement.textContent = t('auth.invalid');
          input.select();
          setTimeout(function () { input.classList.remove('error'); }, 600);
          return;
        }
        setCache();
        card.classList.add('success');
        gate.classList.add('hidden');
        setTimeout(function () {
          gate.remove();
          dispatchUnlocked(false);
        }, 220);
      }).finally(function () {
        submit.disabled = false;
        submit.classList.remove('loading');
      });
    });

    root.addEventListener('arrowfish:preferenceschange', function () { localize(gate); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createGate);
  else createGate();
})(window);
