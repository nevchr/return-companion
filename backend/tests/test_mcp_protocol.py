from fastapi.testclient import TestClient

from app import main

app = main.app

ACCEPT = "application/json, text/event-stream"
VERSION = "2025-11-25"


def send(client, payload, initialized=False, **headers):
    request_headers = {"Accept": ACCEPT, **headers}
    if initialized:
        request_headers["MCP-Protocol-Version"] = VERSION
    return client.post("/mcp", json=payload, headers=request_headers)


def test_streamable_http_initialize_discover_and_call_read_only_tools(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(app) as client:
        init = send(client, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": VERSION, "capabilities": {},
            "clientInfo": {"name": "test-web-client", "version": "1.0"},
        }})
        assert init.status_code == 200
        assert init.json()["result"]["protocolVersion"] == VERSION
        assert init.json()["result"]["capabilities"]["tools"]
        initialized = send(client, {"jsonrpc": "2.0", "method": "notifications/initialized"}, True)
        assert initialized.status_code == 202 and initialized.content == b""
        listed = send(client, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, True).json()
        assert {tool["name"] for tool in listed["result"]["tools"]} == {
            "get_sample_order", "check_return_options", "prepare_return_proposal", "submit_simulated_return"}

        order = send(client, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "get_sample_order", "arguments": {"order_id": "NS-DEMO-1001"},
        }}, True).json()["result"]
        assert order["isError"] is False
        assert order["structuredContent"]["product_name"] == "Northstar Wireless Headphones"

        verdict = send(client, {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "check_return_options", "arguments": {"order_id": "NS-DEMO-1003", "issue": "defective",
                "condition": "opened", "accessories_complete": True},
        }}, True).json()["result"]["structuredContent"]["eligibility"]
        assert verdict["status"] == "needs_review"
        assert verdict["reason_codes"] == ["MISSING_DELIVERY_DATE"]


def test_mcp_proposal_persists_and_mcp_submit_requires_approval_and_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(app) as client:
        unreviewed = send(client, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "prepare_return_proposal", "arguments": {
                "order_id": "NS-DEMO-1001", "issue": "defective", "condition": "opened",
                "accessories_complete": True, "receipt_reviewed": False, "idempotency_key": "proposal-nope"}},
        }, True).json()["result"]
        assert unreviewed["isError"] is True
        assert "RECEIPT_REVIEW_REQUIRED" in unreviewed["content"][0]["text"]
        assert client.get("/api/demo").json()["cases"] == []

        args = {"order_id": "NS-DEMO-1001", "issue": "defective", "condition": "opened",
                "accessories_complete": True, "receipt_reviewed": True,
                "delivery_date_override": "2026-09-08", "idempotency_key": "proposal-key-1001"}
        prepared = send(client, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "prepare_return_proposal", "arguments": args,
        }}, True).json()["result"]["structuredContent"]
        assert prepared["case"]["state"] == "AWAITING_APPROVAL"
        case_id = prepared["case"]["case_id"]
        replay = send(client, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "prepare_return_proposal", "arguments": args,
        }}, True).json()["result"]["structuredContent"]
        assert replay["replayed"] is True
        assert replay["case"]["case_id"] == case_id
        assert len(client.get("/api/demo").json()["cases"]) == 1

        offer = prepared["case"]["offer"]
        option = offer["options"][0]
        unauthorized = send(client, {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "submit_simulated_return", "arguments": {
                "case_id": case_id, "approval_id": "not-approved", "idempotency_key": "submit-key-1001"}},
        }, True).json()["result"]
        assert unauthorized["isError"] is True
        assert "APPROVAL_REQUIRED" in unauthorized["content"][0]["text"]

        approved = client.post(f"/api/cases/{case_id}/approve", json={
            "offer_id": offer["offer_id"], "terms_hash": option["terms_hash"], "expected_revision": prepared["case"]["revision"]})
        assert approved.status_code == 200
        approval_id = approved.json()["approval"]["approval_id"]
        expired_offer = dict(offer)
        expired_offer["expires_at"] = "2000-01-01T00:00:00+00:00"
        with main.connect() as db:
            db.execute("UPDATE cases SET offer_json=? WHERE case_id=?", (main.json.dumps(expired_offer), case_id))
        expired = send(client, {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {
            "name": "submit_simulated_return", "arguments": {
                "case_id": case_id, "approval_id": approval_id, "idempotency_key": "expired-submit-1001"}},
        }, True).json()["result"]
        assert expired["isError"] is True
        assert "OFFER_EXPIRED" in expired["content"][0]["text"]

        refreshed = client.post(f"/api/cases/{case_id}/offers").json()["case"]
        refreshed_option = refreshed["offer"]["options"][0]
        reapproved = client.post(f"/api/cases/{case_id}/approve", json={
            "offer_id": refreshed["offer"]["offer_id"], "terms_hash": refreshed_option["terms_hash"],
            "expected_revision": refreshed["revision"]})
        assert reapproved.status_code == 200
        approval_id = reapproved.json()["approval"]["approval_id"]
        args = {"case_id": case_id, "approval_id": approval_id, "idempotency_key": "submit-key-1001"}
        submitted = send(client, {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {
            "name": "submit_simulated_return", "arguments": args,
        }}, True).json()["result"]["structuredContent"]
        assert submitted["state"] == "AWAITING_DROPOFF"
        assert submitted["label"] == "DEMO ONLY - NOT VALID FOR SHIPPING"
        replayed = send(client, {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {
            "name": "submit_simulated_return", "arguments": args,
        }}, True).json()["result"]["structuredContent"]
        assert replayed["return_id"] == submitted["return_id"]
        assert len(client.get("/api/demo").json()["cases"]) == 1


def test_streamable_http_rejects_protocol_and_origin_errors_without_writes(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(app) as client:
        missing_version = send(client, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert missing_version.status_code == 400
        bad_origin = send(client, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": VERSION, "capabilities": {}, "clientInfo": {"name": "browser", "version": "1"},
        }}, Origin="https://attacker.example")
        assert bad_origin.status_code == 403
        malformed_origin = send(client, {"jsonrpc": "2.0", "id": 12, "method": "initialize", "params": {
            "protocolVersion": VERSION, "capabilities": {}, "clientInfo": {"name": "browser", "version": "1"},
        }}, Origin="http://localhost:notaport")
        assert malformed_origin.status_code == 403
        invalid_args = send(client, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "check_return_options", "arguments": {"order_id": "NS-DEMO-1001", "issue": "made-up",
                "condition": "opened", "accessories_complete": True},
        }}, True).json()
        assert invalid_args["error"]["code"] == -32602
        invalid_date = send(client, {"jsonrpc": "2.0", "id": 22, "method": "tools/call", "params": {
            "name": "check_return_options", "arguments": {"order_id": "NS-DEMO-1001", "issue": "defective",
                "condition": "opened", "accessories_complete": True, "delivery_date_override": "2026-99-99"},
        }}, True).json()
        assert invalid_date["error"]["code"] == -32602
        unavailable = send(client, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "submit_return", "arguments": {},
        }}, True).json()["result"]
        assert unavailable["isError"] is True
        assert client.get("/api/demo").json()["cases"] == []


def test_streamable_http_handles_parse_and_method_errors(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(app) as client:
        parse = client.post("/mcp", content="{", headers={"Accept": ACCEPT})
        assert parse.json()["error"]["code"] == -32700
        unknown = send(client, {"jsonrpc": "2.0", "id": 7, "method": "returns/submit"}, True)
        assert unknown.json()["error"]["code"] == -32601
