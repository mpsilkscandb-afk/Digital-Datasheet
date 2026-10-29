// MPS Silks Inventory Datasheet - Configuration.
// Set API_URL to your deployed Google Apps Script Web App URL (ends with /exec).
// When blank, on localhost / 127.0.0.1 it connects to the local dev-server /api.
window.MPS_CONFIG = {
  API_URL: (function () {
    if (typeof window !== 'undefined' && window.location) {
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return '/api';
      }
    }
    return 'https://script.google.com/macros/s/AKfycbw99_sRA78UldJ5CEvNsN0ar_56GQ5UosIURk2yvcTyVRzPAR15EA8egGlutAyG8-0U/exec';
  })(),
  TZ_OFFSET_MIN: 330 // India Standard Time (UTC+5:30)
};
