"""Deterministic eligibility rules for the fictional Northstar demo store.

This module deliberately has no model or network dependencies. The clock is an
explicit argument so policy boundaries are repeatable in tests and demos.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo


POLICY_VERSION = "northstar-v1"
POLICY_TIMEZONE = ZoneInfo("America/Toronto")
_EFFECTIVE_FROM = date(2026, 7, 1)
_EFFECTIVE_TO = date(2026, 12, 31)
_CAD = "CAD"


def _review(reason: str, clause_ids: list[str] | None = None) -> dict[str, Any]:
    return {
        "status": "needs_review",
        "deadline_at": None,
        "options": [],
        "reason_codes": [reason],
        "clause_ids": clause_ids or ["R1", "R5"],
        "policy_version": POLICY_VERSION,
    }


def _as_delivery_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return None


def _money_cents(order: dict[str, Any], key: str) -> int | None:
    value = order.get(key)
    # Reject bool even though bool is a subclass of int.
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def evaluate_eligibility(
    order: dict[str, Any],
    issue: str,
    condition: str,
    accessories_complete: bool,
    now: datetime,
) -> dict[str, Any]:
    """Evaluate a synthetic order under Northstar v1.

    ``now`` must be timezone-aware. Defective electronics can be returned by
    free demo drop-off or mail; opened, non-defective items require review.
    Monetary values are integer cents throughout.
    """
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be a timezone-aware datetime")

    if not isinstance(order, dict):
        return _review("MISSING_EVIDENCE")
    if order.get("delivery_date") in (None, ""):
        return _review("MISSING_DELIVERY_DATE")
    required = ("order_id", "item_id", "delivery_date", "currency", "item_cents", "tax_cents")
    if any(order.get(field) in (None, "") for field in required):
        return _review("MISSING_EVIDENCE")
    verified_fields = order.get("verified_fields", [])
    if not isinstance(verified_fields, (list, tuple, set)) or not set(required).issubset(verified_fields):
        return _review("MISSING_EVIDENCE")

    delivery = _as_delivery_date(order.get("delivery_date"))
    if delivery is None:
        return _review("MISSING_DELIVERY_DATE")
    if delivery > now.astimezone(POLICY_TIMEZONE).date():
        return _review("FUTURE_DELIVERY_DATE")
    if order.get("retailer_id") != "northstar_demo":
        return _review("UNSUPPORTED_RETAILER")
    if order.get("category") != "electronics":
        return _review("UNSUPPORTED_CATEGORY")
    if order.get("currency") != _CAD:
        return _review("UNSUPPORTED_CURRENCY")

    item_cents = _money_cents(order, "item_cents")
    tax_cents = _money_cents(order, "tax_cents")
    if item_cents is None or tax_cents is None:
        return _review("INVALID_ORDER_AMOUNT")
    quantity = order.get("quantity", 1)
    if isinstance(quantity, bool) or quantity != 1:
        return _review("UNSUPPORTED_QUANTITY")
    shipping_cents = _money_cents(order, "shipping_cents") if "shipping_cents" in order else 0
    paid_total_cents = _money_cents(order, "paid_total_cents") if "paid_total_cents" in order else None
    if shipping_cents is None or ("paid_total_cents" in order and paid_total_cents is None):
        return _review("INVALID_ORDER_AMOUNT")
    if paid_total_cents is not None and paid_total_cents != item_cents + tax_cents + shipping_cents:
        return _review("ORDER_TOTAL_MISMATCH")
    if not isinstance(accessories_complete, bool):
        return _review("ACCESSORIES_UNCONFIRMED", ["R2", "R5"])
    if not accessories_complete:
        return _review("ACCESSORIES_MISSING", ["R2", "R5"])

    local_deadline_date = delivery + timedelta(days=30)
    deadline = datetime.combine(local_deadline_date, time(23, 59, 59), tzinfo=POLICY_TIMEZONE)
    local_now = now.astimezone(POLICY_TIMEZONE)

    # Fixture scope is intentionally narrow: only the dates covered by the
    # sample policy can produce an executable offer.
    if not (_EFFECTIVE_FROM <= delivery <= _EFFECTIVE_TO):
        return _review("POLICY_NOT_EFFECTIVE", ["R1"])

    base = {
        "deadline_at": deadline.isoformat(),
        "policy_version": POLICY_VERSION,
    }
    if local_now > deadline:
        return {
            **base,
            "status": "ineligible",
            "options": [],
            "reason_codes": ["RETURN_WINDOW_EXPIRED"],
            "clause_ids": ["R1"],
        }

    issue_key = issue.strip().lower().replace("-", "_").replace(" ", "_") if isinstance(issue, str) else ""
    condition_key = condition.strip().lower().replace("-", "_").replace(" ", "_") if isinstance(condition, str) else ""
    defective = issue_key in {"defective", "broken", "stopped_working", "not_working"}
    changed_mind = issue_key in {"changed_mind", "no_longer_wanted", "dont_want"}

    if defective:
        options = [
            {
                "option_id": "defective_dropoff",
                "method_id": "demo_dropoff",
                "refund_cents": item_cents + tax_cents,
                "fee_cents": 0,
                "clause_ids": ["R1", "R2", "R6"],
            },
            {
                "option_id": "defective_mail",
                "method_id": "demo_mail",
                "refund_cents": item_cents + tax_cents,
                "fee_cents": 0,
                "clause_ids": ["R1", "R2", "R6"],
            },
        ]
        if order.get("replacement_in_stock") is True:
            options.append({
                "option_id": "defective_replacement",
                "method_id": "demo_dropoff",
                "refund_cents": 0,
                "fee_cents": 0,
                "clause_ids": ["R1", "R3", "R6"],
            })
        return {
            **base,
            "status": "eligible",
            "options": options,
            "reason_codes": ["DEFECT_WITHIN_WINDOW"],
            "clause_ids": ["R1", "R2", "R6"],
        }

    if changed_mind:
        if condition_key not in {"unopened", "sealed", "new"}:
            return {
                **base,
                "status": "needs_review",
                "options": [],
                "reason_codes": ["OPENED_CHANGED_MIND_REQUIRES_REVIEW"],
                "clause_ids": ["R1", "R4"],
            }
        fee_cents = 799
        refund_cents = max(0, item_cents + tax_cents - fee_cents)
        return {
            **base,
            "status": "eligible",
            "options": [{
                "option_id": "changed_mind_mail",
                "method_id": "demo_mail",
                "refund_cents": refund_cents,
                "fee_cents": fee_cents,
                "clause_ids": ["R1", "R4"],
            }],
            "reason_codes": ["UNOPENED_WITHIN_WINDOW"],
            "clause_ids": ["R1", "R4"],
        }

    return {
        **base,
        "status": "needs_review",
        "options": [],
        "reason_codes": ["ISSUE_REQUIRES_REVIEW"],
        "clause_ids": ["R5"],
    }
