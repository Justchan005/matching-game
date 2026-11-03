"""Separate admin/player browser checks with simulated Supabase responses.

Run the local server on port 3000, then run this file with Python Playwright
and /usr/bin/chromium installed. No requests reach the real Supabase project.
The static-file proxy below reproduces GitHub Pages' /matching-game/ prefix.
"""

import json
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


ORIGIN = "http://127.0.0.1:3000"
BASE = f"{ORIGIN}/matching-game/"
API = "https://admin-test.supabase.co"
EXISTING_CODE = "abc123def456"
NEW_CODE = "def456abc123"
TEST_EMAIL = "host@example.test"
TEST_PASSWORD = "test-password-only"
INITIAL_TOKEN = "test-initial-access-token"
REFRESHED_TOKEN = "test-refreshed-access-token"
REFRESH_TOKEN = "test-refresh-token"
STEPS = ["Welcome the guest", "Check the booking", "Show the guest their seat"]
STEP_IDS = [f"11111111-1111-4111-8111-{n:012d}" for n in range(1, 4)]


def metadata(code, title, scenario=None):
    scenario = scenario or {
        "title": "Welcome a guest",
        "description": "Put the arrival actions in the correct order.",
        "category": "YOUR EVENT",
        "steps": STEPS,
    }
    return {
        "code": code,
        "title": title,
        "active": True,
        "scenario": {
            "title": scenario["title"],
            "description": scenario["description"],
            "category": scenario.get("category", "YOUR EVENT"),
            "step_count": len(scenario["steps"]),
        },
    }


class Backend:
    def __init__(self):
        self.events = {EXISTING_CODE: metadata(EXISTING_CODE, "Existing event")}
        self.calls = []
        self.created = None
        self.forbid_close = True
        self.rows = [{"name": "Team Cedar", "score": 100, "seconds": 21}]

    def handle(self, route):
        request = route.request
        if request.method == "OPTIONS":
            route.fulfill(status=200, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "*",
            })
            return
        path = urlsplit(request.url).path
        data = request.post_data_json
        self.calls.append((path, data, request.headers))
        status = 200
        if path == "/auth/v1/token":
            grant = parse_qs(urlsplit(request.url).query)["grant_type"][0]
            if grant == "password":
                assert data == {"email": TEST_EMAIL, "password": TEST_PASSWORD}
                result = {"access_token": INITIAL_TOKEN, "refresh_token": REFRESH_TOKEN,
                          "expires_in": 1, "user": {"email": TEST_EMAIL}}
            else:
                assert grant == "refresh_token" and data == {"refresh_token": REFRESH_TOKEN}
                result = {"access_token": REFRESHED_TOKEN, "refresh_token": REFRESH_TOKEN,
                          "expires_in": 3600, "user": {"email": TEST_EMAIL}}
        elif path == "/auth/v1/logout":
            assert request.headers.get("authorization") == f"Bearer {REFRESHED_TOKEN}"
            result = None
        elif path == "/rest/v1/rpc/get_event":
            result = self.events[data["p_code"]]
        elif path == "/rest/v1/rpc/get_leaderboard":
            result = self.rows
        elif path == "/rest/v1/rpc/create_event":
            assert request.headers.get("authorization") == f"Bearer {REFRESHED_TOKEN}"
            self.created = data
            result = metadata(NEW_CODE, data["p_title"], data["p_scenario"])
            self.events[NEW_CODE] = result
        elif path == "/rest/v1/rpc/close_event":
            assert request.headers.get("authorization") == f"Bearer {REFRESHED_TOKEN}"
            if self.forbid_close:
                status = 403
                result = {"code": "42501", "message": "Only the host can close this event."}
            else:
                result = self.events[data["p_code"]]
                result["active"] = False
        elif path == "/rest/v1/rpc/start_round":
            assert "authorization" not in request.headers
            result = {"token": "22222222-2222-4222-8222-222222222222",
                      "started_at": "2026-11-03T00:00:00Z",
                      "steps": [{"id": STEP_IDS[i], "text": STEPS[i]} for i in [2, 0, 1]]}
        else:
            raise AssertionError(f"Unexpected test request: {path}")
        route.fulfill(status=status, content_type="application/json", body=json.dumps(result),
                      headers={"Access-Control-Allow-Origin": "*"})

    def install(self, context):
        def static_proxy(route):
            url = route.request.url.replace("/matching-game/", "/", 1)
            route.fulfill(response=route.fetch(url=url))

        context.route(f"{BASE}**", static_proxy)
        context.route("**/config.json", lambda route: route.fulfill(
            status=200, content_type="application/json",
            body=json.dumps({"supabaseUrl": API, "supabaseKey": "sb_publishable_browser_test"})))
        context.route(f"{API}/**", self.handle)


def assert_no_overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Page overflows horizontally"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True,
                                         args=["--no-sandbox"])
    backend = Backend()
    admin_context = browser.new_context(viewport={"width": 1280, "height": 900})
    player_context = browser.new_context(viewport={"width": 390, "height": 844})
    for context in [admin_context, player_context]:
        backend.install(context)
    admin = admin_context.new_page()
    player = player_context.new_page()
    errors = []
    for page in [admin, player]:
        page.on("pageerror", lambda error: errors.append(str(error)))

    player.goto(BASE, wait_until="networkidle")
    expect(player.locator("#join-event-button")).to_be_visible()
    for selector in ["#host-event-button", "#host-event-dialog", "#host-login-form", "#host-create-form",
                     "#custom-form", "#customize-button", "#close-event", "#admin-login-form"]:
        assert player.locator(selector).count() == 0, f"Admin control found on player page: {selector}"
    expect(player.locator(".flow-card")).to_have_count(9)
    assert_no_overflow(player)

    admin.goto(f"{BASE}admin.html?event={EXISTING_CODE}", wait_until="networkidle")
    expect(admin.locator("#admin-login-panel")).to_be_visible()
    expect(admin.locator("#admin-dashboard")).to_be_hidden()
    assert not backend.calls, "Management requests occurred before authentication"
    admin.locator("#admin-create-form").dispatch_event("submit")
    assert not backend.calls, "A forced unauthenticated form submission created a request"
    admin.locator("#admin-email").fill(TEST_EMAIL)
    admin.locator("#admin-password").fill(TEST_PASSWORD)
    admin.locator("#admin-login-submit").click()
    expect(admin.locator("#admin-dashboard")).to_be_visible()
    expect(admin.locator("#admin-event-name")).to_have_text("Existing event")
    expect(admin.locator("#admin-leaderboard")).to_contain_text("Team Cedar")
    expect(admin.locator("#admin-password")).to_have_value("")

    admin.locator("#admin-add-scenario").click()
    admin.locator("#custom-name").fill("A warm welcome")
    admin.locator("#custom-description").fill("Guide a guest through their arrival.")
    admin.locator("#custom-steps").fill("Welcome\nWelcome\nFinish")
    admin.locator("#custom-form button[type=submit]").click()
    expect(admin.locator("#custom-error")).to_be_visible()
    expect(admin.locator("#custom-dialog")).to_be_visible()
    admin.locator("#custom-steps").fill("\n".join(STEPS))
    admin.locator("#custom-form button[type=submit]").click()
    expect(admin.locator("#custom-dialog")).to_be_hidden()
    expect(admin.locator("#admin-scenario option:checked")).to_have_text("A warm welcome")
    drafts = admin.evaluate("JSON.parse(localStorage.getItem('flow-state.scenarios.v1'))")
    assert drafts[-1]["steps"] == STEPS

    admin.locator("#admin-event-title").fill("Welcome Challenge")
    admin.locator("#admin-create-submit").click()
    expect(admin.locator("#admin-event-name")).to_have_text("Welcome Challenge")
    assert backend.created["p_scenario"]["title"] == "A warm welcome", "Refresh changed scenario selection"
    assert backend.created["p_scenario"]["steps"] == STEPS
    assert len([call for call in backend.calls if call[0] == "/auth/v1/token"]) == 2, "Host token was not refreshed"
    invite = admin.locator("#admin-share-url").input_value()
    assert invite == f"{BASE}?event={NEW_CODE}", "Invite must open player page under the deployment prefix"
    assert admin.locator("#admin-projector-link").get_attribute("href") == f"{invite}&view=leaderboard"
    assert "admin.html" in admin.url and NEW_CODE in admin.url
    assert_no_overflow(admin)
    admin.set_viewport_size({"width": 390, "height": 844})
    assert_no_overflow(admin)

    player.goto(invite, wait_until="networkidle")
    expect(player.locator("#shared-event-name")).to_have_text("Welcome Challenge")
    expect(player.locator("#leaderboard-list")).to_contain_text("Team Cedar")
    player.locator("#player-name").fill("Player on another phone")
    player.locator("#start-round").click()
    expect(player.locator(".flow-card")).to_have_count(3)
    assert_no_overflow(player)

    admin.locator("#admin-close-event").click()
    expect(admin.locator("#admin-notice")).to_contain_text("Only the host can close")
    expect(admin.locator("#admin-event-state")).to_contain_text("OPEN")
    expect(admin.locator("#admin-close-event")).to_be_enabled()
    backend.forbid_close = False
    admin.locator("#admin-close-event").click()
    expect(admin.locator("#admin-event-state")).to_have_text("CLOSED TO NEW ENTRIES")
    expect(admin.locator("#admin-close-event")).to_be_disabled()

    admin.locator("#admin-signout").click()
    expect(admin.locator("#admin-dashboard")).to_be_hidden()
    expect(admin.locator("#admin-login-panel")).to_be_visible()
    expect(admin.locator("#admin-password")).to_have_value("")
    expect(admin.locator("#admin-email")).to_have_value("")
    storage = admin.evaluate("JSON.stringify({local: {...localStorage}, session: {...sessionStorage}})")
    for sensitive in [TEST_PASSWORD, INITIAL_TOKEN, REFRESHED_TOKEN, REFRESH_TOKEN]:
        assert sensitive not in storage, "Credentials were persisted in browser storage"
    before_forced_action = len(backend.calls)
    admin.locator("#admin-create-form").dispatch_event("submit")
    assert len(backend.calls) == before_forced_action, "Signed-out form created a request"
    assert not errors, errors
    browser.close()
    print("PASS: separate player/admin controls, login gate, token refresh, scenario validation/persistence, "
          "prefixed player invitations, cross-browser join, leaderboard, close permissions, signout, and mobile layout.")
