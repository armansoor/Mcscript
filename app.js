/* Minecraft Release Companion
   app.js — main logic for fetching manifest, UI, alerts, settings, and webhook integration.
*/

(() => {
  const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
  // Elements
  const $ = sel => document.querySelector(sel);
  const els = {
    checkNow: $('#checkNow'),
    notifyBtn: $('#notifyBtn'),
    themeBtn: $('#themeBtn'),
    settingsBtn: $('#settingsBtn'),
    overlay: $('#overlay'),
    settings: $('#settings'),
    closeSettings: $('#closeSettings'),
    saveSettings: $('#saveSettings'),
    resetSettings: $('#resetSettings'),
    // quick settings
    interval: $('#interval'),
    autoCheck: $('#autoCheck'),
    compactMode: $('#compactMode'),
    // settings inside modal
    settingsInterval: $('#settingsInterval'),
    settingsAutoCheck: $('#settingsAutoCheck'),
    predictedDate: $('#predictedDate'),
    soundOn: $('#soundOn'),
    notifOn: $('#notifOn'),
    webhookUrl: $('#webhookUrl'),
    themeList: $('#themeList'),
    // overview
    latestRelease: $('#latestRelease'),
    latestReleaseDate: $('#latestReleaseDate'),
    latestSnapshot: $('#latestSnapshot'),
    latestSnapshotDate: $('#latestSnapshotDate'),
    lastChecked: $('#lastChecked'),
    countdownDisplay: $('#countdownDisplay'),
    alertVisual: $('#alertVisual'),
    playTestSound: $('#playTestSound'),
    // explorer
    search: $('#search'),
    typeFilter: $('#typeFilter'),
    clearSearch: $('#clearSearch'),
    versionsBody: $('#versionsBody'),
    versionsTable: $('#versionsTable'),
    openSettings: $('#openSettings'),
    // version modal
    versionModal: $('#versionModal'),
    versionTitle: $('#versionTitle'),
    versionBody: $('#versionBody'),
    openArticle: $('#openArticle'),
    closeVersion: $('#closeVersion'),
    closeVersion2: $('#closeVersion2'),
  };

  // defaults
  const DEFAULTS = {
    interval: 10,
    autoCheck: true,
    compactMode: false,
    theme: 'dark',
    predictedDate: null,
    soundOn: true,
    notifOn: true,
    webhookUrl: '',
    lastKnown: {release: null, snapshot: null},
  };

  let state = loadState();
  let timer = null;
  let countdownTimer = null;
  let lastVersionsCache = null;

  // apply initial UI state
  document.documentElement.setAttribute('data-theme', state.theme || 'dark');
  els.interval.value = state.interval;
  els.autoCheck.checked = state.autoCheck;
  els.compactMode.checked = state.compactMode;
  els.settingsInterval.value = state.interval;
  els.settingsAutoCheck.checked = state.autoCheck;
  els.predictedDate.value = state.predictedDate || '';
  els.soundOn.checked = state.soundOn;
  els.notifOn.checked = state.notifOn;
  els.webhookUrl.value = state.webhookUrl || '';

  // start
  attachEvents();
  update().catch(console.error);
  startAuto();
  refreshCountdown();

  /* -------------------- Core: fetch & render -------------------- */
  async function fetchManifest() {
    const res = await fetch(MANIFEST_URL, {cache: 'no-store'});
    if (!res.ok) throw new Error('Network error ' + res.status);
    return res.json();
  }

  async function update() {
    try {
      const data = await fetchManifest();
      lastVersionsCache = (data.versions || []).map(v => ({ id: v.id, type: v.type, time: v.time, releaseTime: v.releaseTime }));
      const latest = data.latest || {};
      const byId = Object.fromEntries(lastVersionsCache.map(v => [v.id, v]));
      renderTop(latest, byId);
      renderTable(lastVersionsCache);
      checkForChanges(latest);
      // cache last manifest for offline access
      localStorage.setItem('mc_manifest_cache', JSON.stringify(data));
    } catch (e) {
      console.error('Update failed', e);
      showToast('Update failed (network). Loaded cached data if available.');
      // attempt to load cached manifest
      const cached = localStorage.getItem('mc_manifest_cache');
      if (cached) {
        try {
          const data = JSON.parse(cached);
          lastVersionsCache = (data.versions || []).map(v => ({ id: v.id, type: v.type, time: v.time, releaseTime: v.releaseTime }));
          const latest = data.latest || {};
          const byId = Object.fromEntries(lastVersionsCache.map(v => [v.id, v]));
          renderTop(latest, byId);
          renderTable(lastVersionsCache);
        } catch (err) { console.error(err); }
      }
    } finally {
      els.lastChecked.textContent = `Last checked: ${new Date().toLocaleString()}`;
    }
  }

  function renderTop(latest, byId) {
    const rel = byId[latest.release];
    const snap = byId[latest.snapshot];
    els.latestRelease.textContent = latest.release || '—';
    els.latestReleaseDate.textContent = rel ? `Published: ${format(rel.releaseTime||rel.time)}` : '';
    els.latestSnapshot.textContent = latest.snapshot || '—';
    els.latestSnapshotDate.textContent = snap ? `Published: ${format(snap.releaseTime||snap.time)}` : '';
  }

  function renderTable(list) {
    const q = (els.search.value || '').trim().toLowerCase();
    const type = els.typeFilter.value || 'all';
    const rows = list
      .filter(v => (type === 'all' || v.type === type))
      .filter(v => !q || v.id.toLowerCase().includes(q) || v.type.includes(q))
      .slice(0, 500)
      .map(v => {
        const published = format(v.releaseTime || v.time);
        const notes = v.type === 'release' && /rc|pre/.test(v.id) ? 'Release candidate / pre-release' : '';
        return `<tr data-id="${escapeHTML(v.id)}" data-type="${v.type}">
          <td><code>${escapeHTML(v.id)}</code></td>
          <td>${v.type}</td>
          <td>${published}</td>
          <td>${notes}</td>
        </tr>`;
      }).join('');
    els.versionsBody.innerHTML = rows || `<tr><td colspan="4" class="muted">No results</td></tr>`;
    applyCompactMode();
  }

  /* -------------------- Change detection, notifications, webhook ------------------- */

  function checkForChanges(latest) {
    const lk = state.lastKnown || {};
    const changed = [];
    if (latest.release && latest.release !== lk.release) {
      changed.push({ kind: 'release', id: latest.release });
      state.lastKnown.release = latest.release;
    }
    if (latest.snapshot && latest.snapshot !== lk.snapshot) {
      changed.push({ kind: 'snapshot', id: latest.snapshot });
      state.lastKnown.snapshot = latest.snapshot;
    }
    if (changed.length) {
      saveState();
      changed.forEach(c => {
        const title = c.kind === 'release' ? 'New Release' : 'New Snapshot';
        const msg = `${title}: ${c.id}`;
        fireAlert(msg, c);
      });
    }
  }

  function fireAlert(message, change) {
    // visual
    triggerVisual();
    // toast
    showToast(message);
    // play sound
    if (state.soundOn) playNoteSequence();
    // desktop notification
    if (state.notifOn && Notification.permission === 'granted') {
      const n = new Notification(message, { body: 'Click to open Minecraft news', tag: change.id });
      n.onclick = () => window.open('https://www.minecraft.net/en-us/article', '_blank');
    }
    // webhook
    if (state.webhookUrl && state.webhookUrl.trim()) {
      try {
        fetch(state.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'mc_new_version',
            kind: change.kind,
            id: change.id,
            timestamp: new Date().toISOString()
          })
        }).then(r => {
          if (!r.ok) console.warn('Webhook responded', r.status);
        }).catch(err => console.warn('Webhook error', err));
      } catch (e) { console.warn('Webhook failed', e); }
    }
  }

  /* -------------------- UI helpers: modals, toasts, visual -------------------- */
  function attachEvents() {
    // basic controls
    els.checkNow.addEventListener('click', () => update());
    els.notifyBtn.addEventListener('click', async () => {
      try {
        const res = await Notification.requestPermission();
        showToast('Notification permission: ' + res);
      } catch (e) { console.error(e); }
    });

    // search / filter
    els.search.addEventListener('input', () => renderTable(lastVersionsCache || []));
    els.typeFilter.addEventListener('change', () => renderTable(lastVersionsCache || []));
    els.clearSearch.addEventListener('click', () => { els.search.value = ''; renderTable(lastVersionsCache || []); });

    // settings modal
    els.settingsBtn.addEventListener('click', openSettings);
    els.openSettings.addEventListener('click', openSettings);
    els.overlay.addEventListener('click', closeSettings);
    els.closeSettings.addEventListener('click', closeSettings);

    // save/reset
    $('#saveSettings')?.addEventListener('click', saveSettingsFromModal);
    $('#resetSettings')?.addEventListener('click', resetSettings);

    // theme toggle within modal (delegate)
    els.themeList?.addEventListener('click', (e) => {
      const btn = e.target.closest('.theme-swatch');
      if (!btn) return;
      const theme = btn.dataset.theme;
      applyTheme(theme);
      state.theme = theme;
      saveState();
    });

    // quick settings
    els.interval.addEventListener('change', () => { state.interval = clamp(+els.interval.value || 10, 1, 60); saveState(); startAuto(); });
    els.autoCheck.addEventListener('change', () => { state.autoCheck = !!els.autoCheck.checked; saveState(); startAuto(); });
    els.compactMode.addEventListener('change', () => { state.compactMode = !!els.compactMode.checked; saveState(); applyCompactMode(); });

    // open version detail
    els.versionsBody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const id = tr.dataset.id;
      const type = tr.dataset.type;
      openVersionModal(id, type);
    });

    // version modal controls
    els.closeVersion?.addEventListener('click', closeVersionModal);
    els.closeVersion2?.addEventListener('click', closeVersionModal);
    els.openArticle?.addEventListener('click', () => {
      // open minecraft news search for the version
      const title = els.versionTitle.textContent || '';
      const q = encodeURIComponent(title);
      window.open(`https://www.minecraft.net/en-us/search?search=${q}`, '_blank');
    });

    // prebuilt test sound
    els.playTestSound?.addEventListener('click', () => playNoteSequence());

    // theme button quick open (cycles)
    els.themeBtn.addEventListener('click', () => {
      const themes = ['dark','creeper','ender','grass','stone','sand','light'];
      let i = themes.indexOf(state.theme);
      i = (i + 1) % themes.length;
      applyTheme(themes[i]);
      state.theme = themes[i];
      saveState();
      showToast('Theme: ' + themes[i]);
    });
  }

  function openSettings() {
    els.overlay.classList.remove('hidden');
    els.settings.classList.remove('hidden');
  }
  function closeSettings() {
    els.overlay.classList.add('hidden');
    els.settings.classList.add('hidden');
  }

  function saveSettingsFromModal() {
    state.interval = clamp(+els.settingsInterval.value || DEFAULTS.interval, 1, 60);
    state.autoCheck = !!els.settingsAutoCheck.checked;
    state.predictedDate = els.predictedDate.value || null;
    state.soundOn = !!els.soundOn.checked;
    state.notifOn = !!els.notifOn.checked;
    state.webhookUrl = (els.webhookUrl.value || '').trim();
    // quick apply to small UI
    els.interval.value = state.interval;
    els.autoCheck.checked = state.autoCheck;
    els.compactMode.checked = !!state.compactMode;
    saveState();
    startAuto();
    refreshCountdown();
    showToast('Settings saved');
    closeSettings();
  }

  function resetSettings() {
    if (!confirm('Reset all settings to defaults?')) return;
    state = Object.assign({}, DEFAULTS);
    saveState();
    // reflect to UI
    document.documentElement.setAttribute('data-theme', state.theme);
    els.interval.value = state.interval;
    els.autoCheck.checked = state.autoCheck;
    els.compactMode.checked = state.compactMode;
    els.settingsInterval.value = state.interval;
    els.settingsAutoCheck.checked = state.autoCheck;
    els.predictedDate.value = '';
    els.soundOn.checked = state.soundOn;
    els.notifOn.checked = state.notifOn;
    els.webhookUrl.value = '';
    applyCompactMode();
    startAuto();
    refreshCountdown();
    showToast('Settings reset');
    closeSettings();
  }

  function openVersionModal(id, type) {
    const item = (lastVersionsCache || []).find(v => v.id === id) || { id, type, time: null, releaseTime: null };
    els.versionTitle.textContent = item.id;
    const when = format(item.releaseTime || item.time) || 'Unknown';
    els.versionBody.innerHTML = `<p><strong>Type:</strong> ${item.type}</p>
      <p><strong>Published:</strong> ${when}</p>
      <p class="muted">Links: Minecraft site search & download server (raw).</p>
      <ul>
        <li><a href="https://www.minecraft.net/en-us/search?search=${encodeURIComponent(item.id)}" target="_blank" rel="noopener">Search on minecraft.net</a></li>
        <li><a href="https://launchermeta.mojang.com/v1/packages/" target="_blank" rel="noopener">Launcher meta (raw)</a></li>
      </ul>`;
    els.versionModal.classList.remove('hidden');
    els.overlay.classList.remove('hidden');
  }
  function closeVersionModal() {
    els.versionModal.classList.add('hidden');
    if (els.settings.classList.contains('hidden')) els.overlay.classList.add('hidden');
  }

  function showToast(msg, ttl = 3500) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.style.opacity = '1', 10);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 400);
    }, ttl);
  }

  function triggerVisual() {
    if (!els.alertVisual) return;
    els.alertVisual.classList.remove('fire');
    void els.alertVisual.offsetWidth;
    els.alertVisual.classList.add('fire');
    // tiny spark animation
    els.alertVisual.innerHTML = `<svg width="52" height="52" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2l1.9 4.9L19 8l-3.6 3.1L16.1 16 12 13.7 7.9 16l.7-4.9L5 8l5.1-1.1L12 2z"/></svg>`;
    setTimeout(()=>{ els.alertVisual.innerHTML=''; }, 1400);
  }

  /* -------------------- audio alert (WebAudio) -------------------- */
  function playNoteSequence() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [784, 988, 1318]; // G5 B5 E6-ish (bright)
      let t = ctx.currentTime;
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = f;
        g.gain.value = 0;
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t + i * 0.12);
        g.gain.linearRampToValueAtTime(0.12, t + i * 0.02);
        g.gain.linearRampToValueAtTime(0.0001, t + i * 0.12 + 0.18);
        o.stop(t + i * 0.12 + 0.22);
      });
    } catch (e) { console.warn('Audio failed', e); }
  }

  /* -------------------- helpers & state -------------------- */
  function format(s) {
    if (!s) return '';
    try { return new Date(s).toLocaleString(); } catch (e) { return s; }
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function escapeHTML(s) { return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  function applyTheme(theme) {
    if (!theme) theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }

  function saveState() {
    localStorage.setItem('mc_companion_state', JSON.stringify(state));
  }
  function loadState() {
    try {
      const raw = localStorage.getItem('mc_companion_state');
      if (!raw) return Object.assign({}, DEFAULTS);
      return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }

  function startAuto() {
    stopAuto();
    if (!state.autoCheck) return;
    timer = setInterval(() => update().catch(console.error), (state.interval || 10) * 60 * 1000);
  }
  function stopAuto() { if (timer) clearInterval(timer); }

  /* compact mode reflect */
  function applyCompactMode() {
    const table = els.versionsTable;
    if (!table) return;
    table.classList.toggle('compact', !!state.compactMode);
  }

  /* countdown */
  function refreshCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    if (!state.predictedDate) {
      els.countdownDisplay.textContent = '—';
      return;
    }
    const target = new Date(state.predictedDate);
    countdownTimer = setInterval(() => {
      const now = new Date();
      const diff = target - now;
      if (diff <= 0) {
        els.countdownDisplay.textContent = 'Release date reached!';
        clearInterval(countdownTimer);
        return;
      }
      const days = Math.floor(diff / (1000*60*60*24));
      const hours = Math.floor((diff % (1000*60*60*24)) / (1000*60*60));
      const mins = Math.floor((diff % (1000*60*60)) / (1000*60));
      const secs = Math.floor((diff % (1000*60)) / 1000);
      els.countdownDisplay.textContent = `${days}d ${hours}h ${mins}m ${secs}s`;
    }, 900);
  }

  /* initialize UI on load */
  function startUIDefaults() {
    applyTheme(state.theme || 'dark');
    applyCompactMode();
  }
  startUIDefaults();

  // reflect some UI values
  els.settingsInterval.value = state.interval;
  els.interval.value = state.interval;
  els.autoCheck.checked = state.autoCheck;
  els.compactMode.checked = state.compactMode;

  // expose small debug (optional)
  window.MCCompanion = { state, update, fetchManifest };

})();
