# MPS Silks — Inventory Datasheet System

**Client:** MPS Silks (Godown Receipts)  
**Consultant:** C&B Consulting  
**Stack:** Static HTML5 / CSS3 / Vanilla JS (GitHub Pages) + Google Apps Script (bound to Google Sheets & Google Drive).  
**Cost:** ₹0 (Entirely free tier, no paid subscriptions, no paid APIs).

The application replaces the paper-based "Inventory Datasheet" filled when receiving supplier bundles (1,000–2,000 garments/products per bundle). It provides digital line entry, camera capture, on-device dominant colour palette extraction, colour-blind motif matching, dynamic size grids, offline outbox syncing, purchase invoice reconciliation (excess/shortage calculation), and print-ready A4 landscape PDF handover sheets.

---

## Architecture

```
[Staff Phone / Tablet] ────► [GitHub Pages / PWA App Shell (sw.js)]
                                      │
              ┌───────────────────────┴───────────────────────┐
              ▼                                               ▼
       [IndexedDB Outbox]                           [Apps Script Web App]
   (Offline queue, ~3 concurrency)              (POST text/plain, token auth)
                                                              │
                                            ┌─────────────────┴─────────────────┐
                                            ▼                                   ▼
                                    [Google Sheets]                     [Google Drive]
                             (Bundles, Lines, Designs, Masters)     ("MPS Design Photos" folder)
```

- **Frontend:** Static, zero-framework, mobile-first with large touch targets (44px+), Zara-like monochrome and gold editorial aesthetic.
- **Backend:** Google Apps Script (`apps_script/Code.gs`), running bound to a Google Sheet.
- **Shared Logic:** `js/core.js` is the single source of truth. Running `node tools/build-gs.js` generates `apps_script/Core.gs`. Never edit `Core.gs` directly.
- **Local Dev Server:** `tools/dev-server.js` hosts the frontend and executes the real `Code.gs` in Node VM via `tools/gas-mock.js`.

---

## User Roles & Permissions

| Role | Permissions |
|---|---|
| **Admin** | Masters (suppliers, brands, products, attribute lists, size sets), staff user management & PIN resets, system settings, spreadsheet capacity monitor, reports, reopen locked bundles. |
| **Entry** | Create bundles, enter datasheet lines, edit/delete own lines, camera capture & palette extraction, design finder. |
| **Purchase** | Purchase invoice check, enter invoice quantities against counted totals, view excess/shortage diffs, confirm & lock bundles. |

---

## Key Workflows & Features

### 1. Design-Number-First Flow
Staff select how the design number is provided:
1. **Typed (`typed`)**: Staff types supplier design number. If already entered in the active bundle, displays an instant duplicate warning.
2. **Pick Existing (`existing`)**: Staff selects a previously recorded design for this supplier; automatically pre-populates product, brand, pattern, style, fit, sleeve, type, material, and linked size set.
3. **Generate (`generate`)**: Staff captures a photo. The built-in colour-blind motif matcher (`MPSCore.matchDesigns`) checks for earlier designs from the same supplier:
   - If a candidate is identified, staff must explicitly confirm ("Yes, use existing design") or reject ("No, treat as new").
   - If new, the backend sequences the next design number (e.g. `MPS-SLS-0001`).
   - *Offline restriction:* Generating design numbers requires connectivity for sequence integrity; staff are shown an informative prompt to use `typed` or `existing` when offline.

### 2. On-Device Dominant Colour Palette Extraction
- Dominant colours are extracted locally using `MPSCore.paletteFromRGBA` via k-means clustering in CIELAB colour space.
- Extracted colours are matched against the admin's colour master list.
- Tapping an extracted colour chip automatically selects it for the line.

### 3. Dynamic Size Breakdown & QC
- Size grids automatically render based on the product's linked size set (e.g. `S, M, L, XL, XXL` or waist sizes `28, 30, 32...`).
- Large touch-friendly stepper inputs calculate live piece totals.
- Quality Control (QC Pass) flag recorded per line.

### 4. Photo Fallback Chain
To resolve Google Drive thumbnail cross-origin issues in browsers:
1. Primary: `https://lh3.googleusercontent.com/d/{id}=w400` with `referrerpolicy="no-referrer"`.
2. Secondary: `https://drive.google.com/thumbnail?id={id}&sz=w400`.
3. Tertiary: Calls action `photos.get` to stream JPEG base64 data URL directly from Apps Script DriveApp.
4. Resolved images are cached in memory and IndexedDB.

### 5. Offline Outbox & Background Sync
- Service worker (`sw.js`) caches the application shell.
- When offline, lines in `typed` or `existing` modes are queued in IndexedDB outbox with a unique client `requestId`.
- Background sync processor runs with concurrency ~3 upon reconnecting.
- Outbox status badge in header indicates pending / failed items with a manual sync drawer.

### 6. Purchase Invoice Check & Bundle Locking
- Accessible by Purchase and Admin staff.
- Compares physical counted pieces against supplier invoice quantities per design.
- Live calculation of **Excess** (`+X`), **Shortage** (`-X`), or **Match** (`0`).
- Confirmation locks the bundle against further edits or line additions. Only Admin can reopen a locked bundle.

### 7. Datasheet A4 Landscape PDF Handover
- Dedicated print layout (`@media print`): A4 landscape, 8mm margins.
- Features red title band (`sheet_title`), MPS Silks logo, C&B logo, and bundle metadata header.
- Table columns: S.No, Photo thumbnail, Design No, Product, Pattern, Fit, Sleeve, Material, Colour, dynamic size breakdown columns, Total Qty, QC Pass, Diff.
- Automatically divides lines into parts of ~100 lines each.
- Footer displays Entered-by name, with **Stickering Person** and **GRN Person** signature lines left blank for manual warehouse signing.

### 8. System Capacity & Spreadsheet Scale Monitor
- Google Sheets enforces a hard ceiling of 10,000,000 cells per workbook (~277 bundles of 2,000 lines).
- Admin screen includes a live cell utilization meter and capacity warning.
- An archive strategy proposal (annual rollover) is documented awaiting client decision.

### 9. Optional Gemini Attribute Suggestion
- Gemini Vision suggestion (`gemini-3.8-flash`) can suggest product attributes from photo for new designs.
- Kept **OFF** by default. Requires script property `GEMINI_API_KEY` from Google AI Studio and explicit client consent.

---

## Setup & Deployment Guide

### Step 1: Google Sheet & Apps Script Backend
1. Create a fresh Google Sheet (e.g. "MPS Inventory Datasheet").
2. Go to **Extensions → Apps Script**.
3. Replace the content of `Code.gs` with the contents of `apps_script/Code.gs`.
4. Create a new script file named `Core` (**+ → Script**) and paste `apps_script/Core.gs`.
5. Select `setup` from the function dropdown and click **Run**. Grant Sheets and Drive authorizations.
6. Check **Execution log**: It logs the first Admin login name and one-time numeric PIN.
7. Click **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
8. Copy the Web App URL (ends with `/exec`).

### Step 2: Configure Frontend
1. Open `js/config.js` and paste your `/exec` URL into `API_URL`:
   ```javascript
   window.MPS_CONFIG = {
     API_URL: 'https://script.google.com/macros/s/.../exec',
     TZ_OFFSET_MIN: 330
   };
   ```
2. Commit and push to your GitHub repository's `main` branch.
3. In GitHub repo settings: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. GitHub Actions will run tests, build the site, and deploy it to GitHub Pages.

### Step 3: Local Development Server
To develop or test locally without touching Google services:
```bash
npm start
# or: node tools/dev-server.js 8099
```
Open `http://127.0.0.1:8099` in your browser. The mock GAS backend is immediately available at `/api`.

---

## Testing & Verification

Run all test suites locally:
```bash
# 1. Backend + Palette unit tests (Node.js)
npm test

# 2. Playwright End-to-End test suite (Chromium headless)
npm run test:e2e
# or: python tests/e2e/e2e_v3.py
```

### Verification Matrix
| Component | Status | Details |
|---|---|---|
| **Backend Rules & Roles** | **TESTED** | 32 passing checks in `tests/backend.test.js` against `gas-mock.js` (lockout, roles, masters, idempotency, reopen). |
| **Palette Extraction** | **TESTED** | 4 passing checks in `tests/palette.test.js` on real yellow and blue silk photos (`fixtures/photos`). |
| **Playwright UI E2E** | **TESTED** | 41 passing checks in `tests/e2e/e2e_v3.py` covering login, bundle creation, 3 design modes, offline sync, invoice lock, and print layout. |
| **A4 Landscape Print View** | **TESTED** | Visual verification via Playwright screenshot (`07_print_datasheet.png`). |
| **Live Google Deployment** | Untested | Requires deployment to client's Google account with live Sheets/Drive permissions. |
| **Real Gemini API calls** | Untested | Kept OFF by default. Requires Google AI Studio API key and MPS consent. |

---

## Handover Questions for Client & Stakeholders

The following questions use sensible defaults in the current build and are flagged for stakeholder alignment:
1. **Design numbers:** Are design numbers unique across all suppliers or per supplier? *(Current key: supplier + design number).*
2. **Photos:** Photo required per line or per design? Camera-only or gallery upload permitted? *(Current: per line with gallery/camera input).*
3. **Excess/shortage granularity:** Computed per design (current), per colour, or per size?
4. **Offline generation:** Is offline generation of design numbers needed? *(Current answer: No, sequencing requires connectivity).*
5. **Bundle creation permission:** Can entry staff open bundles or admin only? *(Current: Entry and Admin can open).*
6. **Locking policy:** Edit policy after PDF datasheet is printed.
7. **Gemini consent:** Confirm MPS consent regarding Google's free-tier data policies before enabling Gemini suggestions.
8. **Sheet title acronym:** Clarify meaning of "KGF" in default title `"MPS SILKS - KGF - Inventory Datasheet - (Readymade Product)"`.
9. **Brand master linking:** Should brand masters link directly to specific suppliers?
10. **Scale & Archiving:** Expected bundles per month and preference on archive schedule.
11. **Duplicate suppliers:** Business rule for suppliers with identical trading names in different cities.
12. **Photo troubleshooting:** If photos break on a specific network, open Drive image URL in a new tab and note HTTP status code.
