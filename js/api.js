/*
 * MPS Silks Inventory Datasheet - Frontend API Client (v3).
 *
 * Implements the v3 API contract:
 * - Content-Type: text/plain (avoids CORS preflight)
 * - Session token management in sessionStorage
 * - Unique requestId generation for idempotent actions
 * - Error mapping & auth lifecycle handling
 * - Photo fallback chain (lh3 -> Drive thumbnail -> photos.get base64) with caching
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MPSApi = factory();
})(this, function () {
  'use strict';

  var KEY_TOKEN = 'mps_auth_token_v3';
  var KEY_USER = 'mps_auth_user_v3';
  var photoCache = new Map();

  function getApiUrl() {
    var cfg = (typeof window !== 'undefined' && window.MPS_CONFIG) || {};
    var url = cfg.API_URL || '';
    if (!url && typeof window !== 'undefined' && window.location) {
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        url = '/api';
      }
    }
    return url;
  }

  function getToken() {
    try {
      return sessionStorage.getItem(KEY_TOKEN) || '';
    } catch (e) {
      return '';
    }
  }

  function getUser() {
    try {
      var raw = sessionStorage.getItem(KEY_USER);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setAuth(token, user) {
    try {
      if (token) sessionStorage.setItem(KEY_TOKEN, token);
      else sessionStorage.removeItem(KEY_TOKEN);
      if (user) sessionStorage.setItem(KEY_USER, JSON.stringify(user));
      else sessionStorage.removeItem(KEY_USER);
    } catch (e) {}
  }

  function clearAuth() {
    try {
      sessionStorage.removeItem(KEY_TOKEN);
      sessionStorage.removeItem(KEY_USER);
    } catch (e) {}
  }

  function genRequestId(prefix) {
    prefix = prefix || 'req';
    var rnd = Math.random().toString(36).substring(2, 9);
    var ts = Date.now().toString(36);
    return prefix + '_' + ts + '_' + rnd;
  }

  async function request(action, payload, customUrl) {
    payload = payload || {};
    var url = customUrl || getApiUrl();
    if (!url) {
      return {
        ok: false,
        code: 'CONFIG_MISSING',
        error: 'API URL is not configured. Please set API_URL in js/config.js.',
        errors: ['API URL is not configured.']
      };
    }

    var body = Object.assign({ action: action }, payload);
    var token = getToken();
    if (token && !body.token) {
      body.token = token;
    }

    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow'
      });

      if (!res.ok) {
        return {
          ok: false,
          code: 'HTTP_' + res.status,
          error: 'Server returned HTTP ' + res.status,
          errors: ['Server returned HTTP ' + res.status]
        };
      }

      var data = await res.json();
      if (!data.ok) {
        if (data.code === 'AUTH') {
          clearAuth();
          if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('mps:auth-required', { detail: data }));
          }
        }
        data.error = data.error || (data.errors && data.errors.join(', ')) || 'Request failed';
      }
      return data;
    } catch (err) {
      return {
        ok: false,
        code: 'NETWORK_ERROR',
        error: 'Connection error: ' + (err.message || 'Check your network'),
        errors: [err.message || 'Connection error']
      };
    }
  }

  // --- Photo Fallback Chain ---
  // Chain:
  // 1. In local dev mode -> /photo/:id
  // 2. lh3 URL: https://lh3.googleusercontent.com/d/:id=w400 (with referrerpolicy="no-referrer")
  // 3. Drive thumbnail: https://drive.google.com/thumbnail?id=:id&sz=w400
  // 4. Backend photos.get base64 fallback (cached in memory)
  async function resolvePhotoUrl(photoId) {
    if (!photoId) return '';
    if (photoId.startsWith('data:image/')) return photoId;
    if (photoCache.has(photoId)) return photoCache.get(photoId);

    // If running against local dev server, /photo/:id is instant
    var isLocal = typeof window !== 'undefined' && window.location &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    if (isLocal) {
      var localUrl = '/photo/' + encodeURIComponent(photoId);
      photoCache.set(photoId, localUrl);
      return localUrl;
    }

    // Default to lh3 URL
    var lh3Url = 'https://lh3.googleusercontent.com/d/' + encodeURIComponent(photoId) + '=w400';
    return lh3Url;
  }

  function attachPhoto(imgEl, photoId, placeholder) {
    if (!imgEl) return;
    imgEl.referrerPolicy = 'no-referrer';
    imgEl.crossOrigin = 'anonymous';

    if (!photoId) {
      imgEl.src = placeholder || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="%23aaa" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
      return;
    }

    if (photoId.startsWith('data:image/')) {
      imgEl.src = photoId;
      return;
    }

    if (photoCache.has(photoId)) {
      imgEl.src = photoCache.get(photoId);
      return;
    }

    var isLocal = typeof window !== 'undefined' && window.location &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

    var step = 0;
    var candidates = isLocal
      ? ['/photo/' + encodeURIComponent(photoId)]
      : [
          'https://lh3.googleusercontent.com/d/' + encodeURIComponent(photoId) + '=w400',
          'https://drive.google.com/thumbnail?id=' + encodeURIComponent(photoId) + '&sz=w400'
        ];

    function tryNext() {
      if (step < candidates.length) {
        var url = candidates[step++];
        imgEl.src = url;
      } else {
        // Fallback to photos.get API
        request('photos.get', { ids: [photoId] }).then(function (res) {
          if (res && res.ok && res.photos && res.photos[photoId]) {
            var dataUrl = res.photos[photoId];
            photoCache.set(photoId, dataUrl);
            imgEl.src = dataUrl;
          } else {
            imgEl.src = placeholder || '';
          }
        }).catch(function () {
          imgEl.src = placeholder || '';
        });
      }
    }

    imgEl.onerror = function () {
      tryNext();
    };
    imgEl.onload = function () {
      if (imgEl.src && !imgEl.src.startsWith('data:image/svg')) {
        photoCache.set(photoId, imgEl.src);
      }
    };

    tryNext();
  }

  // --- API Action Wrappers ---
  return {
    getToken: getToken,
    getUser: getUser,
    setAuth: setAuth,
    clearAuth: clearAuth,
    genRequestId: genRequestId,
    request: request,
    resolvePhotoUrl: resolvePhotoUrl,
    attachPhoto: attachPhoto,

    // Auth & Identity
    ping: function () { return request('ping'); },
    login: async function (name, pin) {
      var r = await request('login', { name: name, pin: pin });
      if (r.ok && r.token) {
        setAuth(r.token, r.user);
      }
      return r;
    },
    logout: async function () {
      var r = await request('logout');
      clearAuth();
      return r;
    },
    me: function () { return request('me'); },

    // Masters & Users (Admin)
    mastersGet: function (all) { return request('masters.get', { all: all === true }); },
    mastersSave: function (kind, item) { return request('masters.save', { kind: kind, item: item }); },
    usersList: function () { return request('users.list'); },
    usersSave: function (item) { return request('users.save', item); },

    // Designs & Matching
    designsList: function (supplier_id) { return request('designs.list', { supplier_id: supplier_id }); },
    designsSignatures: function (supplier_id) { return request('designs.signatures', { supplier_id: supplier_id }); },
    designsVerify: function (payload) { return request('designs.verify', payload); },
    designsSuggest: function (payload) { return request('designs.suggest', payload); },
    designsUpdate: function (payload) { return request('designs.update', payload); },
    register: function (payload) { return request('register', payload); },

    // Bundles
    bundlesList: function (status) { return request('bundles.list', { status: status }); },
    bundlesCreate: function (payload) {
      if (!payload.requestId) payload.requestId = genRequestId('bnd');
      return request('bundles.create', payload);
    },
    bundlesGet: function (params) { return request('bundles.get', params); },
    bundlesUpdate: function (payload) { return request('bundles.update', payload); },
    bundlesReopen: function (bundle_id) { return request('bundles.reopen', { bundle_id: bundle_id }); },

    // Datasheet Lines
    lineSave: function (payload) {
      if (!payload.lineId && !payload.requestId) payload.requestId = genRequestId('line');
      return request('line.save', payload);
    },
    lineDelete: function (lineId) { return request('line.delete', { lineId: lineId }); },

    // Purchase Invoice Check
    invoiceGet: function (bundle_id) { return request('invoice.get', { bundle_id: bundle_id }); },
    invoiceSave: function (payload) { return request('invoice.save', payload); },
    invoiceConfirm: function (bundle_id) { return request('invoice.confirm', { bundle_id: bundle_id }); },

    // Photos & Reports
    photosGet: function (ids) { return request('photos.get', { ids: ids }); },
    reportsGet: function () { return request('reports.get'); }
  };
});
