"""Password hashing + JWT issuing/verification for account login."""
import os
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlalchemy.orm import Session

from db import User, get_db

JWT_ALGORITHM = "HS256"
JWT_EXPIRES_DAYS = 30


def _require_secret() -> str:
    secret = os.getenv("JWT_SECRET", "")
    if not secret:
        raise HTTPException(status_code=500, detail="Server auth is not configured (JWT_SECRET missing)")
    return secret


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_token(user_id: int) -> str:
    secret = _require_secret()
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRES_DAYS),
    }
    return jwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def _decode_token(token: str) -> int:
    secret = _require_secret()
    try:
        payload = jwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid or expired session")


def verify_google_id_token(token: str) -> str:
    """Verify a Google Identity Services credential and return the account's email.

    Raises HTTPException — 503 if the server has no GOOGLE_CLIENT_ID configured yet,
    401 if the token doesn't check out (wrong audience, expired, unverified email).
    """
    client_id = os.getenv("GOOGLE_CLIENT_ID", "")
    if not client_id:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured on this server")
    try:
        idinfo = google_id_token.verify_oauth2_token(token, google_requests.Request(), client_id)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid Google credential")
    email = idinfo.get("email")
    if not email or not idinfo.get("email_verified"):
        raise HTTPException(status_code=401, detail="Google account has no verified email")
    return email.strip().lower()


def get_user_from_request(request: Request, db: Session):
    """Return the signed-in User, or None if the caller is anonymous / has a bad token.

    Used by the generation endpoints, which must serve anonymous visitors too — so an
    invalid token degrades to 'anonymous' rather than raising.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    try:
        user_id = _decode_token(auth_header.removeprefix("Bearer ").strip())
    except HTTPException:
        return None
    return db.query(User).filter(User.id == user_id).first()


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    user_id = _decode_token(auth_header.removeprefix("Bearer ").strip())
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user
