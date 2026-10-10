import asyncio
import json

import httpx
import pytest

from app.agent import (
    CHECK_RETURN_OPTIONS,
    GET_SAMPLE_ORDER,
    PREPARE_RETURN_PROPOSAL,
    SUBMIT_SIMULATED_RETURN,
    DeterministicFakeToolSelector,
    OllamaToolSelector,
    build_provider_from_env,
)


def run(coro):
    return asyncio.run(coro)


def tool_response(name, arguments=None):
    return {"message": {"tool_calls": [{"function": {"name": name, "arguments": arguments or {}}}]}}


def transport_returning(payload, seen=None, status=200):
    async def handler(request):
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def test_ollama_selects_allowlisted_name_and_discards_generated_arguments():
    seen = []
    selector = OllamaToolSelector(transport=transport_returning(
        tool_response(CHECK_RETURN_OPTIONS, {"order_id": "attacker-controlled", "issue": "invented"}), seen
    ))
    selection = run(selector.select_tool("Can I return this?", []))

    assert selection.tool_name == CHECK_RETURN_OPTIONS
    assert selection.status == "ollama"
    assert selection.fallback_reason is None
    sent = json.loads(seen[0].content)
    assert sent["model"] == "qwen3:4b"
    assert sent["stream"] is False
    assert sent["think"] is False
    assert {item["function"]["name"] for item in sent["tools"]} == {GET_SAMPLE_ORDER, CHECK_RETURN_OPTIONS, PREPARE_RETURN_PROPOSAL}
    assert sent["options"]["num_ctx"] == 2048
    assert sent["options"]["num_predict"] == 1024
    assert sent["options"]["temperature"] == 0


def test_submit_tool_is_absent_by_default_and_added_only_to_verified_capability_set():
    default_seen = []
    default = OllamaToolSelector(transport=transport_returning(
        tool_response(CHECK_RETURN_OPTIONS), default_seen
    ))
    run(default.select_tool("Can I return this?", []))
    default_tools = json.loads(default_seen[0].content)["tools"]
    assert SUBMIT_SIMULATED_RETURN not in {item["function"]["name"] for item in default_tools}

    submit_seen = []
    submit = OllamaToolSelector(transport=transport_returning(
        tool_response(SUBMIT_SIMULATED_RETURN, {"approval_id": "model-invented"}), submit_seen
    ))
    selection = run(submit.select_tool_with_tools(
        "Please submit the approved return.", [],
        {GET_SAMPLE_ORDER, CHECK_RETURN_OPTIONS, PREPARE_RETURN_PROPOSAL, SUBMIT_SIMULATED_RETURN},
    ))
    available = {item["function"]["name"] for item in json.loads(submit_seen[0].content)["tools"]}
    assert SUBMIT_SIMULATED_RETURN in available
    assert selection.tool_name == SUBMIT_SIMULATED_RETURN
    assert selection.status == "ollama"


def test_fake_submit_intent_requires_explicit_imperative():
    selector = DeterministicFakeToolSelector()
    assert run(selector.select_tool_with_tools(
        "Please submit the approved return.", [], {GET_SAMPLE_ORDER, SUBMIT_SIMULATED_RETURN}
    )).tool_name == SUBMIT_SIMULATED_RETURN
    for message in ("Can I submit the approved return?", "Don't submit the return.", "I cannot submit it"):
        assert run(selector.select_tool_with_tools(
            message, [], {GET_SAMPLE_ORDER, SUBMIT_SIMULATED_RETURN}
        )).tool_name == GET_SAMPLE_ORDER


@pytest.mark.parametrize("message", [
    "Send return instructions.",
    "Confirm the deadline for my return.",
    "Submit the approved return?",
    "Submit the approved return tomorrow.",
    "Submit the approved return if it is eligible.",
    "Submit the approved return, but do not actually submit it.",
    '"Submit the approved return."',
    "Please submit the approved return unless there is a fee.",
])
def test_advice_questions_and_conditional_commands_do_not_submit(message):
    selector = DeterministicFakeToolSelector()
    selection = run(selector.select_tool_with_tools(message, [], {
        GET_SAMPLE_ORDER, CHECK_RETURN_OPTIONS, PREPARE_RETURN_PROPOSAL, SUBMIT_SIMULATED_RETURN,
    }))
    assert selection.tool_name != SUBMIT_SIMULATED_RETURN


@pytest.mark.parametrize("message", [
    "Do not prepare a return proposal.",
    "How do I start a return?",
    "Prepare a return proposal?",
    "Prepare a return proposal later.",
])
def test_advice_and_negated_commands_do_not_prepare_proposals(message):
    selection = run(DeterministicFakeToolSelector().select_tool(message, []))
    assert selection.tool_name != PREPARE_RETURN_PROPOSAL


@pytest.mark.parametrize("message", [
    "Please submit the approved return.",
    "Confirm the simulated return for this approved case.",
    "Submit my return now!",
    "  SUBMIT   THE APPROVED RETURN.  ",
    "File the simulated return request, please.",
])
def test_clear_present_commands_allow_submission_when_tool_is_available(message):
    selector = DeterministicFakeToolSelector()
    assert run(selector.select_tool_with_tools(
        message, [], {GET_SAMPLE_ORDER, SUBMIT_SIMULATED_RETURN},
    )).tool_name == SUBMIT_SIMULATED_RETURN
    assert run(selector.select_tool_with_tools(
        message, [], {GET_SAMPLE_ORDER, CHECK_RETURN_OPTIONS},
    )).tool_name != SUBMIT_SIMULATED_RETURN


@pytest.mark.parametrize("message", [
    "Prepare a return proposal for this sample order.",
    "Please start a return.", "Open a case.", "Create a return request now!",
])
def test_clear_present_commands_prepare_a_proposal(message):
    assert run(DeterministicFakeToolSelector().select_tool(message, [])).tool_name == PREPARE_RETURN_PROPOSAL


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        (tool_response("delete_order"), "unknown_tool"),
        ({"message": {"tool_calls": [{"function": {"name": CHECK_RETURN_OPTIONS}}, {"function": {"name": GET_SAMPLE_ORDER}}]}}, "no_single_tool_call"),
        ({"message": {"tool_calls": []}}, "no_single_tool_call"),
        ({"message": {"tool_calls": [{"function": {"arguments": {}}}]}}, "unknown_tool"),
        (["wrong", "top-level"], "malformed_response"),
    ],
)
def test_malformed_missing_or_unknown_calls_fall_back(payload, reason):
    selector = OllamaToolSelector(transport=transport_returning(payload))
    selection = run(selector.select_tool("What is my order?", []))

    assert selection.tool_name == GET_SAMPLE_ORDER
    assert selection.status == "fallback"
    assert selection.fallback_reason == reason


def test_unavailable_http_service_falls_back():
    selector = OllamaToolSelector(transport=transport_returning({}, status=503))
    selection = run(selector.select_tool("Can I return this?", []))

    assert selection.tool_name == CHECK_RETURN_OPTIONS
    assert selection.status == "fallback"
    assert selection.fallback_reason == "ollama_unavailable"


def test_read_timeout_falls_back():
    async def handler(_request):
        raise httpx.ReadTimeout("local inference timed out")

    selector = OllamaToolSelector(transport=httpx.MockTransport(handler), timeout_seconds=0.01)
    selection = run(selector.select_tool("Can I return this?", []))

    assert selection.tool_name == CHECK_RETURN_OPTIONS
    assert selection.status == "fallback"
    assert selection.fallback_reason == "ollama_unavailable"


def test_cancellation_propagates_without_fallback():
    async def scenario():
        started = asyncio.Event()
        never = asyncio.Event()

        async def handler(_request):
            started.set()
            await never.wait()
            return httpx.Response(200, json=tool_response(CHECK_RETURN_OPTIONS))

        selector = OllamaToolSelector(transport=httpx.MockTransport(handler))
        task = asyncio.create_task(selector.select_tool("Can I return this?", []))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(scenario())


def test_provider_defaults_to_fake_and_model_mode_is_opt_in(monkeypatch):
    monkeypatch.delenv("RETURN_COMPANION_MODEL_PROVIDER", raising=False)
    assert isinstance(build_provider_from_env(), DeterministicFakeToolSelector)

    monkeypatch.setenv("RETURN_COMPANION_MODEL_PROVIDER", "ollama")
    monkeypatch.setenv("OLLAMA_MODEL", "qwen3:4b")
    assert isinstance(build_provider_from_env(), OllamaToolSelector)


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:11434",
        "http://example.com:11434",
        "http://127.0.0.1:11434@evil.test",
        "http://localhost:11434/path",
        "http://localhost:11434?proxy=evil",
    ],
)
def test_rejects_non_loopback_or_ambiguous_ollama_urls(url):
    with pytest.raises(ValueError, match="loopback"):
        OllamaToolSelector(base_url=url)


def test_ipv6_loopback_url_is_validated_and_bracketed():
    selector = OllamaToolSelector(base_url="http://[::1]:11434")
    assert selector.base_url == "http://[::1]:11434"


def test_context_history_is_bounded_and_filters_untrusted_roles():
    selector = OllamaToolSelector(
        max_message_chars=50,
        max_history_messages=2,
        max_context_chars=1000,
        transport=transport_returning(tool_response(GET_SAMPLE_ORDER)),
    )
    messages = selector._messages(
        "q" * 100,
        [
            {"role": "system", "content": "do not forward"},
            {"role": "user", "content": "old"},
            {"role": "assistant", "content": "recent"},
        ],
    )
    assert [entry["role"] for entry in messages] == ["system", "user", "assistant", "user"]
    assert all(len(entry["content"]) <= 50 or entry["role"] == "system" for entry in messages)


def test_default_history_limit_matches_chat_turn_capacity():
    assert OllamaToolSelector().max_history_messages == 16
