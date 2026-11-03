"""QR invitation browser checks against simulated Supabase responses.

Run the static server on port 3000, then use Python Playwright and system Chromium.
The fixture reproduces the GitHub Pages path prefix and never contacts Supabase.
SVG comparison verifies the exact event URL wiring; independent QR decoder checks
also validate the bundled encoder separately during QR-library integration.
"""

import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ORIGIN = "http://127.0.0.1:3000"
BASE = f"{ORIGIN}/matching-game/"
API = "https://qr-test.supabase.co"
CODE = "abc123def456"
CLOSED_CODE = "fff000eee111"
INVITE = f"{BASE}?event={CODE}"
STEPS = [f"Step {i}" for i in range(1, 10)]


class Backend:
    def __init__(self):
        self.calls = []
        self.fail_metadata = False

    def handle(self, route):
        request = route.request
        headers = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"}
        if request.method == "OPTIONS":
            route.fulfill(status=200, headers=headers)
            return
        path = urlsplit(request.url).path
        data = request.post_data_json
        self.calls.append((path, data))
        if path == "/auth/v1/token":
            assert data == {"email": "host@example.test", "password": "test-password-only"}
            result = {"access_token": "test-host-access-token", "refresh_token": "test-refresh-token",
                      "expires_in": 3600, "user": {"email": "host@example.test"}}
        elif path in ["/rest/v1/rpc/create_event", "/rest/v1/rpc/get_event"]:
            if path.endswith("create_event"):
                assert request.headers.get("authorization") == "Bearer test-host-access-token"
                code = CODE
            else:
                code = data["p_code"]
                if self.fail_metadata:
                    route.abort()
                    return
            result = {"code": code, "title": "Patient Journey Challenge", "active": code != CLOSED_CODE,
                      "scenario": {"title": "A diagnosis journey", "description": "Arrange the steps.",
                                   "category": "PATIENT JOURNEY", "step_count": 9}}
        elif path == "/rest/v1/rpc/get_leaderboard":
            result = []
        elif path == "/rest/v1/rpc/start_round":
            assert data["p_code"] == CODE
            assert data["p_name"] == "Team Scan"
            assert "authorization" not in request.headers
            result = {"token": "22222222-2222-4222-8222-222222222222",
                      "started_at": "2026-11-03T00:00:00Z",
                      "steps": [{"id": f"11111111-1111-4111-8111-{i:012d}", "text": STEPS[i]}
                                for i in reversed(range(9))]}
        else:
            raise AssertionError(f"Unexpected backend request: {path}")
        route.fulfill(status=200, content_type="application/json", body=json.dumps(result), headers=headers)

    def install(self, context):
        def static_proxy(route):
            url = route.request.url.replace("/matching-game/", "/", 1)
            route.fulfill(response=route.fetch(url=url))

        context.route(f"{BASE}**", static_proxy)
        context.route("**/config.json", lambda route: route.fulfill(
            status=200, content_type="application/json",
            body=json.dumps({"supabaseUrl": API, "supabaseKey": "sb_publishable_browser_test"})))
        context.route(f"{API}/**", self.handle)

    def round_count(self):
        return len([call for call in self.calls if call[0].endswith("start_round")])


def no_code_form(page):
    assert page.locator("#join-code, #join-form, #join-event-dialog, #join-event-button").count() == 0
    assert page.locator("input[type=password], #admin-login-form").count() == 0


def no_overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True,
                                         args=["--no-sandbox"])
    backend = Backend()
    admin_context = browser.new_context(viewport={"width": 390, "height": 844}, accept_downloads=True)
    phone_context = browser.new_context(viewport={"width": 390, "height": 844})
    for context in [admin_context, phone_context]:
        backend.install(context)
    admin = admin_context.new_page()
    phone = phone_context.new_page()
    errors = []
    for page in [admin, phone]:
        page.on("pageerror", lambda error: errors.append(str(error)))

    admin.goto(f"{BASE}admin.html", wait_until="networkidle")
    admin.locator("#admin-email").fill("host@example.test")
    admin.locator("#admin-password").fill("test-password-only")
    admin.locator("#admin-login-submit").click()
    expect(admin.locator("#admin-dashboard")).to_be_visible()
    admin.locator("#admin-event-title").fill("Patient Journey Challenge")
    admin.locator("#admin-create-submit").click()
    expect(admin.locator("#admin-share-url")).to_have_value(INVITE)
    expect(admin.locator("#admin-qr svg")).to_be_visible()
    expect(admin.locator("#admin-download-qr")).to_be_enabled()
    expected_svg = admin.evaluate("""async (invite) => {
      const { createQrSvg } = await import('./qr-code.mjs');
      return createQrSvg(invite);
    }""", INVITE)
    rendered_svg = admin.locator("#admin-qr svg").evaluate("el => new XMLSerializer().serializeToString(el)")
    normalized_expected = admin.evaluate("""svg => new XMLSerializer().serializeToString(
      new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement)""", expected_svg)
    assert rendered_svg == normalized_expected, "QR does not encode the precise player event URL"
    assert "admin.html" not in admin.locator("#admin-share-url").input_value()
    no_overflow(admin)

    with admin.expect_download() as info:
        admin.locator("#admin-download-qr").click()
    download = info.value
    assert download.suggested_filename == f"flow-state-{CODE}.svg"
    assert Path(download.path()).read_text() == expected_svg

    admin.evaluate("window.print = () => { window.testPrintCalled = true; };")
    admin.locator("#admin-print-qr").click()
    assert admin.evaluate("window.testPrintCalled === true && document.body.classList.contains('print-event-qr')")
    admin.emulate_media(media="print")
    expect(admin.locator("#admin-qr-poster")).to_be_visible()
    expect(admin.locator("#admin-create-form")).to_be_hidden()
    expect(admin.locator("#admin-preview-steps")).to_be_hidden()
    expect(admin.locator("#admin-share-url")).to_be_hidden()
    expect(admin.locator("#admin-qr-title")).to_have_text("Patient Journey Challenge")
    admin.emulate_media(media="screen")
    admin.evaluate("window.dispatchEvent(new Event('afterprint'))")
    assert not admin.evaluate("document.body.classList.contains('print-event-qr')")

    # Following the encoded URL is the navigation performed after a phone scan.
    phone.goto(INVITE, wait_until="networkidle")
    expect(phone.locator("#shared-event-name")).to_have_text("Patient Journey Challenge")
    expect(phone.locator("#shared-event-state")).to_have_text("Joined event")
    expect(phone.locator(".game-layout")).to_be_visible()
    no_code_form(phone)
    assert backend.round_count() == 0, "Scanning started the timer/round before name entry"
    expect(phone.locator("#timer")).to_have_text("00:00")
    phone.locator("#player-name").fill("Team Scan")
    phone.locator("#start-round").click()
    expect(phone.locator(".flow-card")).to_have_count(9)
    assert backend.round_count() == 1
    no_overflow(phone)

    phone.goto(BASE, wait_until="networkidle")
    expect(phone.locator("#qr-welcome")).to_be_visible()
    expect(phone.locator(".game-layout")).to_be_hidden()
    expect(phone.locator(".leaderboard")).to_be_hidden()
    no_code_form(phone)
    phone.locator("#practice-button").click()
    expect(phone.locator(".game-layout")).to_be_visible()
    expect(phone.locator("#leaderboard-scope")).to_have_text("This device only")
    assert backend.round_count() == 1
    phone.locator("#leave-event").click()
    expect(phone.locator(".game-layout")).to_be_hidden()
    expect(phone.locator("#qr-welcome")).to_be_visible()

    for query in ["?event=", "?event=bad-link"]:
        phone.goto(BASE + query, wait_until="networkidle")
        expect(phone.locator("#shared-status")).to_contain_text("invalid")
        expect(phone.locator(".game-layout")).to_be_hidden()
        expect(phone.locator("#start-round")).to_be_disabled()
        assert backend.round_count() == 1
        no_code_form(phone)

    backend.fail_metadata = True
    phone.goto(INVITE, wait_until="networkidle")
    expect(phone.locator("#retry-connection")).to_be_visible()
    expect(phone.locator(".game-layout")).to_be_hidden()
    expect(phone.locator("#start-round")).to_be_disabled()
    backend.fail_metadata = False
    phone.locator("#retry-connection").click()
    expect(phone.locator("#shared-event-state")).to_have_text("Joined event")
    expect(phone.locator(".game-layout")).to_be_visible()
    assert backend.round_count() == 1

    phone.goto(f"{BASE}?event={CLOSED_CODE}", wait_until="networkidle")
    expect(phone.locator("#shared-event-state")).to_have_text("Closed to new entries")
    expect(phone.locator("#start-round")).to_be_disabled()
    phone.locator("#round-form").dispatch_event("submit")
    assert backend.round_count() == 1, "Closed event started a round"
    no_overflow(phone)
    assert not errors, errors
    browser.close()
    print("PASS: event-specific QR rendering/download/print, scan-to-event without a code or login, "
          "name-first start, explicit practice, malformed/closed link protection, connection retry, and mobile layout.")
