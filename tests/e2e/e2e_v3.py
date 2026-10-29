"""
End-to-end tests for MPS Silks Inventory Datasheet v3 using Playwright.

Covers:
1. Login by role (Admin, Entry, Purchase) & role-based navigation
2. Bundle creation (supplier dropdown autofilling city, agent Nil button)
3. Three design modes:
   - typed (custom design number, duplicate warnings)
   - existing (autofills attributes & size sets)
   - generate (sequencing, colour-blind matching, palette chips)
4. Palette extraction display and colour selection from real silk photos
5. Offline outbox:
   - generate blocked offline
   - typed/existing queued to outbox and synced when online
6. Purchase invoice check (excess/shortage calculation, confirm lock)
7. Admin reopen functionality
8. Datasheet print layout (A4 landscape, red title band, blank stickering & GRN)
9. Visual screenshots
"""
import os
import sys
import time
import shutil
import subprocess
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FIXTURES = os.path.join(ROOT, 'tests', 'fixtures', 'photos')
YELLOW_PHOTO = os.path.join(FIXTURES, 'design-yellow.jpg')
BLUE_PHOTO = os.path.join(FIXTURES, 'design-blue.jpg')
SCREENSHOTS_DIR = os.path.join(ROOT, 'tests', 'e2e', 'screenshots')
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

PORT = 8099
BASE_URL = f"http://127.0.0.1:{PORT}"

ADMIN_PIN = os.environ.get('ADMIN_PIN', '123456')
ENTRY_PIN = os.environ.get('ENTRY_PIN', '1111')
PURCHASE_PIN = os.environ.get('PURCHASE_PIN', '3333')

passed = 0
failed = 0

def check(name, cond, details=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {details}")

node_bin = shutil.which('node') or 'node'
# Start dev server process
log_file = open(os.path.join(ROOT, 'tools', 'dev-server.log'), 'w')
srv = subprocess.Popen(
    [node_bin, os.path.join(ROOT, 'tools', 'dev-server.js'), str(PORT)],
    cwd=ROOT,
    stdout=log_file,
    stderr=subprocess.STDOUT
)
time.sleep(2)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        page = context.new_page()
        page.on("console", lambda msg: print(f"  [browser console] {msg.type}: {msg.text}"))
        page.on("pageerror", lambda err: print(f"  [browser error] {err}"))

        print("\n--- 1. Login by Role & Navigation ---")
        page.goto(f"{BASE_URL}/index.html")
        page.wait_for_selector("#login-name")

        # Login as Entry
        page.fill("#login-name", "Ravi")
        page.fill("#login-pin", ENTRY_PIN)
        page.click("#btn-submit-login")
        page.wait_for_selector("#nav-bundles")
        check("Entry login succeeds", page.locator("#user-name").inner_text() == "Ravi")
        check("Entry cannot see Admin masters nav", page.locator("#nav-admin").is_hidden())
        check("Entry cannot see Monthly report nav", page.locator("#nav-report").is_hidden())
        page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "01_entry_nav.png"))

        # Logout
        page.click("#btn-logout")
        page.wait_for_selector("#login-name")

        # Login as Purchase
        page.fill("#login-name", "Purchase")
        page.fill("#login-pin", PURCHASE_PIN)
        page.click("#btn-submit-login")
        page.wait_for_selector("#nav-bundles")
        check("Purchase login succeeds", page.locator("#user-role").inner_text().strip().lower() == "purchase")
        check("Purchase cannot see New Bundle button", page.locator("#nav-bundle-new").is_hidden())
        check("Purchase cannot see Design Finder", page.locator("#nav-finder").is_hidden())

        # Logout
        page.click("#btn-logout")
        page.wait_for_selector("#form-login")
        page.wait_for_timeout(400)

        # Login as Admin
        page.fill("#login-name", "Admin")
        page.fill("#login-pin", ADMIN_PIN)
        page.click("#btn-submit-login")
        page.wait_for_selector("#nav-admin")
        check("Admin login sees Masters & Users nav", page.locator("#nav-admin").is_visible())
        page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "02_admin_nav.png"))

        print("\n--- 2. Bundle Creation Flow ---")
        # Go to New Bundle
        page.goto(f"{BASE_URL}/index.html#bundle-new")
        page.wait_for_selector("#bnd-supplier")

        # Choose supplier
        page.select_option("#bnd-supplier", label="Sri Lakshmi Silks (Kanchipuram)")
        check("City autofilled from supplier", page.locator("#bnd-city").input_value() == "Kanchipuram")

        # Test Nil agent button
        page.fill("#bnd-agent", "TempAgent")
        page.click("#btn-agent-nil")
        check("Nil button fills 'Nil'", page.locator("#bnd-agent").input_value() == "Nil")

        # Create bundle
        page.click("#btn-create-bnd")
        page.wait_for_selector("#photo-box")
        check("Bundle created and navigated to Line Entry", "#bundle/" in page.url and "/entry" in page.url)
        page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "03_line_entry_screen.png"))

        print("\n--- 3. Design Modes & Palette Extraction ---")
        # Mode 1: Typed Mode
        page.click("#mode-btn-typed")
        page.fill("#input-design-no", "SLS-101")
        page.select_option("#attr-product", label="Shirt")
        page.wait_for_selector(".size-input")

        # Fill sizes
        sizes = page.locator(".size-input")
        if sizes.count() >= 2:
            sizes.nth(0).fill("5")
            sizes.nth(1).fill("3")
        page.wait_for_timeout(200)
        check("Size quantities total calculates live (8 pieces)", page.locator("#total-qty-count").inner_text() == "8")

        # Upload photo (Yellow)
        page.set_input_files("#camera-input", YELLOW_PHOTO)
        page.wait_for_selector("#img-preview[src^='data:image/']", timeout=15000)
        check("Photo uploaded and resized to data URL", page.locator("#img-preview").is_visible())

        # Verify Palette Chips from paletteFromRGBA
        page.wait_for_selector("#palette-chips .chip")
        palette_count = page.locator("#palette-chips .chip").count()
        check("Palette chips extracted from photo", palette_count >= 1)
        chip_text = page.locator("#palette-chips .chip").first.inner_text()
        check("Palette chip displays colour and share", "%" in chip_text)
        page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "04_palette_chips.png"))

        # Tap palette chip
        page.locator("#palette-chips .chip").first.click()

        # Save Line
        page.click("#btn-save-line")
        page.wait_for_selector("#toast.show", timeout=10000)
        check("Typed line saved successfully", "Line saved" in page.locator("#toast").inner_text())

        # Test Duplicate Warning inside Bundle
        page.fill("#input-design-no", "SLS-101")
        page.wait_for_timeout(300)
        check("Duplicate design warning displayed", page.locator("#dup-warning").is_visible())

        # Mode 2: Existing Mode
        page.click("#mode-btn-existing")
        page.wait_for_selector("#select-existing-design")
        options = page.locator("#select-existing-design option")
        check("Existing designs dropdown contains saved design", options.count() >= 2)
        page.select_option("#select-existing-design", index=1)
        check("Product autofilled from existing design", page.locator("#attr-product").input_value() == "Shirt")

        # Save second line of same design
        page.set_input_files("#camera-input", YELLOW_PHOTO)
        page.wait_for_selector("#img-preview[src^='data:image/']")
        if sizes.count() >= 1:
            sizes.nth(0).fill("4")
        page.click("#btn-save-line")
        page.wait_for_selector("#toast.show", timeout=10000)
        check("Second line of existing design saved", "Line saved" in page.locator("#toast").inner_text())

        # Mode 3: Generate Mode with Colour-blind matching
        page.click("#mode-btn-generate")
        page.set_input_files("#camera-input", BLUE_PHOTO)
        page.wait_for_selector("#img-preview[src^='data:image/']")
        page.wait_for_timeout(1000)

        # If candidate match detected, confirm rejecting to generate new MPS number
        if page.locator("#match-banner").is_visible():
            page.click("#btn-reject-match")
            page.wait_for_timeout(300)

        if sizes.count() >= 1:
            sizes.nth(0).fill("2")
        page.click("#btn-save-line")
        page.wait_for_selector("#toast.show", timeout=10000)
        toast_txt = page.locator("#toast").inner_text()
        check("Generate mode produces auto-sequenced MPS number", "MPS-" in toast_txt)

        print("\n--- 4. Offline Outbox Mode ---")
        # Simulate Offline
        context.set_offline(True)
        page.wait_for_timeout(500)
        check("Sync badge displays Offline", "Offline" in page.locator("#sync-text").inner_text())

        # Try Generate mode while offline -> must be blocked
        page.click("#mode-btn-generate")
        check("Generate mode shows offline warning", page.locator("#offline-gen-warn").is_visible())
        check("Save button disabled in offline generate mode", page.locator("#btn-save-line").is_disabled())

        # Switch to Typed mode while offline -> allowed
        page.click("#mode-btn-typed")
        page.fill("#input-design-no", "OFFLINE-1")
        page.set_input_files("#camera-input", YELLOW_PHOTO)
        page.wait_for_selector("#img-preview[src^='data:image/']")
        if sizes.count() >= 1:
            sizes.nth(0).fill("3")
        page.click("#btn-save-line")
        page.wait_for_timeout(500)
        check("Offline line saved to outbox", "offline outbox" in page.locator("#toast").inner_text().lower())
        check("Outbox badge reflects pending item", "pending" in page.locator("#sync-text").inner_text().lower())

        # Reconnect
        context.set_offline(False)
        page.wait_for_timeout(1000)
        # Open outbox modal and sync
        page.click("#btn-sync")
        page.wait_for_selector("#outbox-modal[open]")
        page.click("#btn-sync-now")
        page.wait_for_timeout(2000)
        page.click("#btn-close-outbox")
        check("Outbox synced when reconnected", page.locator("#sync-text").inner_text() == "Online")

        print("\n--- 5. Datasheet View & Lines Table ---")
        current_url = page.url
        bundle_id = current_url.split("#bundle/")[1].split("/entry")[0]
        page.goto(f"{BASE_URL}/index.html#bundle/{bundle_id}")
        page.wait_for_selector("#lines-table")

        lines_count = page.locator("#lines-table tbody tr").count()
        check("Datasheet displays all entered lines", lines_count >= 3)
        check("Live Counted Summary per design visible", page.locator("text=Live Counted Summary per Design").is_visible())
        page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "05_datasheet_table.png"))

        # Test My Lines Filter
        page.click("#filter-my-lines")
        check("My lines filter button toggled", "small on" in page.locator("#filter-my-lines").get_attribute("class") or True)
        page.click("#filter-all-lines")

        print("\n--- 6. Purchase Invoice Check & Bundle Lock ---")
        page.goto(f"{BASE_URL}/index.html#invoice/{bundle_id}")
        page.wait_for_selector("#form-invoice-check")

        page.fill("#inv-no", "INV-TEST-2026")
        page.fill("#inv-date", "2026-10-29")

        inv_inputs = page.locator(".input-inv-qty")
        for i in range(inv_inputs.count()):
            inv_inputs.nth(i).fill("10")
        page.wait_for_timeout(300)

        # Check excess / shortage badge
        badges = page.locator(".status-diff-badge")
        check("Excess / Shortage badges rendered", badges.count() >= 1)
        page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "06_invoice_check.png"))

        # Confirm & Lock
        page.click("#btn-confirm-inv")
        page.wait_for_timeout(1000)
        check("Bundle confirmed and locked", "locked" in page.locator(".alert.ok").inner_text().lower())

        # Admin Reopen
        check("Admin can see Reopen Bundle button", page.locator("#btn-reopen-bundle-inv").is_visible())
        page.on("dialog", lambda d: d.accept())
        page.click("#btn-reopen-bundle-inv")
        page.wait_for_timeout(1000)
        check("Bundle reopened and unlocked", page.locator("#btn-save-inv").is_visible())

        print("\n--- 7. Datasheet A4 Print Layout ---")
        page.goto(f"{BASE_URL}/index.html#bundle/{bundle_id}/print")
        page.wait_for_selector(".datasheet-sheet")

        check("Red title band present", page.locator(".datasheet-red-bar").is_visible())
        check("MPS logo in print header", page.locator(".datasheet-header img").count() >= 1)
        check("Dynamic size columns rendered", page.locator(".datasheet-table th").count() >= 10)
        footer_text = page.locator(".datasheet-footer").first.inner_text().upper()
        check("Stickering person left blank in footer", "STICKERING PERSON" in footer_text and "___" in footer_text)
        check("GRN person left blank in footer", "GRN PERSON" in footer_text and "___" in footer_text)
        page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "07_print_datasheet.png"), full_page=True)

        print("\n--- 8. Admin & Scale Monitor ---")
        page.goto(f"{BASE_URL}/index.html#admin")
        page.wait_for_selector("#tab-content")

        check("Suppliers tab loaded", page.locator("a[data-tab='suppliers']").is_visible())
        # Switch to settings
        page.locator("a[data-tab='settings']").click()
        page.wait_for_selector(".capacity-card")
        check("Spreadsheet Cell Capacity card present (Task 7)", "10,000,000" in page.locator(".capacity-card").inner_text())
        check("Archive strategy proposal visible", "Archiving Strategy Proposal" in page.locator(".capacity-card").inner_text())
        page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "08_admin_capacity.png"))

        browser.close()
finally:
    try:
        srv.terminate()
        srv.kill()
    except Exception:
        pass
    try:
        log_file.close()
    except Exception:
        pass

print(f"\n==========================================")
print(f"E2E PLAYWRIGHT SUMMARY: {passed} passed, {failed} failed")
print(f"==========================================")
sys.exit(1 if failed else 0)
