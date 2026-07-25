"""Stripe subscription billing — $10/month for unlimited generations.

Flow:
  1. Signed-in user hits POST /billing/checkout -> we create (or reuse) a Stripe Customer
     and return a Checkout Session URL. Frontend redirects there.
  2. Stripe redirects the user back to the app on success/cancel.
  3. Stripe calls POST /billing/webhook. That webhook — NOT the redirect — is what flips
     is_paid. A redirect can be forged or simply never happen (user closes the tab), so
     entitlement must only ever be granted from a signed webhook event.

Everything here no-ops safely when STRIPE_SECRET_KEY is unset, so the app still runs
locally without billing configured.
"""
import logging
import os

import stripe

logger = logging.getLogger("consensus_engine")

# Read lazily via helpers — .env is loaded by main before these are first called.
def stripe_key() -> str:
    return (os.getenv("STRIPE_SECRET_KEY") or "").strip()


def price_id() -> str:
    return (os.getenv("STRIPE_PRICE_ID") or "").strip()


def webhook_secret() -> str:
    return (os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip()


def billing_enabled() -> bool:
    return bool(stripe_key() and price_id())


def _init():
    stripe.api_key = stripe_key()
    # The stripe-python 11.4.1 pin (2024-12-18.acacia) predates Managed Payments,
    # which this account has enabled and which requires 2025-03-31.basil or newer.
    stripe.api_version = "2025-03-31.basil"


def ensure_customer(user, db) -> str:
    """Return the user's Stripe customer id, creating one on first use."""
    _init()
    if user.stripe_customer_id:
        return user.stripe_customer_id
    customer = stripe.Customer.create(email=user.email, metadata={"user_id": str(user.id)})
    user.stripe_customer_id = customer.id
    db.commit()
    return customer.id


def create_checkout_session(user, db, success_url: str, cancel_url: str) -> str:
    """Create a subscription Checkout Session and return its URL."""
    _init()
    customer_id = ensure_customer(user, db)
    session = stripe.checkout.Session.create(
        mode="subscription",
        customer=customer_id,
        line_items=[{"price": price_id(), "quantity": 1}],
        success_url=success_url,
        cancel_url=cancel_url,
        # Lets the webhook map the event back to our user even if the customer
        # record is somehow replaced.
        client_reference_id=str(user.id),
        metadata={"user_id": str(user.id)},
    )
    return session.url


def create_portal_session(user, db, return_url: str) -> str:
    """Stripe-hosted billing portal so users can cancel/update their card themselves."""
    _init()
    customer_id = ensure_customer(user, db)
    session = stripe.billing_portal.Session.create(customer=customer_id, return_url=return_url)
    return session.url


def verify_webhook(payload: bytes, signature: str):
    """Verify the Stripe signature and return the event. Raises on tampering."""
    _init()
    secret = webhook_secret()
    if not secret:
        # Refuse to process unverified events — without the signature check anyone who
        # finds the URL could grant themselves a subscription.
        raise ValueError("STRIPE_WEBHOOK_SECRET is not set; refusing to trust webhook")
    return stripe.Webhook.construct_event(payload, signature, secret)


# Statuses Stripe considers "the customer currently has access".
ACTIVE_STATUSES = {"active", "trialing"}


def apply_subscription_event(event, db, User) -> str:
    """Update the matching user's entitlement from a Stripe event. Returns a log string."""
    kind = event["type"]
    obj = event["data"]["object"]

    def find_user():
        # Prefer explicit ids we set at checkout, fall back to the customer id.
        uid = (obj.get("metadata") or {}).get("user_id") or obj.get("client_reference_id")
        if uid:
            u = db.query(User).filter(User.id == int(uid)).first()
            if u:
                return u
        cust = obj.get("customer")
        if cust:
            return db.query(User).filter(User.stripe_customer_id == cust).first()
        return None

    user = find_user()
    if not user:
        return f"{kind}: no matching user"

    if kind == "checkout.session.completed":
        user.stripe_subscription_id = obj.get("subscription")
        user.subscription_status = "active"
        user.is_paid = True
    elif kind in ("customer.subscription.created", "customer.subscription.updated"):
        status = obj.get("status")
        user.stripe_subscription_id = obj.get("id")
        user.subscription_status = status
        user.is_paid = status in ACTIVE_STATUSES
    elif kind == "customer.subscription.deleted":
        user.subscription_status = "canceled"
        user.is_paid = False
    else:
        return f"{kind}: ignored"

    db.commit()
    return f"{kind}: user={user.id} is_paid={user.is_paid} status={user.subscription_status}"
