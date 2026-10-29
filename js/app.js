/*
 * MPS Silks Inventory Datasheet — Main Frontend Application (v3).
 *
 * Implements:
 * - Role-based authentication (Admin, Entry, Purchase)
 * - Bundle management (create, autofill city, 'Nil' agent button, header update, reopen)
 * - Design-number-first line entry (typed, existing, generate via photo & colour-blind matcher)
 * - Palette extraction chips from paletteFromRGBA
 * - Dynamic size grid with live total count & QC toggle
 * - Offline support via IndexedDB outbox with concurrency ~3 sync (generate blocked offline)
 * - Photo fallback chain (lh3 -> Drive thumbnail -> photos.get base64) with caching
 * - A4 Landscape datasheet print view with red title band, ~100 lines per part, blank Stickering/GRN
 * - Purchase invoice check (counted vs invoice, excess/shortage, confirm lock & admin reopen)
 * - Admin screens (masters, users, settings, spreadsheet scale & cell usage monitor)
 * - Catalogue, Status, and Monthly Report views
 */
(function () {
  'use strict';

  var C = window.MPSCore;
  var API = window.MPSApi;

  // --- Global Application State ---
  var state = {
    user: API.getUser(),
    token: API.getToken(),
    masters: null,
    designs: [],
    signatures: {},
    currentBundle: null,
    online: navigator.onLine,
    outbox: [],
    syncing: false
  };

  // --- IndexedDB Offline Manager (Task 3) ---
  var DB_NAME = 'mps_silks_offline_v3';
  var DB_VERSION = 1;
  var dbPromise = null;

  function getDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        console.warn('IndexedDB not available');
        return resolve(null);
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('masters')) {
          db.createObjectStore('masters', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('designs')) {
          db.createObjectStore('designs', { keyPath: 'design_id' });
        }
        if (!db.objectStoreNames.contains('outbox')) {
          var outStore = db.createObjectStore('outbox', { keyPath: 'id' });
          outStore.createIndex('status', 'status', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) {
        console.warn('IndexedDB open error:', e);
        resolve(null);
      };
    });
    return dbPromise;
  }

  async function idbGet(storeName, key) {
    var db = await getDb();
    if (!db) return null;
    return new Promise(function (resolve) {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
  }

  async function idbSet(storeName, val) {
    var db = await getDb();
    if (!db) return;
    return new Promise(function (resolve) {
      var tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(val);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    });
  }

  async function idbGetAll(storeName) {
    var db = await getDb();
    if (!db) return [];
    return new Promise(function (resolve) {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { resolve([]); };
    });
  }

  async function idbDelete(storeName, key) {
    var db = await getDb();
    if (!db) return;
    return new Promise(function (resolve) {
      var tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    });
  }

  // --- Outbox & Concurrency ~3 Sync ---
  async function refreshOutbox() {
    state.outbox = await idbGetAll('outbox');
    updateSyncBadge();
  }

  async function addToOutbox(type, payload) {
    var item = {
      id: payload.requestId || API.genRequestId('out'),
      type: type,
      payload: payload,
      status: 'pending',
      error: '',
      timestamp: new Date().toISOString()
    };
    await idbSet('outbox', item);
    await refreshOutbox();
    toast('Saved to offline outbox. Will sync when reconnected.');
  }

  async function syncOutbox() {
    if (state.syncing || !navigator.onLine) return;
    state.syncing = true;
    updateSyncBadge();

    var items = await idbGetAll('outbox');
    var pending = items.filter(function (x) { return x.status === 'pending' || x.status === 'failed'; });
    if (!pending.length) {
      state.syncing = false;
      updateSyncBadge();
      return;
    }

    // Process with concurrency limit ~3
    var CONCURRENCY = 3;
    var idx = 0;

    async function worker() {
      while (idx < pending.length) {
        var cur = pending[idx++];
        cur.status = 'syncing';
        await idbSet('outbox', cur);
        updateSyncBadge();

        try {
          var res;
          if (cur.type === 'line.save') {
            res = await API.lineSave(cur.payload);
          } else if (cur.type === 'bundles.create') {
            res = await API.bundlesCreate(cur.payload);
          } else {
            res = { ok: true };
          }

          if (res && res.ok) {
            await idbDelete('outbox', cur.id);
          } else {
            cur.status = 'failed';
            cur.error = res ? (res.error || (res.errors && res.errors.join(', '))) : 'Sync error';
            await idbSet('outbox', cur);
          }
        } catch (err) {
          cur.status = 'failed';
          cur.error = err.message || 'Network failure';
          await idbSet('outbox', cur);
        }
      }
    }

    var workers = [];
    for (var i = 0; i < Math.min(CONCURRENCY, pending.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    state.syncing = false;
    await refreshOutbox();
    toast('Offline sync finished.');
  }

  function updateSyncBadge() {
    var btn = document.getElementById('btn-sync');
    var dot = document.getElementById('net-dot');
    var txt = document.getElementById('sync-text');
    if (!btn || !dot || !txt) return;

    var pending = state.outbox.filter(function (x) { return x.status === 'pending' || x.status === 'syncing'; }).length;
    var failed = state.outbox.filter(function (x) { return x.status === 'failed'; }).length;

    if (!navigator.onLine) {
      dot.className = 'dot offline';
      txt.textContent = pending ? pending + ' pending (offline)' : 'Offline';
      btn.className = 'sync-badge pending';
    } else if (state.syncing) {
      dot.className = 'dot online';
      txt.textContent = 'Syncing...';
      btn.className = 'sync-badge pending';
    } else if (failed > 0) {
      dot.className = 'dot online';
      txt.textContent = failed + ' failed (tap)';
      btn.className = 'sync-badge failed';
    } else if (pending > 0) {
      dot.className = 'dot online';
      txt.textContent = pending + ' pending';
      btn.className = 'sync-badge pending';
    } else {
      dot.className = 'dot online';
      txt.textContent = 'Online';
      btn.className = 'sync-badge';
    }
  }

  // --- Notification Toast ---
  var toastTimeout = null;
  function toast(msg, isError) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.style.borderLeftColor = isError ? 'var(--bad)' : 'var(--gold)';
    el.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function () {
      el.classList.remove('show');
    }, 3800);
  }

  // --- Image Resize Helper ---
  // Resizes photo client-side to max 480px width, extracts RGBA pixels and dataURL
  function processCapturedImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          var targetW = 480;
          var scale = Math.min(1, targetW / img.width);
          var w = Math.round(img.width * scale);
          var h = Math.round(img.height * scale);

          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);

          var imgData = ctx.getImageData(0, 0, w, h);
          var dataUrl = canvas.toDataURL('image/jpeg', 0.85);

          resolve({
            dataUrl: dataUrl,
            rgba: imgData.data,
            w: w,
            h: h
          });
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // --- Load Masters & Cache ---
  async function loadMasters(force) {
    if (state.masters && !force) return state.masters;
    if (navigator.onLine) {
      try {
        var res = await API.mastersGet(true);
        if (res && res.ok) {
          state.masters = res;
          await idbSet('masters', { key: 'data', val: res, ts: Date.now() });
          return res;
        }
      } catch (e) {
        console.warn('Failed to fetch masters online:', e);
      }
    }
    // Fallback to IndexedDB
    var cached = await idbGet('masters', 'data');
    if (cached && cached.val) {
      state.masters = cached.val;
      return state.masters;
    }
    return null;
  }

  // --- Header Navigation & Role Visibility ---
  function updateNav() {
    var user = state.user;
    var userInfo = document.getElementById('user-info');
    var userName = document.getElementById('user-name');
    var userRole = document.getElementById('user-role');
    var btnLogout = document.getElementById('btn-logout');

    var navBundles = document.getElementById('nav-bundles');
    var navBundleNew = document.getElementById('nav-bundle-new');
    var navFinder = document.getElementById('nav-finder');
    var navCatalogue = document.getElementById('nav-catalogue');
    var navStatus = document.getElementById('nav-status');
    var navReport = document.getElementById('nav-report');
    var navAdmin = document.getElementById('nav-admin');

    if (user) {
      if (userInfo) userInfo.hidden = false;
      if (userName) userName.textContent = user.name;
      if (userRole) userRole.textContent = user.role;
      if (btnLogout) btnLogout.hidden = false;

      var role = user.role;
      if (navBundles) navBundles.hidden = false;
      if (navBundleNew) navBundleNew.hidden = role === 'purchase';
      if (navFinder) navFinder.hidden = role === 'purchase';
      if (navCatalogue) navCatalogue.hidden = false;
      if (navStatus) navStatus.hidden = false;
      if (navReport) navReport.hidden = role === 'entry';
      if (navAdmin) navAdmin.hidden = role !== 'admin';
    } else {
      if (userInfo) userInfo.hidden = true;
      if (btnLogout) btnLogout.hidden = true;
      if (navBundles) navBundles.hidden = true;
      if (navBundleNew) navBundleNew.hidden = true;
      if (navFinder) navFinder.hidden = true;
      if (navCatalogue) navCatalogue.hidden = true;
      if (navStatus) navStatus.hidden = true;
      if (navReport) navReport.hidden = true;
      if (navAdmin) navAdmin.hidden = true;
    }
  }

  // ==========================================================================
  // VIEW RENDERERS
  // ==========================================================================

  // --- 1. Login View ---
  function renderLogin() {
    var app = document.getElementById('app');
    app.innerHTML = `
      <div class="narrow login">
        <div style="text-align: center; margin-bottom: 32px;">
          <img src="assets/mps-logo.png" alt="MPS Silks" style="height: 64px; margin: 0 auto 16px;">
          <p class="eyebrow">Inventory Datasheet System</p>
          <h2>Sign In</h2>
          <p class="mute" style="font-size: 13px;">Enter your staff name and numeric PIN.</p>
        </div>

        <form id="form-login">
          <div class="field">
            <label for="login-name">Staff Name</label>
            <input type="text" id="login-name" required autocomplete="username" placeholder="e.g. Admin or Ravi">
          </div>
          <div class="field">
            <label for="login-pin">PIN (Digits)</label>
            <input type="password" id="login-pin" required inputmode="numeric" pattern="[0-9]*" placeholder="••••">
          </div>
          <div id="login-err" class="alert err" style="display: none;"></div>
          <button type="submit" id="btn-submit-login" class="btn block">Sign In</button>
        </form>
      </div>
    `;

    document.getElementById('form-login').onsubmit = async function (e) {
      e.preventDefault();
      var name = document.getElementById('login-name').value.trim();
      var pin = document.getElementById('login-pin').value.trim();
      var btn = document.getElementById('btn-submit-login');
      var errEl = document.getElementById('login-err');
      errEl.style.display = 'none';

      btn.disabled = true;
      btn.textContent = 'Verifying...';

      var res = await API.login(name, pin);
      btn.disabled = false;
      btn.textContent = 'Sign In';

      if (res && res.ok) {
        state.user = res.user;
        state.token = res.token;
        updateNav();
        await loadMasters(true);
        toast('Welcome, ' + res.user.name);
        window.location.hash = '#bundles';
      } else {
        errEl.textContent = res ? (res.error || (res.errors && res.errors.join(', '))) : 'Sign in failed';
        errEl.style.display = 'block';
      }
    };
  }

  // --- 2. Bundles List View ---
  async function renderBundles() {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="skeleton"></div>';

    var res = await API.bundlesList();
    var bundles = (res && res.ok && res.bundles) || [];

    var isPurchase = state.user && state.user.role === 'purchase';
    var isEntry = state.user && state.user.role === 'entry';

    app.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 16px; margin-bottom: 32px;">
        <div>
          <p class="eyebrow">Godown Receipts</p>
          <h1>Datasheet Bundles</h1>
          <p class="lede">Manage supplier bundles, line entries, and invoice confirmations.</p>
        </div>
        ${!isPurchase ? '<a href="#bundle-new" class="btn gold">+ New Bundle</a>' : ''}
      </div>

      <div class="field-inline" style="margin-bottom: 24px; max-width: 420px;">
        <input type="text" id="bundle-search" placeholder="Search supplier, city, agent or bundle ID...">
      </div>

      <div class="cards-grid" id="bundles-grid">
        ${bundles.length === 0 ? '<div class="card-item" style="grid-column: 1/-1; text-align: center;"><p class="mute">No bundles created yet.</p></div>' : ''}
        ${bundles.map(function (b) {
          return `
            <div class="card-item" data-bundle-id="${b.bundle_id}">
              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                  <span class="badge ${b.status === 'Open' ? 'open' : 'checked'}">${b.status}</span>
                  <span style="font-size: 11px; letter-spacing: .1em; color: var(--mute);">${b.opened_date || ''}</span>
                </div>
                <h3 style="margin-bottom: 4px;">${escapeHtml(b.supplier)}</h3>
                <p class="mute" style="font-size: 13px; margin: 0 0 16px;">
                  ${escapeHtml(b.city || '')}${b.agent ? ' · Agent: ' + escapeHtml(b.agent) : ''}
                </p>
                <div style="display: flex; justify-content: space-between; font-size: 12px; border-top: 1px solid var(--line); padding-top: 12px;">
                  <span>Lines: <b>${b.lines || 0}</b></span>
                  <span>Total Qty: <b>${b.total_qty || 0}</b></span>
                </div>
              </div>

              <div class="btn-group" style="margin-top: 20px;">
                ${b.status === 'Open' && !isPurchase ? `<a href="#bundle/${b.bundle_id}/entry" class="btn small gold">Enter Lines</a>` : ''}
                <a href="#bundle/${b.bundle_id}" class="btn small ghost">Datasheet</a>
                ${isPurchase || state.user.role === 'admin' ? `<a href="#invoice/${b.bundle_id}" class="btn small ghost">Invoice Check</a>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    var searchInput = document.getElementById('bundle-search');
    if (searchInput) {
      searchInput.oninput = function () {
        var q = searchInput.value.toLowerCase();
        var cards = document.querySelectorAll('#bundles-grid .card-item');
        cards.forEach(function (card) {
          card.style.display = card.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      };
    }
  }

  // --- 3. New Bundle View ---
  async function renderNewBundle() {
    var app = document.getElementById('app');
    var m = await loadMasters();
    var suppliers = (m && m.suppliers) || [];

    app.innerHTML = `
      <div class="narrow" style="margin: 0 auto;">
        <p class="eyebrow">Supplier Handover</p>
        <h2>Create New Bundle</h2>
        <p class="mute lede">Open a datasheet bundle for 1,000–2,000 pieces from a supplier.</p>

        <form id="form-bundle-new">
          <div class="field">
            <label for="bnd-supplier">Supplier</label>
            <select id="bnd-supplier" required>
              <option value="">-- Choose Supplier --</option>
              ${suppliers.map(function (s) {
                return `<option value="${s.supplier_id}" data-city="${escapeHtml(s.city || '')}" data-agent="${escapeHtml(s.agent || '')}">${escapeHtml(s.name)} (${escapeHtml(s.city || 'Godown')})</option>`;
              }).join('')}
            </select>
          </div>

          <div class="field">
            <label for="bnd-city">City</label>
            <input type="text" id="bnd-city" required placeholder="Supplier city">
          </div>

          <div class="field">
            <label for="bnd-agent">Agent (or select Nil)</label>
            <div class="field-inline">
              <input type="text" id="bnd-agent" required placeholder="Agent name">
              <button type="button" id="btn-agent-nil" class="btn-nil">Nil</button>
            </div>
          </div>

          <div class="field">
            <label for="bnd-opened-by">Bundle Opened By</label>
            <input type="text" id="bnd-opened-by" required value="${escapeHtml(state.user ? state.user.name : '')}">
          </div>

          <div class="field">
            <label for="bnd-opened-date">Opened Date</label>
            <input type="date" id="bnd-opened-date" required value="${new Date().toISOString().slice(0, 10)}">
          </div>

          <button type="submit" id="btn-create-bnd" class="btn block gold">Open Bundle & Start Line Entry</button>
        </form>
      </div>
    `;

    var supSelect = document.getElementById('bnd-supplier');
    var cityInput = document.getElementById('bnd-city');
    var agentInput = document.getElementById('bnd-agent');
    var nilBtn = document.getElementById('btn-agent-nil');

    supSelect.onchange = function () {
      var opt = supSelect.options[supSelect.selectedIndex];
      if (opt && opt.value) {
        cityInput.value = opt.getAttribute('data-city') || '';
        agentInput.value = opt.getAttribute('data-agent') || 'Nil';
      }
    };

    nilBtn.onclick = function () {
      agentInput.value = 'Nil';
    };

    document.getElementById('form-bundle-new').onsubmit = async function (e) {
      e.preventDefault();
      var supplierId = supSelect.value;
      var city = cityInput.value.trim();
      var agent = agentInput.value.trim();
      var openedBy = document.getElementById('bnd-opened-by').value.trim();
      var openedDate = document.getElementById('bnd-opened-date').value;

      if (!agent) agent = 'Nil';

      var payload = {
        supplier_id: supplierId,
        city: city,
        agent: agent,
        opened_by: openedBy,
        opened_date: openedDate,
        requestId: API.genRequestId('bnd')
      };

      var btn = document.getElementById('btn-create-bnd');
      btn.disabled = true;
      btn.textContent = 'Opening Bundle...';

      if (!navigator.onLine) {
        await addToOutbox('bundles.create', payload);
        toast('Bundle created offline. Opening entry screen.');
        window.location.hash = '#bundles';
        return;
      }

      var res = await API.bundlesCreate(payload);
      btn.disabled = false;
      if (res && res.ok) {
        toast('Bundle ' + res.bundle.bundle_id + ' opened!');
        window.location.hash = '#bundle/' + res.bundle.bundle_id + '/entry';
      } else {
        toast((res && (res.error || (res.errors && res.errors.join(', ')))) || 'Failed to open bundle', true);
      }
    };
  }

  // --- 4. Line Entry Screen (Design-number-first flow) ---
  async function renderLineEntry(bundleId) {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="skeleton"></div>';

    var bRes = await API.bundlesGet({ bundle_id: bundleId });
    if (!bRes || !bRes.ok) {
      app.innerHTML = `<div class="alert err">Bundle not found or error loading: ${escapeHtml((bRes && bRes.error) || '')}</div><a href="#bundles" class="btn">Back to Bundles</a>`;
      return;
    }

    var bundle = bRes.bundle;
    var existingLines = bRes.lines || [];
    var m = await loadMasters();
    var supplier = (m.suppliers || []).find(function (s) { return s.supplier_id === bundle.supplier_id; }) || { name: bundle.supplier, supplier_id: bundle.supplier_id };

    var products = (m.products || []).filter(function (p) { return p.active === 'Y'; });
    var brands = (m.brands || []).filter(function (b) { return b.active === 'Y'; });
    var lists = m.lists || {};
    var sizeSets = m.sizeSets || [];
    var settings = m.settings || {};

    // Photo requirement per rules
    var photoRequired = settings.photo_mode === 'all' || (supplier && supplier.photo_required === 'Y');

    // Fetch existing designs for this supplier for autocomplete and candidate matching
    var desRes = await API.designsList(bundle.supplier_id);
    var knownDesigns = (desRes && desRes.ok && desRes.designs) || [];

    // State for this entry form
    var currentMode = 'typed'; // 'typed' | 'existing' | 'generate'
    var capturedPhoto = null;  // { dataUrl, rgba, w, h }
    var selectedColour = (lists.colour && lists.colour[0] && lists.colour[0].value) || 'Mustard';
    var selectedColourHex = (lists.colour && lists.colour[0] && lists.colour[0].extra) || '#c9a01f';
    var extractedPalette = [];
    var confirmedCandidate = null;

    app.innerHTML = `
      <div style="margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
          <div>
            <p class="eyebrow">${escapeHtml(bundle.supplier)} (${escapeHtml(bundle.city || '')})</p>
            <h2>Enter Line: Bundle ${bundle.bundle_id}</h2>
          </div>
          <div class="btn-group">
            <a href="#bundle/${bundle.bundle_id}" class="btn small ghost">View Datasheet (${bRes.total || 0} lines)</a>
          </div>
        </div>
      </div>

      <div class="split" style="display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 32px;">
        <!-- Left: Photo Capture & Palette Extraction -->
        <div>
          <label>Product Photo ${photoRequired ? '<span style="color:var(--bad)">* (Required)</span>' : '(Optional)'}</label>
          <div class="photo-box" id="photo-box">
            <input type="file" id="camera-input" accept="image/*" capture="environment">
            <div id="photo-placeholder">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin: 0 auto 12px; color: var(--mute);">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                <circle cx="12" cy="13" r="4"></circle>
              </svg>
              <p style="font-size: 11px; letter-spacing: .18em; text-transform: uppercase; margin: 0 0 4px;">Tap to Take Photo</p>
              <small class="mute">Camera capture or browse image</small>
            </div>
            <div id="photo-preview-wrap" class="photo-preview-wrap" style="display: none;">
              <img id="img-preview" alt="Product preview">
              <button type="button" id="btn-retake-photo" class="btn-retake">Retake</button>
            </div>
          </div>

          <!-- Palette Chips from paletteFromRGBA -->
          <div id="palette-section" style="margin-top: 18px; display: none;">
            <label>Extracted Dominant Palette (Tap to pick)</label>
            <div id="palette-chips" class="palette-chips"></div>
          </div>

          <!-- Possible Match Banner -->
          <div id="match-banner" class="alert warn" style="display: none; margin-top: 18px;">
            <div style="flex: 1;">
              <b>Possible Match Detected!</b>
              <p id="match-details" style="margin: 6px 0 10px; font-size: 12px;"></p>
              <div class="btn-group">
                <button type="button" id="btn-confirm-match" class="btn small">Yes, Use Existing Design</button>
                <button type="button" id="btn-reject-match" class="btn small ghost">No, Treat as New</button>
              </div>
            </div>
          </div>

          <!-- Offline Warning for Generate Mode -->
          <div id="offline-gen-warn" class="alert warn" style="display: none; margin-top: 18px;">
            <b>Offline Notice:</b> Design number generation requires connectivity for sequence numbering. Please use <b>Typed</b> or <b>Existing</b> mode, or reconnect.
          </div>
        </div>

        <!-- Right: Design Number & Attributes Form -->
        <div>
          <!-- Duplicate design inside bundle warning -->
          <div id="dup-warning" class="alert info" style="display: none;"></div>

          <form id="form-line-entry">
            <!-- Mode Selection Tabs -->
            <label>Design Number Flow</label>
            <div class="btn-group" style="margin-bottom: 20px;">
              <button type="button" class="btn small" id="mode-btn-typed">Type Number</button>
              <button type="button" class="btn small ghost" id="mode-btn-existing">Pick Existing</button>
              <button type="button" class="btn small ghost" id="mode-btn-generate">Generate MPS-XXX</button>
            </div>

            <!-- 1. Typed Mode Input -->
            <div id="section-typed" class="field">
              <label for="input-design-no">Design Number *</label>
              <input type="text" id="input-design-no" placeholder="e.g. 1045 or SLS-02" style="text-transform: uppercase;">
              <small class="mute" id="typed-preview" style="display: block; margin-top: 6px;"></small>
            </div>

            <!-- 2. Existing Mode Picker -->
            <div id="section-existing" class="field" style="display: none;">
              <label for="select-existing-design">Choose Existing Design *</label>
              <select id="select-existing-design">
                <option value="">-- Choose Existing Design --</option>
                ${knownDesigns.map(function (d) {
                  return `<option value="${d.design_id}">${d.design_no} (${(d.attrs && d.attrs.product) || 'Garment'})</option>`;
                }).join('')}
              </select>
            </div>

            <!-- 3. Generate Mode Info -->
            <div id="section-generate" class="field" style="display: none;">
              <p class="mute" style="font-size: 13px; margin: 0 0 10px;">
                The app will auto-sequence the next design number for <b>${escapeHtml(bundle.supplier)}</b> (e.g. <b>${C.supplierCode(bundle.supplier)}-0001</b>).
              </p>
            </div>

            <!-- Garment Attributes Grid -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
              <div class="field">
                <label for="attr-product">Product *</label>
                <select id="attr-product" required>
                  <option value="">-- Choose Product --</option>
                  ${products.map(function (p) {
                    return `<option value="${escapeHtml(p.name)}" data-set="${p.size_set}">${escapeHtml(p.name)}</option>`;
                  }).join('')}
                </select>
              </div>

              <div class="field">
                <label for="attr-brand">Brand</label>
                <select id="attr-brand">
                  <option value="${escapeHtml(supplier.brand || supplier.name)}">${escapeHtml(supplier.brand || supplier.name)} (Supplier Brand)</option>
                  ${brands.map(function (b) {
                    return `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`;
                  }).join('')}
                </select>
              </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
              <div class="field">
                <label for="attr-pattern">Pattern *</label>
                <select id="attr-pattern" required>
                  ${(lists.pattern || []).map(function (x) { return `<option value="${escapeHtml(x.value)}">${escapeHtml(x.value)}</option>`; }).join('')}
                </select>
              </div>

              <div class="field">
                <label for="attr-material">Material *</label>
                <select id="attr-material" required>
                  ${(lists.material || []).map(function (x) { return `<option value="${escapeHtml(x.value)}">${escapeHtml(x.value)}</option>`; }).join('')}
                </select>
              </div>
            </div>

            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;">
              <div class="field">
                <label for="attr-style">Style</label>
                <select id="attr-style">
                  ${(lists.style || []).map(function (x) { return `<option value="${escapeHtml(x.value)}">${escapeHtml(x.value)}</option>`; }).join('')}
                </select>
              </div>
              <div class="field">
                <label for="attr-fit">Fit</label>
                <select id="attr-fit">
                  ${(lists.fit || []).map(function (x) { return `<option value="${escapeHtml(x.value)}">${escapeHtml(x.value)}</option>`; }).join('')}
                </select>
              </div>
              <div class="field">
                <label for="attr-sleeve">Sleeve</label>
                <select id="attr-sleeve">
                  ${(lists.sleeve || []).map(function (x) { return `<option value="${escapeHtml(x.value)}">${escapeHtml(x.value)}</option>`; }).join('')}
                </select>
              </div>
              <div class="field">
                <label for="attr-type">Type</label>
                <select id="attr-type">
                  ${(lists.type || []).map(function (x) { return `<option value="${escapeHtml(x.value)}">${escapeHtml(x.value)}</option>`; }).join('')}
                </select>
              </div>
            </div>

            <!-- Colours Selection -->
            <div class="field">
              <label for="select-colour">Primary Colour *</label>
              <select id="select-colour" required>
                ${(lists.colour || []).map(function (c) {
                  return `<option value="${escapeHtml(c.value)}" data-hex="${c.extra}">${escapeHtml(c.value)}</option>`;
                }).join('')}
              </select>
            </div>

            <!-- Dynamic Size Grid -->
            <div class="field">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <label style="margin: 0;">Size Breakdown (Quantities)</label>
                <div class="total-qty-badge">Total Pieces: <b id="total-qty-count">0</b></div>
              </div>
              <div id="size-grid-container" class="size-grid"></div>
            </div>

            <!-- QC Pass & Actions -->
            <div class="field-inline" style="margin-bottom: 24px;">
              <input type="checkbox" id="qc-pass-checkbox" checked style="width: 22px; height: 22px; cursor: pointer;">
              <label for="qc-pass-checkbox" style="margin: 0; cursor: pointer; text-transform: none; font-size: 14px;">
                <b>QC Passed</b> (Quality check verified)
              </label>
            </div>

            <div class="btn-group">
              <button type="submit" id="btn-save-line" class="btn gold" style="flex: 1;">Save Line</button>
            </div>
          </form>
        </div>
      </div>
    `;

    // References
    var modeBtnTyped = document.getElementById('mode-btn-typed');
    var modeBtnExisting = document.getElementById('mode-btn-existing');
    var modeBtnGenerate = document.getElementById('mode-btn-generate');
    var sectionTyped = document.getElementById('section-typed');
    var sectionExisting = document.getElementById('section-existing');
    var sectionGenerate = document.getElementById('section-generate');
    var inputDesignNo = document.getElementById('input-design-no');
    var selectExisting = document.getElementById('select-existing-design');
    var dupWarning = document.getElementById('dup-warning');
    var offlineGenWarn = document.getElementById('offline-gen-warn');

    var cameraInput = document.getElementById('camera-input');
    var photoPlaceholder = document.getElementById('photo-placeholder');
    var photoPreviewWrap = document.getElementById('photo-preview-wrap');
    var imgPreview = document.getElementById('img-preview');
    var btnRetake = document.getElementById('btn-retake-photo');
    var paletteSection = document.getElementById('palette-section');
    var paletteChipsEl = document.getElementById('palette-chips');
    var selectColour = document.getElementById('select-colour');

    var attrProduct = document.getElementById('attr-product');
    var attrBrand = document.getElementById('attr-brand');
    var attrPattern = document.getElementById('attr-pattern');
    var attrStyle = document.getElementById('attr-style');
    var attrFit = document.getElementById('attr-fit');
    var attrSleeve = document.getElementById('attr-sleeve');
    var attrType = document.getElementById('attr-type');
    var attrMaterial = document.getElementById('attr-material');
    var sizeGridContainer = document.getElementById('size-grid-container');
    var totalQtyCount = document.getElementById('total-qty-count');

    // --- Mode Switching ---
    function setMode(mode) {
      currentMode = mode;
      modeBtnTyped.className = mode === 'typed' ? 'btn small' : 'btn small ghost';
      modeBtnExisting.className = mode === 'existing' ? 'btn small' : 'btn small ghost';
      modeBtnGenerate.className = mode === 'generate' ? 'btn small' : 'btn small ghost';

      sectionTyped.style.display = mode === 'typed' ? 'block' : 'none';
      sectionExisting.style.display = mode === 'existing' ? 'block' : 'none';
      sectionGenerate.style.display = mode === 'generate' ? 'block' : 'none';

      // Check offline constraint for generate
      if (!navigator.onLine && mode === 'generate') {
        offlineGenWarn.style.display = 'block';
        document.getElementById('btn-save-line').disabled = true;
      } else {
        offlineGenWarn.style.display = 'none';
        document.getElementById('btn-save-line').disabled = false;
      }
    }

    modeBtnTyped.onclick = function () { setMode('typed'); };
    modeBtnExisting.onclick = function () { setMode('existing'); };
    modeBtnGenerate.onclick = function () { setMode('generate'); };

    // Duplicate check in typed mode
    inputDesignNo.oninput = function () {
      var val = inputDesignNo.value.trim().toUpperCase();
      if (!val) {
        dupWarning.style.display = 'none';
        return;
      }
      var count = existingLines.filter(function (l) {
        return (l.design_no || '').toUpperCase() === val;
      }).length;

      if (count > 0) {
        dupWarning.textContent = 'Note: Design "' + val + '" has already been entered ' + count + ' time(s) in this bundle.';
        dupWarning.style.display = 'block';
      } else {
        dupWarning.style.display = 'none';
      }
    };

    // Existing design auto-fill
    selectExisting.onchange = function () {
      var dId = selectExisting.value;
      if (!dId) return;
      var d = knownDesigns.find(function (x) { return x.design_id === dId; });
      if (d && d.attrs) {
        if (d.attrs.product) attrProduct.value = d.attrs.product;
        if (d.attrs.brand) attrBrand.value = d.attrs.brand;
        if (d.attrs.pattern) attrPattern.value = d.attrs.pattern;
        if (d.attrs.style) attrStyle.value = d.attrs.style;
        if (d.attrs.fit) attrFit.value = d.attrs.fit;
        if (d.attrs.sleeve) attrSleeve.value = d.attrs.sleeve;
        if (d.attrs.type) attrType.value = d.attrs.type;
        if (d.attrs.material) attrMaterial.value = d.attrs.material;
        renderSizesForProduct();
      }
    };

    // Dynamic Size Grid rendering
    function renderSizesForProduct() {
      var opt = attrProduct.options[attrProduct.selectedIndex];
      var setId = opt ? opt.getAttribute('data-set') : '';
      var set = sizeSets.find(function (s) { return s.set_id === setId; }) || sizeSets[0];
      var sizes = (set && set.sizes) || ['S', 'M', 'L', 'XL', 'XXL'];

      sizeGridContainer.innerHTML = sizes.map(function (sz) {
        return `
          <div class="size-card">
            <div class="size-name">${escapeHtml(sz)}</div>
            <input type="number" min="0" data-size="${escapeHtml(sz)}" class="size-input" value="0">
          </div>
        `;
      }).join('');

      var inputs = sizeGridContainer.querySelectorAll('.size-input');
      inputs.forEach(function (inp) {
        inp.oninput = calculateTotalQty;
      });
      calculateTotalQty();
    }

    function calculateTotalQty() {
      var inputs = sizeGridContainer.querySelectorAll('.size-input');
      var total = 0;
      inputs.forEach(function (inp) {
        total += parseInt(inp.value, 10) || 0;
      });
      totalQtyCount.textContent = total;
    }

    attrProduct.onchange = renderSizesForProduct;
    if (products.length > 0) {
      attrProduct.value = products[0].name;
      renderSizesForProduct();
    }

    // Camera Capture & Palette extraction
    cameraInput.onchange = async function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;

      try {
        var processed = await processCapturedImage(file);
        capturedPhoto = processed;
        imgPreview.src = processed.dataUrl;
        photoPlaceholder.style.display = 'none';
        photoPreviewWrap.style.display = 'block';

        // 1. Dominant colour extraction
        var coloursPool = (lists.colour || []).map(function (c) { return { value: c.value, extra: c.extra }; });
        var palette = C.paletteFromRGBA(processed.rgba, processed.w, processed.h, coloursPool, 3);
        extractedPalette = palette;

        if (palette && palette.length > 0) {
          paletteSection.style.display = 'block';
          paletteChipsEl.innerHTML = palette.map(function (chip) {
            return `
              <button type="button" class="chip" data-colour="${escapeHtml(chip.name)}" data-hex="${chip.hex}">
                <span class="chip-swatch" style="background-color: ${chip.hex};"></span>
                <span>${escapeHtml(chip.name)}</span>
                <span class="chip-share">${Math.round(chip.share * 100)}%</span>
              </button>
            `;
          }).join('');

          // Select top colour by default
          selectColour.value = palette[0].name;
          selectedColour = palette[0].name;
          selectedColourHex = palette[0].hex;

          paletteChipsEl.querySelectorAll('.chip').forEach(function (chipBtn) {
            chipBtn.onclick = function () {
              var cName = chipBtn.getAttribute('data-colour');
              var cHex = chipBtn.getAttribute('data-hex');
              selectColour.value = cName;
              selectedColour = cName;
              selectedColourHex = cHex;
              paletteChipsEl.querySelectorAll('.chip').forEach(function (b) { b.classList.remove('selected'); });
              chipBtn.classList.add('selected');
            };
          });
        }

        // 2. Grayscale analysis & Colour-blind matching against existing designs
        var an = C.analyseRGBA(processed.rgba, processed.w, processed.h);
        var pyr = C.queryPyramid(an);
        var sigs = (await API.designsSignatures(bundle.supplier_id)).signatures || {};

        var matches = C.matchDesigns(an, pyr, knownDesigns, sigs, bundle.supplier);
        var strong = matches.find(function (m) { return m.verdict === 'same' || m.verdict === 'possible'; });

        var matchBanner = document.getElementById('match-banner');
        var matchDetails = document.getElementById('match-details');

        if (strong) {
          matchDetails.textContent = `Design ${strong.design_no} looks very similar (Verdict: ${strong.verdict}). Do you want to use this existing design number?`;
          matchBanner.style.display = 'block';

          document.getElementById('btn-confirm-match').onclick = function () {
            confirmedCandidate = strong;
            setMode('existing');
            selectExisting.value = strong.design.design_id;
            selectExisting.onchange();
            matchBanner.style.display = 'none';
            toast('Matched with ' + strong.design_no);
          };

          document.getElementById('btn-reject-match').onclick = function () {
            confirmedCandidate = null;
            matchBanner.style.display = 'none';
            setMode('generate');
          };
        } else {
          matchBanner.style.display = 'none';
        }
      } catch (err) {
        console.error('Image processing error:', err);
        toast('Failed to process image: ' + err.message, true);
      }
    };

    btnRetake.onclick = function () {
      capturedPhoto = null;
      imgPreview.src = '';
      photoPlaceholder.style.display = 'block';
      photoPreviewWrap.style.display = 'none';
      paletteSection.style.display = 'none';
      cameraInput.value = '';
    };

    // Form submission
    document.getElementById('form-line-entry').onsubmit = async function (e) {
      e.preventDefault();

      if (photoRequired && !capturedPhoto) {
        toast('A photo is required for this supplier.', true);
        return;
      }

      var opt = attrProduct.options[attrProduct.selectedIndex];
      var sizeSetId = opt ? opt.getAttribute('data-set') : '';
      if (!sizeSetId && sizeSets[0]) sizeSetId = sizeSets[0].set_id;

      var sizes = {};
      var inputs = sizeGridContainer.querySelectorAll('.size-input');
      inputs.forEach(function (inp) {
        var q = parseInt(inp.value, 10);
        if (q > 0) sizes[inp.getAttribute('data-size')] = q;
      });

      if (Object.keys(sizes).length === 0) {
        toast('Enter at least one size quantity.', true);
        return;
      }

      var designNo = '';
      var designId = '';

      if (currentMode === 'typed') {
        designNo = inputDesignNo.value.trim().toUpperCase();
        if (!C.validDesignNo(designNo)) {
          toast('Please enter a valid design number.', true);
          return;
        }
      } else if (currentMode === 'existing') {
        designId = selectExisting.value;
        if (!designId) {
          toast('Please choose an existing design.', true);
          return;
        }
      } else if (currentMode === 'generate') {
        if (!navigator.onLine) {
          toast('Generate mode is not available offline.', true);
          return;
        }
      }

      var attrs = {
        product: attrProduct.value,
        brand: attrBrand.value,
        pattern: attrPattern.value,
        style: attrStyle.value,
        fit: attrFit.value,
        sleeve: attrSleeve.value,
        type: attrType.value,
        material: attrMaterial.value
      };

      // Generate fingerprint & signature if photo present
      var fp = '';
      var sig = '';
      if (capturedPhoto) {
        var an = C.analyseRGBA(capturedPhoto.rgba, capturedPhoto.w, capturedPhoto.h);
        fp = an.fingerprint;
        sig = C.makeSignature(an);
      }

      var payload = {
        bundleId: bundle.bundle_id,
        requestId: API.genRequestId('line'),
        designMode: currentMode,
        designNo: designNo,
        designId: designId,
        sizeSet: sizeSetId,
        sizes: sizes,
        colourNames: [selectColour.value],
        colourHex: [selectedColourHex],
        attrs: attrs,
        qc: document.getElementById('qc-pass-checkbox').checked,
        photo: capturedPhoto ? capturedPhoto.dataUrl : '',
        fingerprint: fp,
        signature: sig
      };

      var btnSave = document.getElementById('btn-save-line');
      btnSave.disabled = true;
      btnSave.textContent = 'Saving Line...';

      if (!navigator.onLine) {
        await addToOutbox('line.save', payload);
        btnSave.disabled = false;
        btnSave.textContent = 'Save Line';
        // Reset inputs for next piece
        inputs.forEach(function (inp) { inp.value = '0'; });
        calculateTotalQty();
        inputDesignNo.value = '';
        btnRetake.click();
        return;
      }

      var res = await API.lineSave(payload);
      btnSave.disabled = false;
      btnSave.textContent = 'Save Line';

      if (res && res.ok) {
        toast('Line saved! Design: ' + res.design_no);
        existingLines.push({
          line_id: (res.line && res.line.line_id) || API.genRequestId('l'),
          design_id: (res.line && res.line.design_id) || res.design_no,
          design_no: res.design_no,
          entered_by: state.user ? state.user.name : ''
        });
        var desId = (res.line && res.line.design_id) || res.design_no;
        if (!knownDesigns.some(function (d) { return d.design_id === desId; })) {
          knownDesigns.push({
            design_id: desId,
            design_no: res.design_no,
            attrs: attrs
          });
          var newOpt = document.createElement('option');
          newOpt.value = desId;
          newOpt.textContent = res.design_no + ' (' + (attrs.product || 'Garment') + ')';
          selectExisting.appendChild(newOpt);
        }
        // Fast next line reset
        inputs.forEach(function (inp) { inp.value = '0'; });
        calculateTotalQty();
        inputDesignNo.value = '';
        btnRetake.click();
        // Refresh local existing lines count
        var refreshed = await API.bundlesGet({ bundle_id: bundle.bundle_id, limit: 1 });
        if (refreshed && refreshed.ok) {
          var links = document.querySelectorAll('a[href="#bundle/' + bundle.bundle_id + '"]');
          links.forEach(function (l) { l.textContent = 'View Datasheet (' + refreshed.total + ' lines)'; });
        }
      } else {
        toast((res && (res.error || (res.errors && res.errors.join(', ')))) || 'Failed to save line', true);
      }
    };
  }

  // --- 5. Datasheet Lines View ---
  async function renderBundleDatasheet(bundleId) {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="skeleton"></div>';

    var res = await API.bundlesGet({ bundle_id: bundleId, limit: 500 });
    if (!res || !res.ok) {
      app.innerHTML = `<div class="alert err">Bundle not found: ${escapeHtml((res && res.error) || '')}</div><a href="#bundles" class="btn">Back</a>`;
      return;
    }

    var bundle = res.bundle;
    var lines = res.lines || [];
    var designs = res.designs || [];
    var people = res.people || [];
    var user = state.user;
    var isPurchase = user && user.role === 'purchase';
    var isAdmin = user && user.role === 'admin';

    app.innerHTML = `
      <div style="margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px;">
          <div>
            <p class="eyebrow">${escapeHtml(bundle.supplier)} · ${escapeHtml(bundle.city || '')}</p>
            <h1>Bundle ${bundle.bundle_id}</h1>
            <p class="mute" style="font-size: 13px; margin: 0;">
              Agent: <b>${escapeHtml(bundle.agent || 'Nil')}</b> · Opened by: <b>${escapeHtml(bundle.opened_by || '')}</b> (${bundle.opened_date || ''}) ·
              Status: <span class="badge ${bundle.status === 'Open' ? 'open' : 'checked'}">${bundle.status}</span>
            </p>
          </div>
          <div class="btn-group">
            ${bundle.status === 'Open' && !isPurchase ? `<a href="#bundle/${bundle.bundle_id}/entry" class="btn gold small">+ Enter Line</a>` : ''}
            <a href="#bundle/${bundle.bundle_id}/print" class="btn small">Print Datasheet</a>
            ${isPurchase || isAdmin ? `<a href="#invoice/${bundle.bundle_id}" class="btn small ghost">Invoice Check</a>` : ''}
            ${isAdmin && bundle.status !== 'Open' ? `<button id="btn-admin-reopen" class="btn small ghost">Reopen</button>` : ''}
          </div>
        </div>
      </div>

      <!-- Live Counted Totals Per Design -->
      <div style="margin-bottom: 32px;">
        <h3 style="font-size: 13px;">Live Counted Summary per Design</h3>
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Design No</th>
                <th style="text-align: right;">Counted Pieces</th>
                <th style="text-align: right;">Lines Entered</th>
                <th>Entered By Staff</th>
              </tr>
            </thead>
            <tbody>
              ${designs.length === 0 ? '<tr><td colspan="4" class="mute">No lines entered yet.</td></tr>' : ''}
              ${designs.map(function (d) {
                return `
                  <tr>
                    <td><b>${escapeHtml(d.design_no)}</b></td>
                    <td style="text-align: right; font-weight: 600; color: var(--gold-dark);">${d.counted}</td>
                    <td style="text-align: right;">${d.lines}</td>
                    <td style="font-size: 12px; color: var(--mute);">${(d.persons || []).join(', ')}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Filter Bar -->
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px;">
        <h3>Datasheet Lines (${lines.length})</h3>
        <div class="btn-group">
          <button type="button" id="filter-all-lines" class="btn small">All Lines</button>
          <button type="button" id="filter-my-lines" class="btn small ghost">My Lines Only</button>
        </div>
      </div>

      <!-- Datasheet Lines Table -->
      <div class="tablewrap">
        <table id="lines-table">
          <thead>
            <tr>
              <th>S.No</th>
              <th>Photo</th>
              <th>Design No</th>
              <th>Product</th>
              <th>Pattern / Material</th>
              <th>Colours</th>
              <th>Sizes / Quantities</th>
              <th>Total</th>
              <th>QC</th>
              <th>Entered By</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${lines.length === 0 ? '<tr><td colspan="11" class="mute">No lines recorded.</td></tr>' : ''}
            ${lines.map(function (l, idx) {
              var canDelete = isAdmin || (bundle.status === 'Open' && l.entered_by === (user ? user.name : ''));
              var sizesStr = Object.keys(l.sizes || {}).map(function (k) { return k + ':' + l.sizes[k]; }).join(' ');
              return `
                <tr data-line-id="${l.line_id}" data-entered-by="${escapeHtml(l.entered_by)}">
                  <td>${idx + 1}</td>
                  <td>
                    <img class="thumb-cell" data-photo-id="${l.photo_id || ''}" alt="">
                  </td>
                  <td><b>${escapeHtml(l.design_no)}</b></td>
                  <td>${escapeHtml((l.attrs && l.attrs.product) || '')}</td>
                  <td style="font-size: 12px;">${escapeHtml((l.attrs && l.attrs.pattern) || '')} / ${escapeHtml((l.attrs && l.attrs.material) || '')}</td>
                  <td>${escapeHtml(l.colour_names || '')}</td>
                  <td style="font-size: 12px; font-family: monospace;">${sizesStr}</td>
                  <td style="font-weight: 600;">${l.total_qty}</td>
                  <td><span class="badge ${l.qc_pass === 'Y' ? 'open' : 'checked'}">${l.qc_pass === 'Y' ? 'PASS' : 'FAIL'}</span></td>
                  <td style="font-size: 12px; color: var(--mute);">${escapeHtml(l.entered_by)}</td>
                  <td>
                    ${canDelete ? `<button type="button" class="btn small ghost btn-del-line" data-id="${l.line_id}" style="padding: 4px 8px; min-height: 28px;">Delete</button>` : ''}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Attach photos using Photo Fallback Chain
    document.querySelectorAll('.thumb-cell').forEach(function (img) {
      var pid = img.getAttribute('data-photo-id');
      if (pid) API.attachPhoto(img, pid);
    });

    // Delete Line handler
    document.querySelectorAll('.btn-del-line').forEach(function (btn) {
      btn.onclick = async function () {
        var id = btn.getAttribute('data-id');
        if (!confirm('Are you sure you want to delete this line?')) return;
        var r = await API.lineDelete(id);
        if (r && r.ok) {
          toast('Line deleted');
          renderBundleDatasheet(bundleId);
        } else {
          toast((r && r.error) || 'Failed to delete line', true);
        }
      };
    });

    // My lines filter
    var btnAll = document.getElementById('filter-all-lines');
    var btnMine = document.getElementById('filter-my-lines');
    if (btnAll && btnMine) {
      btnAll.onclick = function () {
        btnAll.className = 'btn small';
        btnMine.className = 'btn small ghost';
        document.querySelectorAll('#lines-table tbody tr').forEach(function (r) { r.style.display = ''; });
      };
      btnMine.onclick = function () {
        btnMine.className = 'btn small';
        btnAll.className = 'btn small ghost';
        var myName = user ? user.name : '';
        document.querySelectorAll('#lines-table tbody tr').forEach(function (r) {
          r.style.display = r.getAttribute('data-entered-by') === myName ? '' : 'none';
        });
      };
    }

    // Admin reopen
    var btnReopen = document.getElementById('btn-admin-reopen');
    if (btnReopen) {
      btnReopen.onclick = async function () {
        if (!confirm('Reopen this bundle? This will unlock it for editing and new lines.')) return;
        var r = await API.bundlesReopen(bundleId);
        if (r && r.ok) {
          toast('Bundle reopened');
          renderBundleDatasheet(bundleId);
        } else {
          toast((r && r.error) || 'Reopen failed', true);
        }
      };
    }
  }

  // --- 6. Datasheet Print / PDF View (Task 4) ---
  async function renderPrintView(bundleId) {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="skeleton"></div>';

    var res = await API.bundlesGet({ bundle_id: bundleId, limit: 1000 });
    if (!res || !res.ok) {
      app.innerHTML = '<div class="alert err">Bundle not found</div>';
      return;
    }

    var bundle = res.bundle;
    var lines = res.lines || [];
    var settings = res.settings || {};
    var sheetTitle = settings.sheet_title || 'MPS SILKS - KGF - Inventory Datasheet - (Readymade Product)';

    // Group size keys across all lines to create dynamic size columns
    var allSizesMap = {};
    lines.forEach(function (l) {
      Object.keys(l.sizes || {}).forEach(function (s) { allSizesMap[s] = true; });
    });
    var sizeCols = Object.keys(allSizesMap);
    if (!sizeCols.length) sizeCols = ['S', 'M', 'L', 'XL', 'XXL'];

    // Split into parts of ~100 lines each per requirement
    var PART_SIZE = 100;
    var parts = [];
    if (lines.length === 0) {
      parts.push([]);
    } else {
      for (var i = 0; i < lines.length; i += PART_SIZE) {
        parts.push(lines.slice(i, i + PART_SIZE));
      }
    }

    // Invoice excess / shortage mapping
    var invoiceRows = res.invoiceRows || [];
    var invMap = {};
    invoiceRows.forEach(function (r) { invMap[r.design_id] = r.invoice_qty; });

    app.innerHTML = `
      <div class="no-print" style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
        <a href="#bundle/${bundle.bundle_id}" class="btn ghost small">← Back to Bundle</a>
        <button type="button" class="btn gold small" onclick="window.print()">Print / Save PDF</button>
      </div>

      <div class="datasheet-sheet">
        ${parts.map(function (partLines, partIdx) {
          var partNo = partIdx + 1;
          var totalParts = parts.length;
          var startLineNo = partIdx * PART_SIZE;

          return `
            <div class="datasheet-part">
              <!-- Red Title Band -->
              <div class="datasheet-red-bar">
                ${escapeHtml(sheetTitle)}
              </div>

              <!-- Header with Logos & Meta -->
              <div class="datasheet-header">
                <div>
                  <img src="assets/mps-logo.png" alt="MPS Silks" style="height: 48px; width: auto; object-fit: contain;">
                </div>
                <div class="meta-grid">
                  <div class="meta-item"><b>Supplier:</b> ${escapeHtml(bundle.supplier)}</div>
                  <div class="meta-item"><b>City:</b> ${escapeHtml(bundle.city || 'Godown')}</div>
                  <div class="meta-item"><b>Invoice No:</b> ${escapeHtml(bundle.invoice_no || 'Pending')}</div>
                  <div class="meta-item"><b>Invoice Date:</b> ${escapeHtml(bundle.invoice_date || 'Pending')}</div>
                  <div class="meta-item"><b>Agent:</b> ${escapeHtml(bundle.agent || 'Nil')}</div>
                  <div class="meta-item"><b>Bundle No:</b> ${bundle.bundle_id}</div>
                  <div class="meta-item"><b>Opened By:</b> ${escapeHtml(bundle.opened_by || '')}</div>
                  <div class="meta-item"><b>Part:</b> ${partNo} of ${totalParts}</div>
                </div>
                <div style="text-align: right;">
                  <span style="font-size: 8px; letter-spacing: .2em; text-transform: uppercase; color: #666; display: block;">Prepared by</span>
                  <img src="assets/cb-logo.png" alt="C&B" style="height: 22px; width: auto; display: inline-block;">
                </div>
              </div>

              <!-- Lines Table -->
              <table class="datasheet-table">
                <thead>
                  <tr>
                    <th>S.No</th>
                    <th>Photo</th>
                    <th>Design No</th>
                    <th>Product</th>
                    <th>Pattern</th>
                    <th>Fit</th>
                    <th>Sleeve</th>
                    <th>Material</th>
                    <th>Colour</th>
                    ${sizeCols.map(function (s) { return `<th>${escapeHtml(s)}</th>`; }).join('')}
                    <th>Total</th>
                    <th>QC</th>
                    <th>Diff</th>
                  </tr>
                </thead>
                <tbody>
                  ${partLines.length === 0 ? `<tr><td colspan="${13 + sizeCols.length}">No lines in this part</td></tr>` : ''}
                  ${partLines.map(function (l, idx) {
                    var lineNo = startLineNo + idx + 1;
                    var attrs = l.attrs || {};
                    return `
                      <tr>
                        <td>${lineNo}</td>
                        <td class="photo-cell">
                          <img class="thumb-cell" data-photo-id="${l.photo_id || ''}" alt="">
                        </td>
                        <td><b>${escapeHtml(l.design_no)}</b></td>
                        <td class="left">${escapeHtml(attrs.product || '')}</td>
                        <td>${escapeHtml(attrs.pattern || '')}</td>
                        <td>${escapeHtml(attrs.fit || '')}</td>
                        <td>${escapeHtml(attrs.sleeve || '')}</td>
                        <td>${escapeHtml(attrs.material || '')}</td>
                        <td>${escapeHtml(l.colour_names || '')}</td>
                        ${sizeCols.map(function (s) {
                          var q = (l.sizes && l.sizes[s]) || 0;
                          return `<td>${q > 0 ? q : ''}</td>`;
                        }).join('')}
                        <td style="font-weight: 600;">${l.total_qty}</td>
                        <td>${l.qc_pass === 'Y' ? 'Pass' : 'Fail'}</td>
                        <td style="font-size: 9px;">${invMap[l.design_id] != null ? (l.total_qty - invMap[l.design_id]) : ''}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>

              <!-- Footer with Blank Stickering & GRN signatures -->
              <div class="datasheet-footer">
                <div>
                  Entered By: <b>${escapeHtml(bundle.opened_by || 'Staff')}</b>
                  <div class="sign-line">Opened By Signature</div>
                </div>
                <div>
                  Stickering Person: <b>________________</b>
                  <div class="sign-line">Stickering Signature (Blank)</div>
                </div>
                <div>
                  GRN Person: <b>________________</b>
                  <div class="sign-line">GRN Verified Signature (Blank)</div>
                </div>
                <div>
                  Handover Date: <b>________________</b>
                  <div class="sign-line">Accounting Handover</div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Attach photos
    document.querySelectorAll('.datasheet-table .thumb-cell').forEach(function (img) {
      var pid = img.getAttribute('data-photo-id');
      if (pid) API.attachPhoto(img, pid);
    });
  }

  // --- 7. Purchase Invoice Check View ---
  async function renderInvoiceCheck(bundleId) {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="skeleton"></div>';

    var res = await API.invoiceGet(bundleId);
    if (!res || !res.ok) {
      app.innerHTML = `<div class="alert err">Bundle not found: ${escapeHtml((res && res.error) || '')}</div><a href="#bundles" class="btn">Back</a>`;
      return;
    }

    var bundle = res.bundle;
    var designs = res.designs || [];
    var invRows = res.invoiceRows || [];
    var check = res.check || { rows: [] };
    var isConfirmed = bundle.status !== 'Open';
    var isAdmin = state.user && state.user.role === 'admin';

    // Build row lookup
    var rowsById = {};
    invRows.forEach(function (r) { rowsById[r.design_id] = r.invoice_qty; });

    app.innerHTML = `
      <div style="margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px;">
          <div>
            <p class="eyebrow">Purchase Handover Verification</p>
            <h1>Invoice Check: Bundle ${bundle.bundle_id}</h1>
            <p class="mute" style="font-size: 13px; margin: 0;">
              Supplier: <b>${escapeHtml(bundle.supplier)}</b> (${escapeHtml(bundle.city || '')}) ·
              Status: <span class="badge ${bundle.status === 'Open' ? 'open' : 'checked'}">${bundle.status}</span>
            </p>
          </div>
          <div class="btn-group">
            <a href="#bundle/${bundle.bundle_id}" class="btn small ghost">Datasheet Lines</a>
            ${isAdmin && isConfirmed ? `<button id="btn-reopen-bundle-inv" class="btn small ghost">Reopen Bundle</button>` : ''}
          </div>
        </div>
      </div>

      <form id="form-invoice-check">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; background: var(--wash); padding: 18px; border: 1px solid var(--line);">
          <div class="field" style="margin: 0;">
            <label for="inv-no">Supplier Invoice No *</label>
            <input type="text" id="inv-no" required value="${escapeHtml(bundle.invoice_no || '')}" ${isConfirmed ? 'disabled' : ''} placeholder="e.g. INV-9042">
          </div>
          <div class="field" style="margin: 0;">
            <label for="inv-date">Invoice Date *</label>
            <input type="date" id="inv-date" required value="${bundle.invoice_date || new Date().toISOString().slice(0, 10)}" ${isConfirmed ? 'disabled' : ''}>
          </div>
        </div>

        <!-- Table of Counted vs Invoiced Designs -->
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Design No</th>
                <th style="text-align: right;">Counted Qty</th>
                <th style="text-align: right; width: 140px;">Invoice Qty</th>
                <th style="text-align: center;">Excess / Shortage</th>
              </tr>
            </thead>
            <tbody>
              ${designs.length === 0 ? '<tr><td colspan="4" class="mute">No lines in this bundle.</td></tr>' : ''}
              ${designs.map(function (d) {
                var invVal = rowsById[d.design_id];
                var hasVal = invVal != null && invVal !== '';
                var diff = hasVal ? (Number(d.counted) - Number(invVal)) : null;
                var badgeClass = 'match';
                var diffText = 'Pending';

                if (hasVal) {
                  if (diff > 0) {
                    badgeClass = 'excess';
                    diffText = '+' + diff + ' Excess';
                  } else if (diff < 0) {
                    badgeClass = 'shortage';
                    diffText = diff + ' Shortage';
                  } else {
                    badgeClass = 'match';
                    diffText = '0 Matched';
                  }
                }

                return `
                  <tr data-design-id="${d.design_id}" data-design-no="${escapeHtml(d.design_no)}" data-counted="${d.counted}">
                    <td><b>${escapeHtml(d.design_no)}</b></td>
                    <td style="text-align: right; font-weight: 600;">${d.counted}</td>
                    <td style="text-align: right;">
                      <input type="number" min="0" class="input-inv-qty" value="${hasVal ? invVal : ''}" ${isConfirmed ? 'disabled' : ''} style="text-align: right; min-height: 38px; padding: 6px;">
                    </td>
                    <td style="text-align: center;">
                      <span class="badge ${badgeClass} status-diff-badge">${diffText}</span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>

        <!-- Summary Totals -->
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; padding: 18px; border: 1px solid var(--line); margin-bottom: 24px;">
          <div>
            Total Counted: <b id="inv-total-counted">${check.totalCounted || 0}</b> ·
            Total Invoice: <b id="inv-total-invoiced">${check.totalInvoice || 0}</b> ·
            Net Difference: <b id="inv-total-diff">${check.diff || 0}</b>
          </div>
          <div id="inv-complete-status" class="mute" style="font-size: 13px;">
            ${check.complete ? '<span style="color:var(--ok)">✓ All design quantities entered</span>' : check.pending + ' design(s) missing invoice quantity'}
          </div>
        </div>

        ${!isConfirmed ? `
          <div class="btn-group">
            <button type="button" id="btn-save-inv" class="btn">Save Progress</button>
            <button type="button" id="btn-confirm-inv" class="btn gold">Confirm & Lock Bundle</button>
          </div>
        ` : '<div class="alert ok">This bundle is confirmed against the invoice and locked.</div>'}
      </form>
    `;

    // Live calculation of excess / shortage
    function recalculateDiffs() {
      var rows = document.querySelectorAll('tbody tr[data-design-id]');
      var totCounted = 0;
      var totInvoice = 0;
      var pendingCount = 0;

      rows.forEach(function (r) {
        var counted = Number(r.getAttribute('data-counted')) || 0;
        var inp = r.querySelector('.input-inv-qty');
        var badge = r.querySelector('.status-diff-badge');
        var val = inp.value.trim();

        totCounted += counted;
        if (val === '') {
          pendingCount++;
          badge.className = 'badge match status-diff-badge';
          badge.textContent = 'Pending';
        } else {
          var num = Number(val) || 0;
          totInvoice += num;
          var diff = counted - num;
          if (diff > 0) {
            badge.className = 'badge excess status-diff-badge';
            badge.textContent = '+' + diff + ' Excess';
          } else if (diff < 0) {
            badge.className = 'badge shortage status-diff-badge';
            badge.textContent = diff + ' Shortage';
          } else {
            badge.className = 'badge match status-diff-badge';
            badge.textContent = '0 Matched';
          }
        }
      });

      document.getElementById('inv-total-counted').textContent = totCounted;
      document.getElementById('inv-total-invoiced').textContent = totInvoice;
      document.getElementById('inv-total-diff').textContent = (totCounted - totInvoice);

      var statusEl = document.getElementById('inv-complete-status');
      if (statusEl) {
        statusEl.innerHTML = pendingCount === 0
          ? '<span style="color:var(--ok)">✓ All design quantities entered</span>'
          : pendingCount + ' design(s) missing invoice quantity';
      }
    }

    document.querySelectorAll('.input-inv-qty').forEach(function (inp) {
      inp.oninput = recalculateDiffs;
    });

    // Save Invoice Progress
    var btnSave = document.getElementById('btn-save-inv');
    if (btnSave) {
      btnSave.onclick = async function () {
        var invNo = document.getElementById('inv-no').value.trim();
        var invDate = document.getElementById('inv-date').value;
        var rows = [];

        document.querySelectorAll('tbody tr[data-design-id]').forEach(function (r) {
          var dId = r.getAttribute('data-design-id');
          var dNo = r.getAttribute('data-design-no');
          var val = r.querySelector('.input-inv-qty').value.trim();
          if (val !== '') {
            rows.push({ designId: dId, designNo: dNo, invoiceQty: Number(val) });
          }
        });

        btnSave.disabled = true;
        btnSave.textContent = 'Saving...';
        var r = await API.invoiceSave({
          bundle_id: bundle.bundle_id,
          invoiceNo: invNo,
          invoiceDate: invDate,
          rows: rows
        });
        btnSave.disabled = false;
        btnSave.textContent = 'Save Progress';

        if (r && r.ok) {
          toast('Invoice progress saved.');
        } else {
          toast((r && r.error) || 'Save failed', true);
        }
      };
    }

    // Confirm & Lock Bundle
    var btnConfirm = document.getElementById('btn-confirm-inv');
    if (btnConfirm) {
      btnConfirm.onclick = async function () {
        var invNo = document.getElementById('inv-no').value.trim();
        var invDate = document.getElementById('inv-date').value;

        if (!invNo) {
          toast('Please enter the invoice number.', true);
          return;
        }
        if (!invDate) {
          toast('Please choose the invoice date.', true);
          return;
        }

        // Save rows first
        var rows = [];
        var hasBlank = false;
        document.querySelectorAll('tbody tr[data-design-id]').forEach(function (r) {
          var dId = r.getAttribute('data-design-id');
          var dNo = r.getAttribute('data-design-no');
          var val = r.querySelector('.input-inv-qty').value.trim();
          if (val === '') {
            hasBlank = true;
          } else {
            rows.push({ designId: dId, designNo: dNo, invoiceQty: Number(val) });
          }
        });

        if (hasBlank) {
          toast('All designs must have invoice quantities entered before confirming.', true);
          return;
        }

        btnConfirm.disabled = true;
        btnConfirm.textContent = 'Confirming...';

        await API.invoiceSave({
          bundle_id: bundle.bundle_id,
          invoiceNo: invNo,
          invoiceDate: invDate,
          rows: rows
        });

        var r = await API.invoiceConfirm(bundle.bundle_id);
        btnConfirm.disabled = false;

        if (r && r.ok) {
          toast('Bundle confirmed and locked!');
          renderInvoiceCheck(bundle.bundle_id);
        } else {
          toast((r && r.error) || 'Confirmation failed', true);
        }
      };
    }

    // Admin Reopen from Invoice View
    var btnReopenInv = document.getElementById('btn-reopen-bundle-inv');
    if (btnReopenInv) {
      btnReopenInv.onclick = async function () {
        if (!confirm('Reopen this bundle? This will unlock it.')) return;
        var r = await API.bundlesReopen(bundle.bundle_id);
        if (r && r.ok) {
          toast('Bundle reopened');
          renderInvoiceCheck(bundle.bundle_id);
        } else {
          toast((r && r.error) || 'Reopen failed', true);
        }
      };
    }
  }

  // --- 8. Admin Masters & Users View (Task 7 scale note included) ---
  async function renderAdmin() {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="skeleton"></div>';

    var m = await loadMasters(true);
    var uRes = await API.usersList();
    var users = (uRes && uRes.ok && uRes.users) || [];

    var suppliers = (m && m.suppliers) || [];
    var brands = (m && m.brands) || [];
    var products = (m && m.products) || [];
    var sizeSets = (m && m.sizeSets) || [];
    var lists = (m && m.lists) || {};
    var settings = (m && m.settings) || {};

    // Estimate spreadsheet cell usage (Task 7)
    // 10M cells limit in Google Sheets
    var bundlesRes = await API.bundlesList();
    var totalBundles = (bundlesRes && bundlesRes.bundles && bundlesRes.bundles.length) || 0;
    var totalLines = (bundlesRes && bundlesRes.bundles) ? bundlesRes.bundles.reduce(function (a, b) { return a + (b.lines || 0); }, 0) : 0;
    var estimatedCells = (totalLines * 36) + (totalBundles * 30) + 5000;
    var MAX_CELLS = 10000000;
    var percentUsed = Math.min(100, Math.round((estimatedCells / MAX_CELLS) * 10000) / 100);

    app.innerHTML = `
      <div>
        <p class="eyebrow">Administration & Configuration</p>
        <h1>Masters & Settings</h1>
        <p class="lede">Manage suppliers, users, products, colour lists, and spreadsheet capacity.</p>

        <!-- Admin Tabs -->
        <div class="nav" id="admin-subtabs" style="justify-content: flex-start; margin-bottom: 28px; border-bottom: 1px solid var(--line);">
          <a href="javascript:void(0)" class="on" data-tab="suppliers">Suppliers</a>
          <a href="javascript:void(0)" data-tab="users">Staff Users</a>
          <a href="javascript:void(0)" data-tab="products">Products</a>
          <a href="javascript:void(0)" data-tab="brands">Brands</a>
          <a href="javascript:void(0)" data-tab="lists">Attribute Lists</a>
          <a href="javascript:void(0)" data-tab="sizes">Size Sets</a>
          <a href="javascript:void(0)" data-tab="settings">System Settings</a>
        </div>

        <div id="tab-content"></div>
      </div>
    `;

    var tabContent = document.getElementById('tab-content');

    function showTab(name) {
      document.querySelectorAll('#admin-subtabs a').forEach(function (a) {
        a.className = a.getAttribute('data-tab') === name ? 'on' : '';
      });

      if (name === 'suppliers') {
        tabContent.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h3>Suppliers (${suppliers.length})</h3>
            <button id="btn-add-sup" class="btn small gold">+ Add Supplier</button>
          </div>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>City</th>
                  <th>Default Agent</th>
                  <th>Default Brand</th>
                  <th>Photo Required</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                ${suppliers.map(function (s) {
                  return `
                    <tr>
                      <td><b>${escapeHtml(s.name)}</b></td>
                      <td>${escapeHtml(s.city || '')}</td>
                      <td>${escapeHtml(s.agent || 'Nil')}</td>
                      <td>${escapeHtml(s.brand || '')}</td>
                      <td><span class="badge ${s.photo_required === 'Y' ? 'open' : 'checked'}">${s.photo_required === 'Y' ? 'YES' : 'NO'}</span></td>
                      <td>${s.active === 'Y' ? 'Active' : 'Inactive'}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `;

        document.getElementById('btn-add-sup').onclick = function () {
          var name = prompt('Supplier Name:');
          if (!name) return;
          var city = prompt('City:') || '';
          var agent = prompt('Default Agent (or Nil):') || 'Nil';
          var brand = prompt('Default Brand:') || name;
          var photoReq = confirm('Require photo for this supplier?');

          API.mastersSave('supplier', {
            name: name,
            city: city,
            agent: agent,
            brand: brand,
            photo_required: photoReq ? 'Y' : 'N'
          }).then(function (r) {
            if (r.ok) { toast('Supplier created'); renderAdmin(); }
            else toast(r.error, true);
          });
        };
      } else if (name === 'users') {
        tabContent.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h3>Staff Logins (${users.length})</h3>
            <button id="btn-add-user" class="btn small gold">+ Add Staff User</button>
          </div>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Active</th>
                  <th>Last Login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${users.map(function (u) {
                  return `
                    <tr>
                      <td><b>${escapeHtml(u.name)}</b></td>
                      <td><span class="badge open">${u.role}</span></td>
                      <td>${u.active === 'Y' ? 'Active' : 'Deactivated'}</td>
                      <td style="font-size: 11px; color: var(--mute);">${u.last_login ? u.last_login.slice(0, 16).replace('T', ' ') : 'Never'}</td>
                      <td>
                        <button class="btn small ghost btn-reset-pin" data-id="${u.user_id}" data-name="${escapeHtml(u.name)}" data-role="${u.role}" style="padding: 4px 8px; min-height: 28px;">Reset PIN</button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `;

        document.getElementById('btn-add-user').onclick = function () {
          var name = prompt('Staff Name (2-40 chars):');
          if (!name) return;
          var role = prompt('Role (admin, entry, or purchase):', 'entry');
          if (!role) return;
          var pin = prompt('New PIN (4-8 digits):');
          if (!pin) return;

          API.usersSave({ name: name, role: role, pin: pin }).then(function (r) {
            if (r.ok) { toast('User created'); renderAdmin(); }
            else toast(r.error, true);
          });
        };

        document.querySelectorAll('.btn-reset-pin').forEach(function (btn) {
          btn.onclick = function () {
            var uId = btn.getAttribute('data-id');
            var uName = btn.getAttribute('data-name');
            var uRole = btn.getAttribute('data-role');
            var newPin = prompt('Enter new 4-8 digit PIN for ' + uName + ':');
            if (!newPin) return;

            API.usersSave({ user_id: uId, name: uName, role: uRole, pin: newPin }).then(function (r) {
              if (r.ok) toast('PIN updated successfully for ' + uName);
              else toast(r.error, true);
            });
          };
        });
      } else if (name === 'products') {
        tabContent.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h3>Products</h3>
            <button id="btn-add-prod" class="btn small gold">+ Add Product</button>
          </div>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Product Name</th>
                  <th>Linked Size Set</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                ${products.map(function (p) {
                  var sName = (sizeSets.find(function (s) { return s.set_id === p.size_set; }) || {}).name || p.size_set;
                  return `<tr><td><b>${escapeHtml(p.name)}</b></td><td>${escapeHtml(sName)}</td><td>${p.active}</td></tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        `;

        document.getElementById('btn-add-prod').onclick = function () {
          var name = prompt('Product Name (e.g. Saree, Shirt):');
          if (!name) return;
          var set = sizeSets[0] ? sizeSets[0].set_id : 'SZ001';
          API.mastersSave('product', { name: name, size_set: set }).then(function (r) {
            if (r.ok) { toast('Product created'); renderAdmin(); }
            else toast(r.error, true);
          });
        };
      } else if (name === 'settings') {
        tabContent.innerHTML = `
          <div class="narrow" style="max-width: 600px;">
            <h3>General Settings</h3>
            <form id="form-settings" style="margin-bottom: 36px;">
              <div class="field">
                <label for="set-title">Datasheet Title (Red Band)</label>
                <input type="text" id="set-title" value="${escapeHtml(settings.sheet_title || 'MPS SILKS - KGF - Inventory Datasheet - (Readymade Product)')}">
              </div>
              <div class="field">
                <label for="set-photo-mode">Photo Enforcement</label>
                <select id="set-photo-mode">
                  <option value="all" ${settings.photo_mode === 'all' ? 'selected' : ''}>Require photo for ALL suppliers</option>
                  <option value="selected" ${settings.photo_mode === 'selected' ? 'selected' : ''}>Require photo only for SELECTED suppliers</option>
                </select>
              </div>
              <div class="field">
                <label for="set-inactive-days">Inactive Days (for Catalogue Status)</label>
                <input type="number" id="set-inactive-days" value="${settings.inactive_days || 90}">
              </div>
              <button type="submit" class="btn gold small">Save Settings</button>
            </form>

            <!-- Task 7 Scale Warning & Archive Proposal -->
            <div class="capacity-card">
              <p class="eyebrow" style="color: var(--warn);">System Capacity & Spreadsheet Health</p>
              <h3 style="margin-bottom: 6px;">Google Sheets Cell Utilization</h3>
              <p class="mute" style="font-size: 13px; margin: 0 0 14px;">
                One Google Sheet holds a maximum of <b>10,000,000 cells</b> (approx 277 bundles of 2,000 lines).
              </p>
              <div class="meter-bar">
                <div class="meter-fill" style="width: ${Math.max(1, percentUsed)}%;"></div>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 16px;">
                <span>Est. Cells Used: <b>${estimatedCells.toLocaleString()}</b></span>
                <span>Max Capacity: <b>10,000,000</b> (${percentUsed}%)</span>
              </div>
              <div class="alert info" style="margin-bottom: 0;">
                <b>Archiving Strategy Proposal (Awaiting Client Decision):</b><br>
                To avoid reaching the 10M cell limit, we propose an annual rollover strategy where closed bundles from prior quarters/years are archived into a secondary workbook. Archiving is currently dormant pending MPS management confirmation.
              </div>
            </div>
          </div>
        `;

        document.getElementById('form-settings').onsubmit = async function (e) {
          e.preventDefault();
          var title = document.getElementById('set-title').value.trim();
          var mode = document.getElementById('set-photo-mode').value;
          var days = document.getElementById('set-inactive-days').value;

          var r = await API.mastersSave('settings', {
            sheet_title: title,
            photo_mode: mode,
            inactive_days: days
          });

          if (r && r.ok) {
            toast('Settings saved');
            renderAdmin();
          } else {
            toast((r && r.error) || 'Save failed', true);
          }
        };
      } else {
        tabContent.innerHTML = `<p class="mute">Tab content for ${escapeHtml(name)}</p>`;
      }
    }

    document.querySelectorAll('#admin-subtabs a').forEach(function (a) {
      a.onclick = function () { showTab(a.getAttribute('data-tab')); };
    });

    showTab('suppliers');
  }

  // --- 9. Catalogue & Design Finder Views ---
  async function renderCatalogue() {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="skeleton"></div>';

    var res = await API.reportsGet();
    var designs = (res && res.ok && res.designs) || [];

    app.innerHTML = `
      <div style="margin-bottom: 28px;">
        <p class="eyebrow">Visual Index</p>
        <h1>Design Catalogue</h1>
        <p class="lede">Browse all registered designs and motif signatures across suppliers.</p>
      </div>

      <div class="field-inline" style="max-width: 420px; margin-bottom: 24px;">
        <input type="text" id="cat-search" placeholder="Search design number, supplier, or product...">
      </div>

      <div class="grid" id="cat-grid">
        ${designs.length === 0 ? '<div class="empty" style="grid-column: 1/-1;"><p>No designs registered yet.</p></div>' : ''}
        ${designs.map(function (d) {
          return `
            <div class="card" data-card>
              <div class="ph">
                <img class="cat-img" data-photo-id="${d.photo_id || ''}" alt="">
              </div>
              <div class="meta">
                <div>
                  <span class="num"><b>${escapeHtml(d.design_no)}</b></span>
                  <div class="mute" style="font-size: 11px;">${escapeHtml(d.supplier || '')}</div>
                </div>
                <div style="text-align: right; font-size: 11px;">
                  <span>${escapeHtml((d.attrs && d.attrs.product) || '')}</span>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    document.querySelectorAll('.cat-img').forEach(function (img) {
      var pid = img.getAttribute('data-photo-id');
      if (pid) API.attachPhoto(img, pid);
    });

    var catSearch = document.getElementById('cat-search');
    if (catSearch) {
      catSearch.oninput = function () {
        var q = catSearch.value.toLowerCase();
        document.querySelectorAll('#cat-grid [data-card]').forEach(function (el) {
          el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      };
    }
  }

  // --- 10. Status View ---
  async function renderStatus() {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="skeleton"></div>';

    var res = await API.reportsGet();
    var designs = (res && res.ok && res.designs) || [];
    var sightings = (res && res.ok && res.sightings) || [];
    var settings = (res && res.ok && res.settings) || {};
    var inactiveDays = Number(settings.inactive_days) || 90;

    var statuses = C.designStatuses(designs, sightings, res.serverTime || new Date().toISOString(), { inactiveDays: inactiveDays });
    var activeCount = statuses.filter(function (s) { return s.status === 'Active'; }).length;
    var inactiveCount = statuses.length - activeCount;

    app.innerHTML = `
      <div style="margin-bottom: 28px;">
        <p class="eyebrow">Lifecycle & Activity</p>
        <h1>Design Status</h1>
        <p class="lede">Track which designs are moving and which have become inactive (&gt; ${inactiveDays} days).</p>
      </div>

      <div class="kpis">
        <div class="kpi">
          <span class="eyebrow">Total Designs</span>
          <b>${statuses.length}</b>
        </div>
        <div class="kpi">
          <span class="eyebrow">Active (&lt; ${inactiveDays}d)</span>
          <b style="color: var(--ok);">${activeCount}</b>
        </div>
        <div class="kpi">
          <span class="eyebrow">Inactive (&gt; ${inactiveDays}d)</span>
          <b style="color: var(--bad);">${inactiveCount}</b>
        </div>
      </div>

      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Design No</th>
              <th>Supplier</th>
              <th>Sightings</th>
              <th>Days Since Activity</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${statuses.map(function (s) {
              return `
                <tr>
                  <td><b>${escapeHtml(s.design_no)}</b></td>
                  <td>${escapeHtml(s.supplier || '')}</td>
                  <td>${s.sightings || 0}</td>
                  <td>${s.daysSinceActivity} days</td>
                  <td><span class="tag ${s.status === 'Active' ? 'active' : 'inactive'}">${s.status}</span></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // --- 11. Monthly Report View ---
  async function renderReport() {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="skeleton"></div>';

    var res = await API.reportsGet();
    var designs = (res && res.ok && res.designs) || [];
    var sightings = (res && res.ok && res.sightings) || [];

    var now = new Date();
    var curYear = now.getFullYear();
    var curMonth = now.getMonth() + 1;

    function renderMonthReport(year, month) {
      var r = C.monthlyReport(designs, sightings, year, month);
      var monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

      var rContainer = document.getElementById('report-paper');
      if (!rContainer) return;

      rContainer.innerHTML = `
        <div class="paper" id="paper">
          <div class="rhead">
            <div>
              <p class="eyebrow">Monthly Review</p>
              <h2>${monthNames[month]} ${year}</h2>
            </div>
            <div style="text-align: right;">
              <span class="wordmark small">MPS SILKS</span>
            </div>
          </div>

          <div class="kpis">
            <div class="kpi">
              <span class="eyebrow">Total In Scope</span>
              <b>${r.totals.designs}</b>
            </div>
            <div class="kpi">
              <span class="eyebrow">New This Month</span>
              <b>${r.totals.newThisMonth}</b>
            </div>
            <div class="kpi">
              <span class="eyebrow">Repeat Sightings</span>
              <b>${r.totals.repeatSightings}</b>
            </div>
            <div class="kpi">
              <span class="eyebrow">Inactive at Month End</span>
              <b style="color: var(--bad);">${r.totals.inactive}</b>
            </div>
          </div>

          <h3>Supplier Activity</h3>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th style="text-align: right;">Active</th>
                  <th style="text-align: right;">Inactive</th>
                  <th style="text-align: right;">New</th>
                  <th style="text-align: right;">Total</th>
                </tr>
              </thead>
              <tbody>
                ${r.suppliers.map(function (s) {
                  return `
                    <tr>
                      <td><b>${escapeHtml(s.supplier)}</b></td>
                      <td style="text-align: right;">${s.active}</td>
                      <td style="text-align: right;">${s.inactive}</td>
                      <td style="text-align: right;">${s.newCount}</td>
                      <td style="text-align: right; font-weight: 600;">${s.total}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    app.innerHTML = `
      <div style="margin-bottom: 28px;">
        <p class="eyebrow">Audit & Handover</p>
        <h1>Monthly Inventory Report</h1>
        <p class="lede">Summarize designs registered, active counts, and supplier throughput.</p>
      </div>

      <div class="field-inline" style="max-width: 320px; margin-bottom: 24px;">
        <label for="rep-month" style="margin: 0; margin-right: 8px;">Month:</label>
        <input type="month" id="rep-month" value="${curYear}-${String(curMonth).padStart(2, '0')}">
      </div>

      <div id="report-paper"></div>
    `;

    renderMonthReport(curYear, curMonth);

    var repMonth = document.getElementById('rep-month');
    if (repMonth) {
      repMonth.onchange = function () {
        var parts = repMonth.value.split('-');
        if (parts.length === 2) {
          renderMonthReport(parseInt(parts[0], 10), parseInt(parts[1], 10));
        }
      };
    }
  }

  // --- HTML escaping helper ---
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ==========================================================================
  // ROUTING & LIFECYCLE
  // ==========================================================================

  async function route() {
    var hash = window.location.hash || '#bundles';

    // Highlight nav link
    document.querySelectorAll('.nav a').forEach(function (a) {
      a.classList.remove('on');
    });

    if (!state.user) {
      renderLogin();
      return;
    }

    if (hash === '#login') {
      window.location.hash = '#bundles';
      return;
    }

    if (hash === '#bundles') {
      var navEl = document.getElementById('nav-bundles');
      if (navEl) navEl.classList.add('on');
      await renderBundles();
    } else if (hash === '#bundle-new') {
      var navEl = document.getElementById('nav-bundle-new');
      if (navEl) navEl.classList.add('on');
      await renderNewBundle();
    } else if (hash.startsWith('#bundle/') && hash.endsWith('/entry')) {
      var bId = hash.split('/')[1];
      await renderLineEntry(bId);
    } else if (hash.startsWith('#bundle/') && hash.endsWith('/print')) {
      var bId = hash.split('/')[1];
      await renderPrintView(bId);
    } else if (hash.startsWith('#bundle/')) {
      var bId = hash.split('/')[1];
      await renderBundleDatasheet(bId);
    } else if (hash.startsWith('#invoice/')) {
      var bId = hash.split('/')[1];
      await renderInvoiceCheck(bId);
    } else if (hash === '#catalogue') {
      var navEl = document.getElementById('nav-catalogue');
      if (navEl) navEl.classList.add('on');
      await renderCatalogue();
    } else if (hash === '#status') {
      var navEl = document.getElementById('nav-status');
      if (navEl) navEl.classList.add('on');
      await renderStatus();
    } else if (hash === '#report') {
      var navEl = document.getElementById('nav-report');
      if (navEl) navEl.classList.add('on');
      await renderReport();
    } else if (hash === '#admin') {
      var navEl = document.getElementById('nav-admin');
      if (navEl) navEl.classList.add('on');
      await renderAdmin();
    } else if (hash === '#finder') {
      window.location.hash = '#catalogue';
    } else {
      window.location.hash = '#bundles';
    }
  }

  // --- Initial Setup ---
  window.addEventListener('DOMContentLoaded', async function () {
    updateNav();
    await refreshOutbox();

    // Online / Offline listeners
    window.addEventListener('online', function () {
      toast('Reconnected online');
      updateSyncBadge();
      syncOutbox();
    });
    window.addEventListener('offline', function () {
      toast('Operating offline');
      updateSyncBadge();
    });

    // Auth required listener from api.js
    window.addEventListener('mps:auth-required', function () {
      state.user = null;
      state.token = null;
      updateNav();
      toast('Session expired. Please sign in.', true);
      renderLogin();
    });

    // Logout button
    var btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
      btnLogout.onclick = async function () {
        await API.logout();
        state.user = null;
        state.token = null;
        updateNav();
        renderLogin();
        toast('Signed out');
      };
    }

    // Sync button / modal
    var btnSync = document.getElementById('btn-sync');
    var outboxModal = document.getElementById('outbox-modal');
    var btnCloseOutbox = document.getElementById('btn-close-outbox');
    var btnSyncNow = document.getElementById('btn-sync-now');

    if (btnSync && outboxModal) {
      btnSync.onclick = function () {
        var list = document.getElementById('outbox-list');
        if (list) {
          list.innerHTML = state.outbox.length === 0
            ? '<p class="mute">No items in outbox.</p>'
            : state.outbox.map(function (item) {
                return `
                  <div style="border: 1px solid var(--line); padding: 10px; margin-bottom: 8px;">
                    <div style="display: flex; justify-content: space-between; font-size: 11px;">
                      <b>${item.type}</b>
                      <span class="badge ${item.status === 'failed' ? 'shortage' : 'open'}">${item.status}</span>
                    </div>
                    <div style="font-size: 11px; color: var(--mute); margin-top: 4px;">ID: ${item.id}</div>
                    ${item.error ? `<div style="color: var(--bad); font-size: 11px; margin-top: 4px;">Error: ${escapeHtml(item.error)}</div>` : ''}
                  </div>
                `;
              }).join('');
        }
        outboxModal.showModal();
      };
    }
    if (btnCloseOutbox && outboxModal) {
      btnCloseOutbox.onclick = function () { outboxModal.close(); };
    }
    if (btnSyncNow) {
      btnSyncNow.onclick = async function () {
        await syncOutbox();
        btnSync.click();
      };
    }

    window.addEventListener('hashchange', route);

    // Initial route
    await route();
  });
})();
