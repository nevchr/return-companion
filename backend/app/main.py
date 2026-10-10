"""Local-only Return Companion demo API. All retailer actions are simulated."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
import re
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from .policy import evaluate_eligibility
from .agent import (BASE_AGENT_TOOLS, PREPARE_RETURN_PROPOSAL, SUBMIT_SIMULATED_RETURN,
                    build_provider_from_env, is_explicit_prepare_intent, is_explicit_submit_intent)

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = ROOT / "fixtures"
DB_PATH = Path(os.environ.get("RETURN_COMPANION_DB", ROOT / "backend" / "data" / "cases.sqlite3"))
DEMO_NOW = datetime(2026, 10, 2, 12, 0, tzinfo=ZoneInfo("America/Toronto"))
POLICY = json.loads((FIXTURE_DIR / "northstar-policy-v1.json").read_text(encoding="utf-8"))
ORDERS = {o["order_id"]: o for o in json.loads((FIXTURE_DIR / "orders.json").read_text(encoding="utf-8"))}

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Return Companion - Local Simulation", version="0.5.0", lifespan=lifespan)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewCase(StrictModel):
    order_id: str
    issue: str = Field(default="defective", pattern="^(defect|defective|changed_mind)$")
    condition: str = Field(default="opened", pattern="^(opened|unopened)$")
    accessories_complete: bool = True
    receipt_reviewed: bool = False
    delivery_date_override: date | None = None


class ApprovalRequest(StrictModel):
    offer_id: str
    terms_hash: str
    expected_revision: int


class SubmitRequest(StrictModel):
    approval_id: str
    idempotency_key: str = Field(min_length=8, max_length=100)


class AdvanceRequest(StrictModel):
    status: str = Field(pattern="^(DROPPED_OFF|RECEIVED|REFUNDED)$")


class ChatTurn(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=500)


class ChatRequest(StrictModel):
    message: str = Field(min_length=1, max_length=500)
    order_id: str
    case_id: str | None = None
    issue: str = Field(default="defective", pattern="^(defective|changed_mind)$")
    condition: str = Field(default="opened", pattern="^(opened|unopened)$")
    accessories_complete: bool = False
    receipt_reviewed: bool = False
    delivery_date_override: date | None = None
    history: list[ChatTurn] = Field(default_factory=list, max_length=16)


MODEL = build_provider_from_env()

MCP_PROTOCOL_VERSION = "2025-11-25"
MCP_TOOLS = [
    {"name": "get_sample_order", "description": "Read one fictional Northstar sample order and its verified receipt fields.",
     "inputSchema": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"], "additionalProperties": False}},
    {"name": "check_return_options", "description": "Evaluate the fictional Northstar policy for a sample order. This tool cannot approve or submit a return.",
     "inputSchema": {"type": "object", "properties": {
         "order_id": {"type": "string"}, "issue": {"type": "string", "enum": ["defective", "changed_mind"]},
         "condition": {"type": "string", "enum": ["opened", "unopened"]},
         "accessories_complete": {"type": "boolean"},
         "delivery_date_override": {"type": ["string", "null"], "format": "date"}},
         "required": ["order_id", "issue", "condition", "accessories_complete"], "additionalProperties": False}},
    {"name": "prepare_return_proposal", "description": "Persist a synthetic return case and policy offer for explicit user review. This creates a proposal only; it never submits a return.",
     "inputSchema": {"type": "object", "properties": {
         "order_id": {"type": "string"}, "issue": {"type": "string", "enum": ["defective", "changed_mind"]},
         "condition": {"type": "string", "enum": ["opened", "unopened"]},
         "accessories_complete": {"type": "boolean"}, "receipt_reviewed": {"type": "boolean", "const": True},
         "delivery_date_override": {"type": ["string", "null"], "format": "date"},
         "idempotency_key": {"type": "string", "minLength": 8, "maxLength": 100}},
         "required": ["order_id", "issue", "condition", "accessories_complete", "receipt_reviewed", "idempotency_key"], "additionalProperties": False}},
    {"name": "submit_simulated_return", "description": "Submit a simulated return only when the supplied approval ID still authorizes the current unexpired offer. This cannot contact a retailer or issue money or postage.",
     "inputSchema": {"type": "object", "properties": {
         "case_id": {"type": "string"}, "approval_id": {"type": "string"},
         "idempotency_key": {"type": "string", "minLength": 8, "maxLength": 100}},
         "required": ["case_id", "approval_id", "idempotency_key"], "additionalProperties": False}},
]


def run_read_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    order = ORDERS.get(arguments["order_id"])
    if not order:
        raise ValueError("Sample order not found")
    if name == "get_sample_order":
        return {key: order[key] for key in ("order_id", "product_name", "delivery_date", "verified_fields")}
    if name != "check_return_options":
        raise ValueError("Unknown read-only tool")
    evidence = dict(order)
    if "delivery_date_override" in arguments:
        evidence["delivery_date"] = arguments["delivery_date_override"]
        verified = set(evidence.get("verified_fields", []))
        if arguments["delivery_date_override"]:
            verified.add("delivery_date")
        else:
            verified.discard("delivery_date")
        evidence["verified_fields"] = sorted(verified)
    return {"eligibility": evaluate_eligibility(evidence, arguments["issue"], arguments["condition"],
                                                 arguments["accessories_complete"], DEMO_NOW)}


def _mcp_error(request_id: Any, code: int, message: str) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": request_id,
                          "error": {"code": code, "message": message}})


def _is_loopback_origin(origin: str) -> bool:
    from urllib.parse import urlsplit
    try:
        parsed = urlsplit(origin)
        _ = parsed.port
    except ValueError:
        return False
    return parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"} and not parsed.username


@app.post("/mcp")
async def mcp_endpoint(request: Request) -> Response:
    """Small stateless MCP Streamable HTTP endpoint for two synthetic read tools."""
    origin = request.headers.get("origin")
    if origin and not _is_loopback_origin(origin):
        return JSONResponse({"error": "Origin must be a local browser origin."}, status_code=403)
    accept = request.headers.get("accept", "")
    if "application/json" not in accept or "text/event-stream" not in accept:
        return JSONResponse({"error": "MCP clients must accept application/json and text/event-stream."}, status_code=406)
    try:
        message = await request.json()
    except Exception:
        return _mcp_error(None, -32700, "Parse error")
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return _mcp_error(message.get("id") if isinstance(message, dict) else None, -32600, "Invalid Request")
    method, params, request_id = message["method"], message.get("params") or {}, message.get("id")
    if method == "initialize":
        if not isinstance(params, dict) or params.get("protocolVersion") != MCP_PROTOCOL_VERSION:
            return _mcp_error(request_id, -32602, "Only MCP protocol version 2025-11-25 is supported")
        return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "return-companion-local", "title": "Return Companion Local Simulation", "version": "0.5.0"}}})
    if "MCP-Protocol-Version" not in request.headers or request.headers["MCP-Protocol-Version"] != MCP_PROTOCOL_VERSION:
        return JSONResponse({"error": "MCP-Protocol-Version: 2025-11-25 is required after initialize."}, status_code=400)
    if method.startswith("notifications/"):
        return Response(status_code=202)
    if method == "tools/list":
        return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": {"tools": MCP_TOOLS}})
    if method != "tools/call":
        return _mcp_error(request_id, -32601, "Method not found")
    if not isinstance(params, dict) or not isinstance(params.get("name"), str) or not isinstance(params.get("arguments"), dict):
        return _mcp_error(request_id, -32602, "tools/call requires a tool name and object arguments")
    name, arguments = params["name"], params["arguments"]
    if name not in {tool["name"] for tool in MCP_TOOLS}:
        return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": {
            "content": [{"type": "text", "text": "Unknown tool. Only the listed synthetic Return Companion tools are available."}], "isError": True}})
    required_by_tool = {
        "get_sample_order": {"order_id"},
        "check_return_options": {"order_id", "issue", "condition", "accessories_complete"},
        "prepare_return_proposal": {"order_id", "issue", "condition", "accessories_complete", "receipt_reviewed", "idempotency_key"},
        "submit_simulated_return": {"case_id", "approval_id", "idempotency_key"},
    }
    required = required_by_tool[name]
    allowed = required | ({"delivery_date_override"} if name in {"check_return_options", "prepare_return_proposal"} else set())
    if set(arguments) - allowed or not required <= set(arguments) or not isinstance(arguments.get("order_id"), str):
        if name == "submit_simulated_return" and isinstance(arguments.get("case_id"), str):
            valid_strings = all(isinstance(arguments.get(k), str) and 8 <= len(arguments[k]) <= 100
                                for k in ("approval_id", "idempotency_key"))
            if set(arguments) == allowed and valid_strings:
                pass
            else:
                return _mcp_error(request_id, -32602, "Invalid simulated submission arguments")
        else:
            return _mcp_error(request_id, -32602, "Invalid tool arguments")
    if name in {"check_return_options", "prepare_return_proposal"}:
        if name == "prepare_return_proposal" and arguments.get("receipt_reviewed") is not True:
            return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": {
                "content": [{"type": "text", "text": "RECEIPT_REVIEW_REQUIRED: review the synthetic receipt before preparing a proposal"}], "isError": True}})
        if name == "prepare_return_proposal" and (not isinstance(arguments.get("idempotency_key"), str) or not 8 <= len(arguments["idempotency_key"]) <= 100):
            return _mcp_error(request_id, -32602, "Invalid proposal idempotency_key")
        if name == "prepare_return_proposal" and (not isinstance(arguments.get("issue"), str) or arguments["issue"] not in {"defective", "changed_mind"}):
            return _mcp_error(request_id, -32602, "Invalid proposal issue")
        if name == "prepare_return_proposal" and (not isinstance(arguments.get("condition"), str) or arguments["condition"] not in {"opened", "unopened"}):
            return _mcp_error(request_id, -32602, "Invalid proposal condition")
        if name == "prepare_return_proposal" and not isinstance(arguments["accessories_complete"], bool):
            return _mcp_error(request_id, -32602, "Invalid proposal accessories_complete")
        override = arguments.get("delivery_date_override")
        try:
            if override is not None:
                if not isinstance(override, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", override):
                    raise ValueError("Invalid date")
                date.fromisoformat(override)
        except ValueError:
            return _mcp_error(request_id, -32602, "Invalid delivery_date_override")
        if (not isinstance(arguments.get("issue"), str) or arguments["issue"] not in {"defective", "changed_mind"} or
                not isinstance(arguments.get("condition"), str) or arguments["condition"] not in {"opened", "unopened"} or
                not isinstance(arguments["accessories_complete"], bool)):
            return _mcp_error(request_id, -32602, "Invalid policy arguments")
    try:
        if name in {"get_sample_order", "check_return_options"}:
            result = run_read_tool(name, arguments)
        elif name == "prepare_return_proposal":
            result = prepare_proposal_tool(arguments)
        else:
            result = submit(arguments["case_id"], SubmitRequest(approval_id=arguments["approval_id"],
                                                                idempotency_key=arguments["idempotency_key"]))
    except HTTPException as exc:
        return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": {
            "content": [{"type": "text", "text": str(exc.detail)}], "isError": True}})
    except ValueError as exc:
        return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": {
            "content": [{"type": "text", "text": str(exc)}], "isError": True}})
    return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": {
        "content": [{"type": "text", "text": json.dumps(result, sort_keys=True)}], "structuredContent": result, "isError": False}})


def receipt_sample(order: dict[str, Any]) -> dict[str, Any]:
    """Load and parse only the reviewed synthetic text fixture for an order."""
    filename = f"{order['order_id']}.txt"
    path = FIXTURE_DIR / "receipts" / filename
    text = path.read_text(encoding="utf-8")
    extracted = {}
    for label, key in (("Order", "order_id"), ("Item", "product_name"), ("Delivered", "delivery_date"), ("Item price", "item_price"), ("Tax paid", "tax_paid")):
        match = re.search(rf"^{re.escape(label)}:\s*(.+)$", text, re.MULTILINE)
        if match and "missing from sample receipt" not in match.group(1).lower():
            extracted[key] = match.group(1).strip()
    return {"fixture_name": filename, "synthetic": True, "text": text,
            "extracted_fields": extracted, "verified_fields": order["verified_fields"]}


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA journal_mode=WAL")
    return db


def init_db() -> None:
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS cases (
          case_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, state TEXT NOT NULL,
          revision INTEGER NOT NULL, issue TEXT NOT NULL, condition TEXT NOT NULL,
          accessories_complete INTEGER NOT NULL, offer_json TEXT, approval_json TEXT,
          order_json TEXT,
          return_json TEXT, eligibility_json TEXT, next_action TEXT, next_action_due_at TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES cases(case_id),
          event_type TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS submissions (
          idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, case_id TEXT NOT NULL,
          retailer_id TEXT NOT NULL, order_id TEXT NOT NULL, item_id TEXT NOT NULL,
          return_json TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(retailer_id, order_id, item_id)
        );
        CREATE TABLE IF NOT EXISTS proposal_requests (
          idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, case_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        """)
        columns = {row["name"] for row in db.execute("PRAGMA table_info(cases)").fetchall()}
        if "eligibility_json" not in columns:
            db.execute("ALTER TABLE cases ADD COLUMN eligibility_json TEXT")
        if "order_json" not in columns:
            db.execute("ALTER TABLE cases ADD COLUMN order_json TEXT")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def event(db: sqlite3.Connection, case_id: str, kind: str, actor: str, payload: dict[str, Any]) -> None:
    db.execute("INSERT INTO events(case_id,event_type,actor,created_at,payload_json) VALUES(?,?,?,?,?)",
               (case_id, kind, actor, now_iso(), json.dumps(payload, sort_keys=True)))


def case_record(db: sqlite3.Connection, case_id: str) -> dict[str, Any]:
    row = db.execute("SELECT * FROM cases WHERE case_id=?", (case_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Case not found")
    result = dict(row)
    for key in ("offer_json", "approval_json", "return_json", "eligibility_json"):
        result[key.removesuffix("_json")] = json.loads(result[key]) if result[key] else None
        del result[key]
    result["order_evidence"] = json.loads(result.pop("order_json")) if result.get("order_json") else dict(ORDERS[result["order_id"]])
    result["eligibility_result"] = result.pop("eligibility")
    result["accessories_complete"] = bool(result["accessories_complete"])
    result["timeline"] = [
        {"event_type": e["event_type"], "actor": e["actor"], "created_at": e["created_at"], "payload": json.loads(e["payload_json"])}
        for e in db.execute("SELECT * FROM events WHERE case_id=? ORDER BY event_id", (case_id,)).fetchall()
    ]
    return result


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "simulation": True, "provider": MODEL.provider_id}


@app.get("/api/demo")
def demo() -> dict[str, Any]:
    init_db()
    with connect() as db:
        cases = [case_record(db, r[0]) for r in db.execute("SELECT case_id FROM cases ORDER BY created_at DESC").fetchall()]
    return {"simulation": True, "retailer": "Northstar Demo Store", "demo_date": "2026-10-02",
            "policy": {"version": POLICY["version"], "timezone": POLICY["timezone"]},
            "model_provider": MODEL.provider_id, "orders": list(ORDERS.values()),
            "receipt_samples": {order_id: receipt_sample(order) for order_id, order in ORDERS.items()}, "cases": cases}


@app.post("/api/chat")
async def chat(body: ChatRequest) -> dict[str, Any]:
    order = ORDERS.get(body.order_id)
    if not order:
        raise HTTPException(404, "Sample order not found")
    history = [turn.model_dump() for turn in body.history]
    submit_requested = is_explicit_submit_intent(body.message)
    valid_approval = None
    saved = None
    if submit_requested and body.case_id:
        with connect() as db:
            try:
                saved = case_record(db, body.case_id)
            except HTTPException:
                saved = None
        if saved and saved["order_id"] == body.order_id and saved["state"] == "AWAITING_APPROVAL":
            approval, offer = saved["approval"], saved["offer"]
            if approval and offer and approval["case_revision"] == saved["revision"] and approval["offer_id"] == offer["offer_id"]:
                option = next((x for x in offer["options"] if x["terms_hash"] == approval["terms_hash"]), None)
                if option and datetime.now(timezone.utc) < datetime.fromisoformat(offer["expires_at"]):
                    valid_approval = approval
    available = BASE_AGENT_TOOLS | ({SUBMIT_SIMULATED_RETURN} if valid_approval else set())
    if submit_requested and not valid_approval:
        expired = bool(saved and saved.get("offer") and datetime.now(timezone.utc) >= datetime.fromisoformat(saved["offer"]["expires_at"]))
        reply = ("This offer expired. Refresh it, review the new terms, and approve them before confirming."
                 if expired else "I can only submit after you approve the current offer. Review the terms and use the approval control first.")
        return {"reply": reply, "provider": MODEL.provider_id, "agent_status": "fake", "simulation": True,
                "tool_calls": [], "tool_results": [], "model_can_approve": False,
                "model_can_approve_or_submit": False,
                "submit_tool_available_after_server_verified_user_approval": False}
    if hasattr(MODEL, "select_tool_with_tools"):
        selection = await MODEL.select_tool_with_tools(body.message, history, available)
    else:
        selection = await MODEL.select_tool(body.message, history)
    if submit_requested and valid_approval:
        # The model may help with phrasing; explicit intent plus server-verified approval governs execution.
        selection = type(selection)(SUBMIT_SIMULATED_RETURN, selection.status, selection.fallback_reason)
    tool_name = selection.tool_name
    explicit_prepare = is_explicit_prepare_intent(body.message)
    if tool_name == PREPARE_RETURN_PROPOSAL and not explicit_prepare:
        tool_name = "check_return_options"
    if tool_name == SUBMIT_SIMULATED_RETURN:
        if not valid_approval or not body.case_id:
            tool_name = "check_return_options"
        else:
            arguments = {"case_id": body.case_id, "approval_id": valid_approval["approval_id"],
                         "idempotency_key": "assistant_" + hashlib.sha256(
                             f"{body.case_id}:{valid_approval['approval_id']}".encode()).hexdigest()[:32]}
    if tool_name == "check_return_options":
        arguments = {"order_id": body.order_id, "issue": body.issue, "condition": body.condition,
                     "accessories_complete": body.accessories_complete}
        if "delivery_date_override" in body.model_fields_set:
            arguments["delivery_date_override"] = body.delivery_date_override.isoformat() if body.delivery_date_override else None
    elif tool_name == PREPARE_RETURN_PROPOSAL:
        arguments = {"order_id": body.order_id, "issue": body.issue, "condition": body.condition,
                     "accessories_complete": body.accessories_complete, "receipt_reviewed": body.receipt_reviewed,
                     "idempotency_key": "proposal_" + uuid.uuid4().hex}
        if "delivery_date_override" in body.model_fields_set:
            arguments["delivery_date_override"] = body.delivery_date_override.isoformat() if body.delivery_date_override else None
    elif tool_name != SUBMIT_SIMULATED_RETURN:
        arguments = {"order_id": body.order_id}
    tool_call = {"name": tool_name, "arguments": arguments}
    if tool_name == PREPARE_RETURN_PROPOSAL:
        reply = "I'll prepare a saved proposal for this synthetic order. I cannot submit it; review the policy terms and explicitly approve before confirming the simulation."
    elif tool_name == SUBMIT_SIMULATED_RETURN:
        reply = "Your approval is current. I'll record the simulated return now through the local MCP tool."
    elif re.search(r"\b(approve|submit|send|issue|file)\b", body.message, re.IGNORECASE):
        reply = "I cannot approve or submit without your action. Review the proposal, approve the exact terms, then explicitly confirm the simulation."
    else:
        reply = "I'll check the synthetic order and policy using a local MCP tool."
    response = {"reply": reply, "provider": MODEL.provider_id,
            "agent_status": "model" if selection.status == "ollama" else selection.status, "simulation": True,
            "tool_calls": [tool_call], "tool_results": [], "mcp_transport": "Streamable HTTP",
            "proposal_tool_available_after_explicit_user_intent": True,
            "submit_tool_available_after_server_verified_user_approval": True,
            "model_can_approve": False, "model_can_approve_or_submit": False}
    if selection.fallback_reason:
        response["fallback_reason"] = selection.fallback_reason
    return response


@app.post("/api/cases")
def create_case(body: NewCase) -> dict[str, Any]:
    order = ORDERS.get(body.order_id)
    if not order:
        raise HTTPException(404, "Sample order not found")
    if not body.receipt_reviewed:
        raise HTTPException(409, "RECEIPT_REVIEW_REQUIRED: review the synthetic receipt fields before continuing")
    evidence = dict(order)
    if "delivery_date_override" in body.model_fields_set:
        evidence["delivery_date"] = body.delivery_date_override.isoformat() if body.delivery_date_override else None
        verified = set(evidence.get("verified_fields", []))
        if body.delivery_date_override:
            verified.add("delivery_date")
        else:
            verified.discard("delivery_date")
        evidence["verified_fields"] = sorted(verified)
    case_id = "case_" + uuid.uuid4().hex[:12]
    stamp = now_iso()
    with connect() as db:
        db.execute("INSERT INTO cases(case_id,order_id,state,revision,issue,condition,accessories_complete,order_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                   (case_id, body.order_id, "DRAFT", 1, "defective" if body.issue == "defect" else body.issue, body.condition, int(body.accessories_complete), json.dumps(evidence, sort_keys=True), stamp, stamp))
        event(db, case_id, "CASE_CREATED", "user", {"order_id": body.order_id, "receipt_reviewed": True, "simulation": True})
        result = case_record(db, case_id)
    return result


@app.post("/api/cases/{case_id}/offers")
def create_offer(case_id: str) -> dict[str, Any]:
    with connect() as db:
        case = case_record(db, case_id)
        if case["state"] in ("AWAITING_DROPOFF", "DROPPED_OFF", "RECEIVED", "REFUNDED"):
            raise HTTPException(409, "This case already has a simulated return")
        order = case["order_evidence"]
        verdict = evaluate_eligibility(order, case["issue"], case["condition"], case["accessories_complete"], DEMO_NOW)
        offer = None
        if verdict["status"] == "eligible" and verdict["options"]:
            valid_until = datetime.now(timezone.utc) + timedelta(seconds=POLICY["offer_ttl_seconds"])
            options = []
            for option in verdict["options"]:
                terms = {"case_id": case_id, "order_id": case["order_id"], "revision": case["revision"],
                         "policy_version": POLICY["version"], "deadline_at": verdict["deadline_at"], **option}
                terms_hash = hashlib.sha256(json.dumps(terms, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                options.append({**option, "terms_hash": terms_hash})
            offer = {"offer_id": "offer_" + uuid.uuid4().hex[:12], "policy_version": POLICY["version"],
                     "policy_clause_ids": verdict["clause_ids"], "deadline_at": verdict["deadline_at"],
                     "expires_at": valid_until.isoformat(), "options": options}
            db.execute("UPDATE cases SET state='AWAITING_APPROVAL',offer_json=?,approval_json=NULL,eligibility_json=?,updated_at=? WHERE case_id=?",
                       (json.dumps(offer, sort_keys=True), json.dumps(verdict, sort_keys=True), now_iso(), case_id))
            event(db, case_id, "OFFER_PREPARED", "policy_engine", {"policy_version": POLICY["version"], "clauses": verdict["clause_ids"]})
        else:
            state = "NEEDS_INFO" if verdict["status"] == "needs_review" else "INELIGIBLE"
            db.execute("UPDATE cases SET state=?,offer_json=NULL,eligibility_json=?,updated_at=? WHERE case_id=?",
                       (state, json.dumps(verdict, sort_keys=True), now_iso(), case_id))
            event(db, case_id, "ELIGIBILITY_CHECKED", "policy_engine", {"status": verdict["status"], "reason_codes": verdict["reason_codes"]})
        current = case_record(db, case_id)
    return {"case": current, "eligibility": verdict}


@app.post("/api/cases/{case_id}/approve")
def approve(case_id: str, body: ApprovalRequest) -> dict[str, Any]:
    with connect() as db:
        case = case_record(db, case_id)
        offer = case["offer"]
        if not offer or case["state"] != "AWAITING_APPROVAL":
            raise HTTPException(409, "There is no active offer to approve")
        if body.expected_revision != case["revision"]:
            raise HTTPException(409, "REVISION_CONFLICT: review the current case")
        if body.offer_id != offer["offer_id"]:
            raise HTTPException(409, "OFFER_CHANGED: review the current offer")
        option = next((o for o in offer["options"] if o["terms_hash"] == body.terms_hash), None)
        if not option:
            raise HTTPException(409, "OFFER_CHANGED: review the exact option before approving")
        if datetime.now(timezone.utc) >= datetime.fromisoformat(offer["expires_at"]):
            raise HTTPException(409, "OFFER_EXPIRED: request a fresh offer")
        approval = {"approval_id": "approval_" + uuid.uuid4().hex[:12], "offer_id": offer["offer_id"],
                    "terms_hash": body.terms_hash, "case_revision": case["revision"], "approved_at": now_iso()}
        db.execute("UPDATE cases SET approval_json=?,updated_at=? WHERE case_id=?", (json.dumps(approval), now_iso(), case_id))
        event(db, case_id, "USER_APPROVED_SIMULATION", "user", {"offer_id": offer["offer_id"], "terms_hash": body.terms_hash})
        result = case_record(db, case_id)
    return result


@app.post("/api/cases/{case_id}/submit")
def submit(case_id: str, body: SubmitRequest) -> dict[str, Any]:
    request_hash = hashlib.sha256(f"{case_id}:{body.approval_id}".encode()).hexdigest()
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute("SELECT * FROM submissions WHERE idempotency_key=?", (body.idempotency_key,)).fetchone()
        if prior:
            if prior["request_hash"] != request_hash:
                raise HTTPException(409, "DUPLICATE_REQUEST: idempotency key was used for different terms")
            return json.loads(prior["return_json"])
        case = case_record(db, case_id)
        approval, offer = case["approval"], case["offer"]
        if not approval or approval["approval_id"] != body.approval_id:
            raise HTTPException(409, "APPROVAL_REQUIRED: explicitly approve these terms first")
        if approval["case_revision"] != case["revision"] or approval["offer_id"] != offer["offer_id"]:
            raise HTTPException(409, "OFFER_CHANGED: approval is no longer valid")
        if datetime.now(timezone.utc) >= datetime.fromisoformat(offer["expires_at"]):
            raise HTTPException(409, "OFFER_EXPIRED: request a fresh offer")
        item = next((x for x in offer["options"] if x["terms_hash"] == approval["terms_hash"]), None)
        if not item:
            raise HTTPException(409, "OFFER_CHANGED: approved terms could not be verified")
        order = case["order_evidence"]
        existing = db.execute("SELECT return_json FROM submissions WHERE retailer_id=? AND order_id=? AND item_id=?",
                              (order["retailer_id"], order["order_id"], order["item_id"])).fetchone()
        if existing:
            raise HTTPException(409, "DUPLICATE_REQUEST: this sample item already has a simulated return")
        return_id = "NS-RET-DEMO-" + uuid.uuid4().hex[:8].upper()
        due = date.fromisoformat(DEMO_NOW.date().isoformat()) + timedelta(days=POLICY["dispatch_window_days"])
        result = {"case_id": case_id, "state": "AWAITING_DROPOFF", "return_id": return_id,
                  "simulation": True, "label": "DEMO ONLY - NOT VALID FOR SHIPPING",
                  "instructions": ["Pack the fictional headphones and required accessories.", "Choose the fictional demo drop-off or mail option shown in your case."],
                  "next_action": "Mark this sample package dropped off", "next_action_due_at": due.isoformat(),
                  "option": item}
        db.execute("INSERT INTO submissions(idempotency_key,request_hash,case_id,retailer_id,order_id,item_id,return_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
                   (body.idempotency_key, request_hash, case_id, order["retailer_id"], order["order_id"], order["item_id"], json.dumps(result), now_iso()))
        db.execute("UPDATE cases SET state='AWAITING_DROPOFF',return_json=?,next_action=?,next_action_due_at=?,updated_at=? WHERE case_id=?",
                   (json.dumps(result), result["next_action"], result["next_action_due_at"], now_iso(), case_id))
        event(db, case_id, "SIMULATED_RETURN_CREATED", "mock_retailer", {"return_id": return_id, "simulation": True})
        return result


def prepare_proposal_tool(arguments: dict[str, Any]) -> dict[str, Any]:
    """Persist a reviewed proposal once per browser-generated idempotency key."""
    if arguments.get("receipt_reviewed") is not True:
        raise HTTPException(409, "RECEIPT_REVIEW_REQUIRED: review the synthetic receipt before preparing a proposal")
    idempotency_key = arguments["idempotency_key"]
    stable_args = {key: value for key, value in arguments.items() if key != "idempotency_key"}
    request_hash = hashlib.sha256(json.dumps(stable_args, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute("SELECT request_hash,case_id FROM proposal_requests WHERE idempotency_key=?", (idempotency_key,)).fetchone()
        if prior:
            if prior["request_hash"] != request_hash:
                raise HTTPException(409, "DUPLICATE_REQUEST: proposal idempotency key was used for different evidence")
            if prior["case_id"] == "PENDING":
                raise HTTPException(409, "PROPOSAL_IN_PROGRESS: reopen the saved case shortly")
            saved = case_record(db, prior["case_id"])
            return {"case": saved, "eligibility": saved["eligibility_result"], "replayed": True}
        db.execute("INSERT INTO proposal_requests(idempotency_key,request_hash,case_id,created_at) VALUES(?,?,?,?)",
                   (idempotency_key, request_hash, "PENDING", now_iso()))

    try:
        raw_date = arguments.get("delivery_date_override")
        override = date.fromisoformat(raw_date) if raw_date else None
        created = create_case(NewCase(order_id=arguments["order_id"], issue=arguments["issue"],
            condition=arguments["condition"], accessories_complete=arguments["accessories_complete"],
            receipt_reviewed=True, delivery_date_override=override))
        offer_result = create_offer(created["case_id"])
    except Exception:
        with connect() as db:
            db.execute("DELETE FROM proposal_requests WHERE idempotency_key=? AND case_id='PENDING'", (idempotency_key,))
        raise
    with connect() as db:
        db.execute("UPDATE proposal_requests SET case_id=? WHERE idempotency_key=? AND case_id='PENDING'",
                   (created["case_id"], idempotency_key))
    return {"case": offer_result["case"], "eligibility": offer_result["eligibility"], "replayed": False}


@app.get("/api/cases/{case_id}")
def get_case(case_id: str) -> dict[str, Any]:
    with connect() as db:
        return case_record(db, case_id)


@app.get("/api/cases/{case_id}/label", response_class=PlainTextResponse)
def get_label(case_id: str) -> str:
    with connect() as db:
        case = case_record(db, case_id)
    if not case["return"]:
        raise HTTPException(404, "A demo label is available only after a successful simulated request")
    return PlainTextResponse(
        "DEMO ONLY - NOT VALID FOR SHIPPING\nNorthstar Demo Store - SIMULATION\n" + case["return"]["return_id"],
        headers={"Content-Disposition": 'attachment; filename="northstar-demo-invalid-label.txt"'},
    )


@app.post("/api/demo/cases/{case_id}/advance")
def advance(case_id: str, body: AdvanceRequest) -> dict[str, Any]:
    allowed = {"AWAITING_DROPOFF": "DROPPED_OFF", "DROPPED_OFF": "RECEIVED", "RECEIVED": "REFUNDED"}
    with connect() as db:
        case = case_record(db, case_id)
        if not case["return"] or allowed.get(case["state"]) != body.status:
            raise HTTPException(409, "Only the next documented demo status can be simulated")
        next_action = {"DROPPED_OFF": "Wait for the fictional retailer to receive the package",
                       "RECEIVED": "Wait for the fictional retailer to update the refund status",
                       "REFUNDED": "Demo complete — no money moved"}[body.status]
        db.execute("UPDATE cases SET state=?,next_action=?,next_action_due_at=NULL,updated_at=? WHERE case_id=?",
                   (body.status, next_action, now_iso(), case_id))
        case["return"]["state"] = body.status
        case["return"]["next_action"] = next_action
        db.execute("UPDATE cases SET return_json=? WHERE case_id=?", (json.dumps(case["return"]), case_id))
        event(db, case_id, "DEMO_STATUS_ADVANCED", "demo_control", {"state": body.status, "simulation": True})
        return case_record(db, case_id)

