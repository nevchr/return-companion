from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.policy import evaluate_eligibility


TORONTO = ZoneInfo("America/Toronto")
DEMO_NOW = datetime(2026, 10, 2, 12, 0, tzinfo=TORONTO)


def order_1001(**updates):
    order = {
        "order_id": "NS-DEMO-1001",
        "retailer_id": "northstar_demo",
        "item_id": "item-1001-a",
        "product_name": "Northstar Wireless Headphones",
        "category": "electronics",
        "quantity": 1,
        "delivery_date": "2026-09-08",
        "currency": "CAD",
        "item_cents": 8999,
        "tax_cents": 1170,
        "shipping_cents": 0,
        "paid_total_cents": 10169,
        "replacement_in_stock": True,
        "verified_fields": ["order_id", "item_id", "delivery_date", "currency", "item_cents", "tax_cents"],
    }
    order.update(updates)
    if "paid_total_cents" not in updates and any(key in updates for key in ("item_cents", "tax_cents", "shipping_cents")):
        order["paid_total_cents"] = order["item_cents"] + order["tax_cents"] + order.get("shipping_cents", 0)
    return order


def test_defective_order_1001_has_refund_mail_dropoff_and_replacement_options():
    result = evaluate_eligibility(order_1001(), "defective", "opened", True, DEMO_NOW)

    assert result["status"] == "eligible"
    assert result["deadline_at"] == "2026-10-08T23:59:59-04:00"
    assert result["policy_version"] == "northstar-v1"
    assert result["reason_codes"] == ["DEFECT_WITHIN_WINDOW"]
    assert result["clause_ids"] == ["R1", "R2", "R6"]
    assert [option["method_id"] for option in result["options"]] == [
        "demo_dropoff", "demo_mail", "demo_dropoff"
    ]
    assert result["options"][0] == {
        "option_id": "defective_dropoff",
        "method_id": "demo_dropoff",
        "refund_cents": 10169,
        "fee_cents": 0,
        "clause_ids": ["R1", "R2", "R6"],
    }
    assert result["options"][2]["option_id"] == "defective_replacement"


def test_deadline_is_inclusive_at_last_second_and_expired_afterward():
    before = evaluate_eligibility(
        order_1001(), "defective", "opened", True,
        datetime(2026, 10, 8, 23, 59, 59, tzinfo=TORONTO),
    )
    after = evaluate_eligibility(
        order_1001(), "defective", "opened", True,
        datetime(2026, 10, 9, 0, 0, 0, tzinfo=TORONTO),
    )

    assert before["status"] == "eligible"
    assert after["status"] == "ineligible"
    assert after["options"] == []
    assert after["reason_codes"] == ["RETURN_WINDOW_EXPIRED"]


def test_order_1002_expired_has_no_return_offer():
    order = order_1001(
        order_id="NS-DEMO-1002",
        item_id="item-1002-a",
        delivery_date="2026-08-20",
        item_cents=5999,
        tax_cents=780,
        replacement_in_stock=False,
    )

    result = evaluate_eligibility(order, "defective", "opened", True, DEMO_NOW)

    assert result["status"] == "ineligible"
    assert result["deadline_at"] == "2026-09-19T23:59:59-04:00"
    assert result["options"] == []
    assert result["reason_codes"] == ["RETURN_WINDOW_EXPIRED"]


def test_missing_delivery_date_needs_review_without_inventing_deadline():
    result = evaluate_eligibility(
        order_1001(delivery_date=None), "defective", "opened", True, DEMO_NOW
    )

    assert result["status"] == "needs_review"
    assert result["deadline_at"] is None
    assert result["options"] == []
    assert result["reason_codes"] == ["MISSING_DELIVERY_DATE"]


def test_unopened_changed_mind_applies_postage_deduction():
    result = evaluate_eligibility(order_1001(), "changed_mind", "unopened", True, DEMO_NOW)

    assert result["status"] == "eligible"
    assert result["options"] == [{
        "option_id": "changed_mind_mail",
        "method_id": "demo_mail",
        "refund_cents": 9370,
        "fee_cents": 799,
        "clause_ids": ["R1", "R4"],
    }]


def test_opened_changed_mind_and_missing_accessories_need_review():
    opened = evaluate_eligibility(order_1001(), "changed_mind", "opened", True, DEMO_NOW)
    no_accessories = evaluate_eligibility(order_1001(), "defective", "opened", False, DEMO_NOW)

    assert opened["status"] == "needs_review"
    assert opened["options"] == []
    assert "R4" in opened["clause_ids"]
    assert no_accessories["status"] == "needs_review"
    assert no_accessories["options"] == []


def test_naive_clock_is_rejected():
    with pytest.raises(ValueError, match="timezone-aware"):
        evaluate_eligibility(
            order_1001(), "defective", "opened", True, datetime(2026, 10, 2, 12, 0)
        )


def test_unverified_facts_and_mismatched_totals_need_review():
    missing_verification = order_1001(verified_fields=["order_id", "item_id"])
    mismatched_total = order_1001(paid_total_cents=10168)

    missing_result = evaluate_eligibility(missing_verification, "defective", "opened", True, DEMO_NOW)
    mismatch_result = evaluate_eligibility(mismatched_total, "defective", "opened", True, DEMO_NOW)

    assert missing_result["status"] == "needs_review"
    assert missing_result["reason_codes"] == ["MISSING_EVIDENCE"]
    assert mismatch_result["status"] == "needs_review"
    assert mismatch_result["reason_codes"] == ["ORDER_TOTAL_MISMATCH"]
