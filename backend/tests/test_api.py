from fastapi.testclient import TestClient
import pytest

from app.agent import CHECK_RETURN_OPTIONS, Selection
from app import main


def test_happy_path_is_approved_idempotent_and_persistent(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    main.init_db()
    with TestClient(main.app) as client:
        demo = client.get("/api/demo").json()
        assert demo["simulation"] is True
        assert demo["orders"][0]["order_id"] == "NS-DEMO-1001"
        assert demo["receipt_samples"]["NS-DEMO-1001"]["synthetic"] is True
        assert demo["receipt_samples"]["NS-DEMO-1001"]["extracted_fields"]["delivery_date"] == "2026-09-08"
        assert "delivery_date" not in demo["receipt_samples"]["NS-DEMO-1003"]["extracted_fields"]

        created = client.post("/api/cases", json={"order_id": "NS-DEMO-1001", "receipt_reviewed": True})
        assert created.status_code == 200
        case = created.json()
        case_id = case["case_id"]

        offers = client.post(f"/api/cases/{case_id}/offers").json()
        assert offers["eligibility"]["status"] == "eligible"
        assert offers["eligibility"]["options"][0]["refund_cents"] == 10169
        current = offers["case"]
        option = current["offer"]["options"][0]

        # A selected option ID is not the enclosing offer ID required by the API.
        # This was the frontend regression: it showed [object Object] and left
        # the case awaiting approval instead of recording the user's choice.
        wrong_offer = client.post(f"/api/cases/{case_id}/approve", json={
            "offer_id": option["option_id"],
            "terms_hash": option["terms_hash"],
            "expected_revision": current["revision"],
        })
        assert wrong_offer.status_code == 409
        assert wrong_offer.json()["detail"] == "OFFER_CHANGED: review the current offer"
        still_pending = client.get(f"/api/cases/{case_id}").json()
        assert still_pending["state"] == "AWAITING_APPROVAL"
        assert still_pending["approval"] is None
        assert [event["event_type"] for event in still_pending["timeline"]] == ["CASE_CREATED", "OFFER_PREPARED"]

        denied = client.post(f"/api/cases/{case_id}/submit", json={
            "approval_id": "not-approved", "idempotency_key": "attempt-no-approval"
        })
        assert denied.status_code == 409
        assert "APPROVAL_REQUIRED" in denied.text

        approved = client.post(f"/api/cases/{case_id}/approve", json={
            "offer_id": current["offer"]["offer_id"],
            "terms_hash": option["terms_hash"],
            "expected_revision": current["revision"],
        })
        assert approved.status_code == 200
        approval_id = approved.json()["approval"]["approval_id"]
        payload = {"approval_id": approval_id, "idempotency_key": "attempt-1001-demo"}
        first = client.post(f"/api/cases/{case_id}/submit", json=payload)
        second = client.post(f"/api/cases/{case_id}/submit", json=payload)
        assert first.status_code == second.status_code == 200
        assert first.json()["label"] == "DEMO ONLY - NOT VALID FOR SHIPPING"
        assert first.json()["label"] == "DEMO ONLY - NOT VALID FOR SHIPPING"
        assert client.get(f"/api/cases/{case_id}/label").text.startswith("DEMO ONLY - NOT VALID FOR SHIPPING")
        assert "attachment" in client.get(f"/api/cases/{case_id}/label").headers["content-disposition"]
        reopened = client.get(f"/api/cases/{case_id}").json()
        assert reopened["state"] == "AWAITING_DROPOFF"
        assert reopened["eligibility_result"]["status"] == "eligible"
        assert reopened["offer"]["policy_version"] == "northstar-v1"
        assert reopened["return"]["return_id"] == first.json()["return_id"]
        assert len(reopened["timeline"]) == 4
        distinct_key_retry = client.post(f"/api/cases/{case_id}/submit", json={
            "approval_id": approval_id, "idempotency_key": "another-key-for-return-1001"
        })
        assert distinct_key_retry.status_code == 409
        assert "already has a simulated return" in distinct_key_retry.text
        for status in ("DROPPED_OFF", "RECEIVED", "REFUNDED"):
            advanced = client.post(f"/api/demo/cases/{case_id}/advance", json={"status": status})
            assert advanced.status_code == 200
        assert client.get(f"/api/cases/{case_id}").json()["state"] == "REFUNDED"

        chat = client.post("/api/chat", json={
            "message": "Can I return this?", "order_id": "NS-DEMO-1001",
            "issue": "defective", "condition": "opened", "accessories_complete": True,
        }).json()
        assert chat["provider"] == "deterministic_fake_tool_simulation"
        assert chat["agent_status"] == "fake"
        assert chat["tool_calls"] == [{"name": "check_return_options", "arguments": {
            "order_id": "NS-DEMO-1001", "issue": "defective", "condition": "opened",
            "accessories_complete": True,
        }}]
        assert chat["tool_results"] == []
        assert chat["mcp_transport"] == "Streamable HTTP"
        assert "MCP tool" in chat["reply"]
        assert chat["model_can_approve"] is False

        # A distinct idempotency key and new case cannot return the same item twice.
        another = client.post("/api/cases", json={"order_id": "NS-DEMO-1001", "receipt_reviewed": True}).json()
        second_offer = client.post(f"/api/cases/{another['case_id']}/offers").json()["case"]
        second_option = second_offer["offer"]["options"][0]
        second_approval = client.post(f"/api/cases/{another['case_id']}/approve", json={
            "offer_id": second_offer["offer"]["offer_id"],
            "terms_hash": second_option["terms_hash"],
            "expected_revision": second_offer["revision"],
        }).json()["approval"]["approval_id"]
        duplicate = client.post(f"/api/cases/{another['case_id']}/submit", json={
            "approval_id": second_approval, "idempotency_key": "a-different-return-key"
        })
        assert duplicate.status_code == 409
        assert "already has" in duplicate.text


def test_chat_forwards_bounded_multiturn_history_but_python_owns_policy(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    seen = {}

    class LocalSelectorStub:
        provider_id = "ollama_local_tool_selector"

        async def select_tool(self, message, history):
            seen["message"] = message
            seen["history"] = history
            return Selection(CHECK_RETURN_OPTIONS, "ollama")

    monkeypatch.setattr(main, "MODEL", LocalSelectorStub())
    history = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": f"turn {index}"}
        for index in range(16)
    ]
    with TestClient(main.app) as client:
        response = client.post("/api/chat", json={
            "message": "What are the return options?", "order_id": "NS-DEMO-1001",
            "issue": "defective", "condition": "opened", "accessories_complete": True,
            "history": history,
        })
        assert response.status_code == 200
        result = response.json()
        assert seen == {"message": "What are the return options?", "history": history}
        assert result["provider"] == "ollama_local_tool_selector"
        assert result["agent_status"] == "model"
        assert result["tool_calls"][0]["name"] == CHECK_RETURN_OPTIONS
        assert result["tool_results"] == []
        assert "MCP tool" in result["reply"]
        assert result["model_can_approve"] is False


def test_chat_selects_persisted_proposal_only_for_explicit_prepare_intent(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(main.app) as client:
        proposal = client.post("/api/chat", json={
            "message": "Prepare a return proposal for this sample order.", "order_id": "NS-DEMO-1001",
            "issue": "defective", "condition": "opened", "accessories_complete": True,
            "receipt_reviewed": True, "delivery_date_override": "2026-09-08",
        })
        assert proposal.status_code == 200
        result = proposal.json()
        assert result["tool_calls"][0]["name"] == "prepare_return_proposal"
        arguments = result["tool_calls"][0]["arguments"]
        assert arguments["receipt_reviewed"] is True
        assert arguments["order_id"] == "NS-DEMO-1001"
        assert arguments["delivery_date_override"] == "2026-09-08"
        assert arguments["idempotency_key"].startswith("proposal_")
        assert result["proposal_tool_available_after_explicit_user_intent"] is True
        assert result["submit_tool_available_after_server_verified_user_approval"] is True
        assert "cannot submit" in result["reply"].lower()

        advice = client.post("/api/chat", json={
            "message": "What return options do I have?", "order_id": "NS-DEMO-1001",
            "accessories_complete": True, "receipt_reviewed": True,
        }).json()
        assert advice["tool_calls"][0]["name"] == "check_return_options"
        assert client.get("/api/demo").json()["cases"] == []

        history = [
            {"role": "user" if index % 2 == 0 else "assistant", "content": f"turn {index}"}
            for index in range(16)
        ]
        too_many = client.post("/api/chat", json={
            "message": "What is this?", "order_id": "NS-DEMO-1001",
            "history": history + [{"role": "user", "content": "extra"}],
        })
        assert too_many.status_code == 422


def test_chat_cannot_approve_or_submit_even_when_model_has_no_tool_call(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")

    class FallbackSelector:
        provider_id = "ollama_local_tool_selector"

        async def select_tool(self, _message, _history):
            return Selection("get_sample_order", "fallback", "no_single_tool_call")

    monkeypatch.setattr(main, "MODEL", FallbackSelector())
    with TestClient(main.app) as client:
        result = client.post("/api/chat", json={
            "message": "Can you approve and submit it for me?", "order_id": "NS-DEMO-1001",
        }).json()
        assert result["agent_status"] == "fallback"
        assert "cannot approve or submit" in result["reply"]
        assert result["model_can_approve_or_submit"] is False
        assert result["tool_calls"][0]["name"] == "get_sample_order"
        assert client.get("/api/demo").json()["cases"] == []


def test_missing_delivery_date_stays_review_only(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    main.init_db()
    with TestClient(main.app) as client:
        case_id = client.post("/api/cases", json={"order_id": "NS-DEMO-1003", "receipt_reviewed": True}).json()["case_id"]
        response = client.post(f"/api/cases/{case_id}/offers").json()
        assert response["eligibility"]["status"] == "needs_review"
        assert response["eligibility"]["deadline_at"] is None
        assert response["case"]["offer"] is None
        assert response["case"]["state"] == "NEEDS_INFO"
        assert client.get(f"/api/cases/{case_id}").json()["eligibility_result"]["reason_codes"] == ["MISSING_DELIVERY_DATE"]


def test_accessories_must_be_explicitly_confirmed(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    main.init_db()
    with TestClient(main.app) as client:
        case_id = client.post("/api/cases", json={
            "order_id": "NS-DEMO-1001", "accessories_complete": False, "receipt_reviewed": True
        }).json()["case_id"]
        response = client.post(f"/api/cases/{case_id}/offers").json()
        assert response["eligibility"]["status"] == "needs_review"
        assert response["eligibility"]["reason_codes"] == ["ACCESSORIES_MISSING"]
        assert response["eligibility"]["options"] == []
        assert response["case"]["offer"] is None


def test_case_is_recovered_after_app_lifespan_restarts(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(main.app) as first_process:
        created = first_process.post("/api/cases", json={"order_id": "NS-DEMO-1001", "receipt_reviewed": True})
        assert created.status_code == 200
        case_id = created.json()["case_id"]

    with TestClient(main.app) as restarted_process:
        reopened = restarted_process.get(f"/api/cases/{case_id}")
        assert reopened.status_code == 200
        assert reopened.json()["state"] == "DRAFT"
        assert reopened.json()["order_id"] == "NS-DEMO-1001"
        assert reopened.json()["timeline"][0]["event_type"] == "CASE_CREATED"


def test_receipt_review_is_required_and_corrected_date_is_used(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(main.app) as client:
        unreviewed = client.post("/api/cases", json={"order_id": "NS-DEMO-1003"})
        assert unreviewed.status_code == 409
        assert "RECEIPT_REVIEW_REQUIRED" in unreviewed.text

        missing = client.post("/api/cases", json={"order_id": "NS-DEMO-1003", "receipt_reviewed": True}).json()
        missing_offer = client.post(f"/api/cases/{missing['case_id']}/offers").json()
        assert missing_offer["eligibility"]["reason_codes"] == ["MISSING_DELIVERY_DATE"]

        corrected = client.post("/api/cases", json={
            "order_id": "NS-DEMO-1003", "receipt_reviewed": True,
            "delivery_date_override": "2026-09-08",
        }).json()
        assert corrected["order_evidence"]["delivery_date"] == "2026-09-08"
        assert "delivery_date" in corrected["order_evidence"]["verified_fields"]
        corrected_offer = client.post(f"/api/cases/{corrected['case_id']}/offers").json()
        assert corrected_offer["eligibility"]["status"] == "eligible"

        cleared = client.post("/api/cases", json={
            "order_id": "NS-DEMO-1001", "receipt_reviewed": True, "delivery_date_override": None,
        }).json()
        assert cleared["order_evidence"]["delivery_date"] is None
        assert "delivery_date" not in cleared["order_evidence"]["verified_fields"]
        cleared_offer = client.post(f"/api/cases/{cleared['case_id']}/offers").json()
        assert cleared_offer["eligibility"]["reason_codes"] == ["MISSING_DELIVERY_DATE"]


def test_chat_policy_tool_uses_only_reviewed_receipt_override(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(main.app) as client:
        base = {"message": "Can I return this?", "order_id": "NS-DEMO-1003",
                "issue": "defective", "condition": "opened", "accessories_complete": True}
        missing = client.post("/api/chat", json=base).json()
        assert missing["tool_results"] == []
        corrected = client.post("/api/chat", json={**base, "delivery_date_override": "2026-09-08"}).json()
        assert corrected["tool_results"] == []
        assert corrected["tool_calls"][0]["arguments"]["delivery_date_override"] == "2026-09-08"


def test_expired_offer_is_rejected_and_refresh_needs_fresh_approval(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(main.app) as client:
        case = client.post("/api/cases", json={"order_id": "NS-DEMO-1001", "receipt_reviewed": True}).json()
        case_id = case["case_id"]
        first_offer = client.post(f"/api/cases/{case_id}/offers").json()["case"]["offer"]
        option = first_offer["options"][0]
        with main.connect() as db:
            expired = {**first_offer, "expires_at": "2000-01-01T00:00:00+00:00"}
            db.execute("UPDATE cases SET offer_json=? WHERE case_id=?", (main.json.dumps(expired), case_id))

        expired_approval = client.post(f"/api/cases/{case_id}/approve", json={
            "offer_id": first_offer["offer_id"], "terms_hash": option["terms_hash"],
            "expected_revision": case["revision"],
        })
        assert expired_approval.status_code == 409
        assert "OFFER_EXPIRED" in expired_approval.text
        assert client.get(f"/api/cases/{case_id}").json()["approval"] is None

        fresh_case = client.post(f"/api/cases/{case_id}/offers").json()["case"]
        assert fresh_case["offer"]["offer_id"] != first_offer["offer_id"]
        assert fresh_case["approval"] is None
        fresh_option = fresh_case["offer"]["options"][0]
        approval = client.post(f"/api/cases/{case_id}/approve", json={
            "offer_id": fresh_case["offer"]["offer_id"], "terms_hash": fresh_option["terms_hash"],
            "expected_revision": fresh_case["revision"],
        })
        assert approval.status_code == 200


def test_assistant_submission_requires_current_saved_approval_and_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(main.app) as client:
        created = client.post("/api/cases", json={"order_id": "NS-DEMO-1001", "receipt_reviewed": True}).json()
        case_id = created["case_id"]
        message = "Please submit the approved return."
        payload = {"message": message, "order_id": "NS-DEMO-1001", "case_id": case_id}
        no_approval = client.post("/api/chat", json=payload).json()
        assert no_approval["tool_calls"] == []
        assert client.get(f"/api/cases/{case_id}").json()["return"] is None

        offer = client.post(f"/api/cases/{case_id}/offers").json()["case"]
        choice = offer["offer"]["options"][0]
        approved = client.post(f"/api/cases/{case_id}/approve", json={
            "offer_id": offer["offer"]["offer_id"], "terms_hash": choice["terms_hash"],
            "expected_revision": offer["revision"],
        }).json()
        request = client.post("/api/chat", json=payload).json()
        assert request["tool_calls"][0]["name"] == "submit_simulated_return"
        args = request["tool_calls"][0]["arguments"]
        assert args["approval_id"] == approved["approval"]["approval_id"]
        assert "idempotency_key" in args
        result = client.post(f"/api/cases/{case_id}/submit", json={
            "approval_id": args["approval_id"], "idempotency_key": args["idempotency_key"],
        }).json()
        assert result["state"] == "AWAITING_DROPOFF"
        replay = client.post("/api/chat", json=payload).json()
        assert replay["tool_calls"] == []
        assert client.get(f"/api/cases/{case_id}").json()["return"]["return_id"] == result["return_id"]


def test_assistant_refuses_an_expired_approved_offer(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")
    with TestClient(main.app) as client:
        created = client.post("/api/cases", json={"order_id": "NS-DEMO-1001", "receipt_reviewed": True}).json()
        case_id = created["case_id"]
        offer = client.post(f"/api/cases/{case_id}/offers").json()["case"]
        choice = offer["offer"]["options"][0]
        client.post(f"/api/cases/{case_id}/approve", json={
            "offer_id": offer["offer"]["offer_id"], "terms_hash": choice["terms_hash"],
            "expected_revision": offer["revision"],
        })
        expired = {**offer["offer"], "expires_at": "2000-01-01T00:00:00+00:00"}
        with main.connect() as db:
            db.execute("UPDATE cases SET offer_json=? WHERE case_id=?", (main.json.dumps(expired), case_id))
        result = client.post("/api/chat", json={
            "message": "Please submit the approved return.", "order_id": "NS-DEMO-1001", "case_id": case_id,
        }).json()
        assert result["tool_calls"] == []
        assert "expired" in result["reply"].lower()
        assert client.get(f"/api/cases/{case_id}").json()["return"] is None


@pytest.mark.parametrize("message", [
    "Send return instructions.", "Confirm the deadline for my return.",
    "Submit the approved return?", "Submit the approved return tomorrow.",
])
def test_model_cannot_turn_ambiguous_chat_into_approved_submission(tmp_path, monkeypatch, message):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")

    class OvereagerSelector:
        provider_id = "test_local_selector"

        async def select_tool(self, _message, _history):
            return Selection("submit_simulated_return", "fake")

    monkeypatch.setattr(main, "MODEL", OvereagerSelector())
    with TestClient(main.app) as client:
        created = client.post("/api/cases", json={"order_id": "NS-DEMO-1001", "receipt_reviewed": True}).json()
        case_id = created["case_id"]
        offered = client.post(f"/api/cases/{case_id}/offers").json()["case"]
        approved = client.post(f"/api/cases/{case_id}/approve", json={
            "offer_id": offered["offer"]["offer_id"],
            "terms_hash": offered["offer"]["options"][0]["terms_hash"],
            "expected_revision": offered["revision"],
        }).json()
        result = client.post("/api/chat", json={
            "message": message, "order_id": "NS-DEMO-1001", "case_id": case_id,
        }).json()
        assert all(call["name"] != "submit_simulated_return" for call in result["tool_calls"])
        current = client.get(f"/api/cases/{case_id}").json()
        assert current["state"] == "AWAITING_APPROVAL"
        assert current["return"] is None
        assert current["approval"] == approved["approval"]
        assert current["timeline"] == approved["timeline"]


@pytest.mark.parametrize("message", [
    "Do not prepare a return proposal.", "How do I start a return?", "Prepare a return proposal?",
])
def test_model_cannot_create_proposal_from_negation_or_question(tmp_path, monkeypatch, message):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "cases.sqlite3")

    class OvereagerSelector:
        provider_id = "test_local_selector"

        async def select_tool(self, _message, _history):
            return Selection("prepare_return_proposal", "fake")

    monkeypatch.setattr(main, "MODEL", OvereagerSelector())
    with TestClient(main.app) as client:
        result = client.post("/api/chat", json={
            "message": message, "order_id": "NS-DEMO-1001", "receipt_reviewed": True,
        }).json()
        assert result["tool_calls"][0]["name"] == "check_return_options"
        assert client.get("/api/demo").json()["cases"] == []

