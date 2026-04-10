/**
 * Auth Gate — drop-in password protection for static HTML pages.
 *
 * Usage: add to <head> of any HTML page:
 *   <script src="../../assets/auth-gate.js"></script>   (adjust path)
 *
 * Behavior:
 *   - Hides page content immediately on load
 *   - Checks localStorage cache (shared key "project_auth", 30-min TTL)
 *   - If cached: shows content instantly (no flash)
 *   - If not cached: shows password overlay
 *   - On correct password: caches auth, shows content
 *   - All pages sharing same origin + cache key unlock together
 *
 * To change password, update PASS_HASH below. Generate with browser console:
 *   crypto.subtle.digest('SHA-256', new TextEncoder().encode('YOUR_PASSWORD'))
 *     .then(b => console.log(Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2,'0')).join('')))
 */
(function () {
  var PASS_HASH = '32175efd700d4c53192a163db93422d939d5523c9d6e90c7dfd52558075ec2b4';
  var CACHE_KEY = 'project_auth';
  var CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  // --- Cache helpers ---
  function isCacheValid() {
    try {
      var ts = parseInt(localStorage.getItem(CACHE_KEY), 10);
      return ts && (Date.now() - ts) < CACHE_TTL;
    } catch (e) { return false; }
  }
  function setCache() {
    try { localStorage.setItem(CACHE_KEY, Date.now().toString()); } catch (e) {}
  }

  // --- If cached, do nothing — page renders normally ---
  if (isCacheValid()) return;

  // --- Not cached: hide body, show gate ---

  // Inject CSS
  var style = document.createElement('style');
  style.textContent = [
    'body.auth-locked > *:not(#auth-gate) { display: none !important; }',
    '#auth-gate {',
    '  position: fixed; inset: 0; z-index: 10000;',
    '  display: flex; align-items: center; justify-content: center;',
    '  background: #0F172A;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '  transition: opacity 0.5s ease, visibility 0.5s ease;',
    '}',
    '#auth-gate.hidden { opacity: 0; visibility: hidden; pointer-events: none; }',
    '.ag-card {',
    '  width: 100%; max-width: 400px; padding: 40px 32px;',
    '  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 20px;',
    '  backdrop-filter: blur(40px); -webkit-backdrop-filter: blur(40px);',
    '  box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);',
    '  animation: agCardIn 0.5s ease both;',
    '}',
    '@keyframes agCardIn { from { opacity: 0; transform: translateY(16px); } }',
    '.ag-title { font-size: 20px; font-weight: 700; color: #fff; text-align: center; margin: 0 0 6px; }',
    '.ag-subtitle { font-size: 13px; color: #64748B; text-align: center; margin: 0 0 28px; }',
    '.ag-input {',
    '  width: 100%; height: 48px; padding: 0 16px;',
    '  background: rgba(15,23,42,0.6); border: 1.5px solid rgba(255,255,255,0.1); border-radius: 10px;',
    '  color: #E2E8F0; font-size: 15px; outline: none; margin-bottom: 8px; box-sizing: border-box;',
    '}',
    '.ag-input:focus { border-color: #1E3A5F; box-shadow: 0 0 0 3px rgba(30,58,95,0.5); }',
    '.ag-input.error { border-color: #EF4444; animation: agShake 0.4s ease; }',
    '@keyframes agShake { 10%,90%{transform:translateX(-2px)} 20%,80%{transform:translateX(3px)} 30%,50%,70%{transform:translateX(-4px)} 40%,60%{transform:translateX(4px)} }',
    '.ag-error { font-size: 13px; color: #EF4444; min-height: 20px; margin-bottom: 12px; }',
    '.ag-submit {',
    '  width: 100%; height: 48px; background: linear-gradient(135deg, #22C55E, #16A34A);',
    '  border: none; border-radius: 10px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;',
    '  transition: transform 0.15s, box-shadow 0.2s;',
    '}',
    '.ag-submit:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(34,197,94,0.25); }',
    '.ag-footer { text-align: center; margin-top: 24px; font-size: 12px; color: #64748B; }',
    '@media (max-width: 480px) { .ag-card { margin: 16px; padding: 32px 20px; } }'
  ].join('\n');
  document.head.appendChild(style);

  // Lock body as soon as possible
  function lockBody() {
    document.body.classList.add('auth-locked');
  }
  if (document.body) { lockBody(); }
  else { document.addEventListener('DOMContentLoaded', lockBody); }

  // Build gate HTML
  function createGate() {
    var gate = document.createElement('div');
    gate.id = 'auth-gate';
    gate.innerHTML = [
      '<div class="ag-card">',
      '  <h2 class="ag-title">Arrowfish VPN</h2>',
      '  <p class="ag-subtitle">\u8BF7\u8F93\u5165\u8BBF\u95EE\u5BC6\u7801\u67E5\u770B\u62A5\u544A</p>',
      '  <form id="ag-form" autocomplete="off">',
      '    <input type="password" id="ag-password" class="ag-input" placeholder="Access code" autocomplete="off" />',
      '    <div class="ag-error" id="ag-error"></div>',
      '    <button type="submit" class="ag-submit">\u89E3\u9501</button>',
      '  </form>',
      '  <div class="ag-footer">Protected access</div>',
      '</div>'
    ].join('');
    document.body.insertBefore(gate, document.body.firstChild);

    var form = document.getElementById('ag-form');
    var input = document.getElementById('ag-password');
    var errorEl = document.getElementById('ag-error');

    input.focus();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var val = input.value.trim();
      if (!val) { input.focus(); return; }
      errorEl.textContent = '';
      input.classList.remove('error');

      crypto.subtle.digest('SHA-256', new TextEncoder().encode(val))
        .then(function (buf) {
          var hash = Array.from(new Uint8Array(buf))
            .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          if (hash === PASS_HASH) {
            setCache();
            gate.classList.add('hidden');
            document.body.classList.remove('auth-locked');
          } else {
            input.classList.add('error');
            errorEl.textContent = '\u5BC6\u7801\u9519\u8BEF';
            input.select();
            setTimeout(function () { input.classList.remove('error'); }, 600);
          }
        });
    });
  }

  if (document.body) { createGate(); }
  else { document.addEventListener('DOMContentLoaded', createGate); }
})();
