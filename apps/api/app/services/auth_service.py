"""Sessions on top of Flask-JWT-Extended.

How a session works
-------------------
* Login issues a short-lived JWT access token (default 30 min) in an HttpOnly
  cookie, so page JavaScript can never read it.
* The token carries: sid (session id), tv (the user's token version), rem
  ("keep me signed in") and auth (sign-in time).
* Every state-changing request (POST/PUT/PATCH/DELETE) must send the CSRF token
  in the X-CSRF-TOKEN header (double-submit). The token is returned in the JSON
  body of login and /auth/me because a frontend on another domain (Vercel)
  cannot read the API's cookies.
* While the user is active, a token close to expiry is re-issued automatically
  (sliding session) with the same sid and CSRF value, up to an absolute maximum
  (12 h, or 7 days with "keep me signed in").
* Logout stores the sid in revoked_sessions. A password change or suspension
  increments token_version, which invalidates every existing token.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from functools import wraps

from flask import current_app, g
from flask_jwt_extended import (
    create_access_token,
    get_csrf_token,
    get_current_user,
    get_jwt,
    set_access_cookies,
    unset_jwt_cookies,
    verify_jwt_in_request,
)

from app.extensions import db, jwt
from app.models import RevokedSession, User
from app.services import audit_service
from app.services.permissions import has_permission
from app.utils.errors import ApiError, error_response
from app.utils.time import utcnow


# --- Issuing tokens ------------------------------------------------------------
def _session_max_age(remember: bool):
    cfg = current_app.config
    return cfg["SESSION_REMEMBER_MAX_AGE"] if remember else cfg["SESSION_MAX_AGE"]


def _cookie_max_age(remember: bool) -> int | None:
    # "Keep me signed in" → persistent cookie; otherwise a browser-session cookie.
    return int(_session_max_age(True).total_seconds()) if remember else None


def _encode(user: User, sid: str, remember: bool, auth_time: int, csrf: str | None = None) -> str:
    claims = {"sid": sid, "tv": user.token_version, "rem": remember, "auth": auth_time}
    if csrf:
        claims["csrf"] = csrf  # keep the same CSRF value when a session token is re-issued
    return create_access_token(identity=str(user.id), additional_claims=claims)


def start_session(user: User, *, remember: bool) -> tuple[str, str]:
    """Creates a new session token. Returns (token, csrf_token)."""
    auth_time = int(datetime.now(UTC).timestamp())
    token = _encode(user, str(uuid.uuid4()), remember, auth_time)
    return token, get_csrf_token(token)


def set_session_cookie(response, token: str, *, remember: bool) -> None:
    set_access_cookies(response, token, max_age=_cookie_max_age(remember))


def reissue_session(response, user: User, claims: dict) -> None:
    """Re-issues the current session's token (same sid and CSRF) for an updated user."""
    token = _encode(
        user, claims["sid"], bool(claims.get("rem")), int(claims["auth"]), claims["csrf"]
    )
    set_access_cookies(response, token, max_age=_cookie_max_age(bool(claims.get("rem"))))


def end_session(response, claims: dict | None) -> None:
    if claims and claims.get("sid"):
        sid = claims["sid"]
        if db.session.get(RevokedSession, sid) is None:
            expires = datetime.fromtimestamp(int(claims["exp"]), UTC).replace(tzinfo=None)
            db.session.add(
                RevokedSession(session_id=sid, user_id=int(claims["sub"]), expires_at=expires)
            )
    unset_jwt_cookies(response)


def refresh_if_needed(response):
    """after_request hook: slides the session forward while the user is active."""
    claims = g.get("jwt_claims")
    user = g.get("current_user")
    if not claims or not user or g.get("session_ended") or response.status_code >= 400:
        return response
    now = datetime.now(UTC).timestamp()
    remaining = claims["exp"] - now
    if remaining > current_app.config["JWT_REFRESH_WINDOW"].total_seconds():
        return response
    session_age = now - claims["auth"]
    if session_age >= _session_max_age(bool(claims.get("rem"))).total_seconds():
        return response  # absolute limit reached: the user signs in again after expiry
    reissue_session(response, user, claims)
    return response


# --- Verifying requests ---------------------------------------------------------
def current_user() -> User:
    return g.current_user


def auth_required(permission: str | None = None, *, allow_password_change_pending: bool = False):
    """Decorator for protected endpoints.

    Verifies the access-token cookie (and the CSRF header on unsafe methods),
    loads the user, enforces "must change password", then checks the permission.
    """

    def decorator(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            verify_jwt_in_request()
            claims = get_jwt()
            user: User = get_current_user()
            g.current_user = user
            g.jwt_claims = claims
            if user.must_change_password and not allow_password_change_pending:
                raise ApiError(
                    403,
                    "PASSWORD_CHANGE_REQUIRED",
                    "You must change your temporary password before continuing.",
                )
            if permission and not has_permission(user, permission):
                deny(user, permission)
            return view(*args, **kwargs)

        return wrapper

    return decorator


def deny(user: User, permission: str, *, resource_type=None, resource_id=None):
    audit_service.record(
        "access.denied",
        "denied",
        actor=user,
        resource_type=resource_type,
        resource_id=resource_id,
        details={"permission": permission, "role": user.role_name},
    )
    raise ApiError(403, "FORBIDDEN", "Your role does not allow this action.")


# --- Flask-JWT-Extended callbacks -----------------------------------------------
@jwt.user_lookup_loader
def _load_user(_header, payload):
    user = db.session.get(User, int(payload["sub"]))
    if user is None or not user.is_active or user.token_version != payload.get("tv"):
        return None
    return user


@jwt.token_in_blocklist_loader
def _is_revoked(_header, payload) -> bool:
    sid = payload.get("sid")
    return not sid or db.session.get(RevokedSession, sid) is not None


def _unauthorized(code: str, message: str):
    response = error_response(401, code, message)
    unset_jwt_cookies(response)
    return response


@jwt.unauthorized_loader
def _missing_token(_reason):
    return error_response(401, "AUTH_REQUIRED", "Please sign in to continue.")


@jwt.invalid_token_loader
def _invalid_token(_reason):
    return _unauthorized("INVALID_TOKEN", "Your session is invalid. Please sign in again.")


@jwt.expired_token_loader
def _expired_token(_header, _payload):
    return _unauthorized("SESSION_EXPIRED", "Your session has expired. Please sign in again.")


@jwt.revoked_token_loader
def _revoked_token(_header, _payload):
    return _unauthorized("SESSION_REVOKED", "You have signed out. Please sign in again.")


@jwt.user_lookup_error_loader
def _user_lookup_error(_header, _payload):
    return _unauthorized(
        "SESSION_INVALID", "Your session is no longer valid. Please sign in again."
    )


def purge_expired_revocations() -> int:
    deleted = db.session.query(RevokedSession).filter(RevokedSession.expires_at < utcnow()).delete()
    db.session.commit()
    return deleted
