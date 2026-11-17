"""Authentication: register, login, logout, current user, profile and password change."""

from __future__ import annotations

from flask import Blueprint, current_app, g, jsonify
from flask_jwt_extended import get_jwt, verify_jwt_in_request
from flask_jwt_extended.exceptions import CSRFError, JWTExtendedException
from jwt.exceptions import PyJWTError
from sqlalchemy import select

from app.extensions import db
from app.models import User
from app.services import audit_service
from app.services.auth_service import (
    auth_required,
    current_user,
    end_session,
    reissue_session,
    set_session_cookie,
    start_session,
)
from app.services.passwords import hash_password, needs_rehash, verify_password
from app.services.permissions import DEFAULT_ROLE, get_role
from app.services.serializers import user_to_dict
from app.utils.errors import ApiError, ValidationError
from app.utils.http import client_ip, json_body
from app.utils.time import utcnow
from app.utils.validation import Validator, password_problem

bp = Blueprint("auth", __name__, url_prefix="/api/auth")


def _limiter():
    return current_app.extensions["login_limiter"]


def _throttle(key: str, limit: int, window: int, message: str) -> None:
    wait = _limiter().retry_after(key, limit, window)
    if wait:
        raise ApiError(429, "TOO_MANY_ATTEMPTS", message, headers={"Retry-After": str(wait)})


@bp.post("/register")
def register():
    data = json_body()
    cfg = current_app.config
    ip_key = f"register:ip:{client_ip()}"
    _throttle(
        ip_key,
        cfg["REGISTER_MAX_PER_IP"],
        cfg["REGISTER_WINDOW_SECONDS"],
        "Too many accounts were created from this network. Please try again later.",
    )
    if "role" in data:
        # Roles are assigned by an administrator; self-registration can never pick one.
        audit_service.record(
            "auth.register",
            "denied",
            actor_email=str(data.get("email", ""))[:254],
            details={"reason": "role field supplied", "requestedRole": str(data.get("role"))[:32]},
        )
        raise ApiError(
            400, "ROLE_NOT_ALLOWED", "Roles are assigned by an administrator after registration."
        )

    v = Validator(data)
    full_name = v.string("fullName", "Full name", required=True, min_len=2, max_len=120)
    email = v.email()
    password = v.password()
    v.done()

    if db.session.scalar(select(User.id).where(User.email == email)) is not None:
        audit_service.record(
            "auth.register", "failure", actor_email=email, details={"reason": "duplicate email"}
        )
        raise ApiError(
            409,
            "EMAIL_TAKEN",
            "An account with this email already exists.",
            {"email": "An account with this email already exists."},
        )

    user = User(
        full_name=full_name,
        email=email,
        password_hash=hash_password(password),
        role=get_role(DEFAULT_ROLE),
        password_changed_at=utcnow(),
    )
    db.session.add(user)
    db.session.flush()
    audit_service.record(
        "auth.register",
        actor=user,
        resource_type="user",
        resource_id=user.id,
        details={"role": DEFAULT_ROLE},
        commit=False,
    )
    db.session.commit()
    _limiter().hit(ip_key)
    return jsonify(user=user_to_dict(user)), 201


@bp.post("/login")
def login():
    data = json_body()
    cfg = current_app.config
    v = Validator(data)
    email = v.email()
    password = data.get("password")
    if not isinstance(password, str) or not password:
        v.errors["password"] = "Password is required."  # noqa: S105 (message, not a password)
    v.done()
    remember = v.boolean("remember")

    ip_key, email_key = f"login:ip:{client_ip()}", f"login:email:{email}"
    window = cfg["LOGIN_WINDOW_SECONDS"]
    wait = max(
        _limiter().retry_after(email_key, cfg["LOGIN_MAX_FAILURES_PER_EMAIL"], window),
        _limiter().retry_after(ip_key, cfg["LOGIN_MAX_FAILURES_PER_IP"], window),
    )
    if wait:
        audit_service.record(
            "auth.login", "denied", actor_email=email, details={"reason": "rate limited"}
        )
        minutes = max(1, round(wait / 60))
        raise ApiError(
            429,
            "TOO_MANY_ATTEMPTS",
            f"Too many failed sign-in attempts. Try again in about {minutes} minute(s).",
            headers={"Retry-After": str(wait)},
        )

    user = db.session.scalar(select(User).where(User.email == email))
    # verify_password always runs (against a dummy hash if needed) so timing does not reveal emails.
    if not verify_password(user.password_hash if user else None, password):
        _limiter().hit(ip_key)
        _limiter().hit(email_key)
        audit_service.record(
            "auth.login",
            "failure",
            actor_email=email,
            details={"reason": "invalid credentials" if user else "unknown email"},
        )
        raise ApiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.")

    if not user.is_active:
        audit_service.record(
            "auth.login", "denied", actor=user, details={"reason": "account suspended"}
        )
        raise ApiError(
            403, "ACCOUNT_SUSPENDED", "This account has been suspended. Contact an administrator."
        )

    _limiter().reset(email_key)
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    user.last_login_at = utcnow()
    audit_service.record(
        "auth.login",
        actor=user,
        resource_type="user",
        resource_id=user.id,
        details={"remember": remember},
        commit=False,
    )
    db.session.commit()

    token, csrf = start_session(user, remember=remember)
    response = jsonify(user=user_to_dict(user), csrfToken=csrf)
    set_session_cookie(response, token, remember=remember)
    return response


@bp.post("/logout")
def logout():
    """Always clears the cookies. A valid session is also revoked server-side (needs CSRF)."""
    claims = None
    user = None
    try:
        verify_jwt_in_request()
        claims = get_jwt()
        user = db.session.get(User, int(claims["sub"]))
    except CSRFError:
        raise  # a live session can only be ended by the app itself (CSRF header required)
    except (JWTExtendedException, PyJWTError):
        claims = None  # expired/missing/revoked: nothing to revoke, just clear the cookies
    response = current_app.response_class(status=204)
    end_session(response, claims)
    if claims:
        audit_service.record(
            "auth.logout", actor=user, resource_type="user", resource_id=claims["sub"], commit=False
        )
    db.session.commit()
    g.session_ended = True
    return response


@bp.get("/me")
@auth_required(allow_password_change_pending=True)
def me():
    return jsonify(user=user_to_dict(current_user()), csrfToken=g.jwt_claims["csrf"])


@bp.patch("/me")
@auth_required()
def update_me():
    user = current_user()
    data = json_body()
    v = Validator(data, partial=True)
    full_name = v.string("fullName", "Full name", required=True, min_len=2, max_len=120)
    email = v.email(required=True) if v.has("email") else None
    if "role" in data or "status" in data:
        v.errors["role"] = "Role and status can only be changed by an administrator."
    v.done()
    changed = []
    if full_name and full_name != user.full_name:
        user.full_name = full_name
        changed.append("fullName")
    if email and email != user.email:
        if db.session.scalar(select(User.id).where(User.email == email, User.id != user.id)):
            raise ApiError(
                409,
                "EMAIL_TAKEN",
                "An account with this email already exists.",
                {"email": "An account with this email already exists."},
            )
        user.email = email
        changed.append("email")
    if changed:
        audit_service.record(
            "user.profile_update",
            actor=user,
            resource_type="user",
            resource_id=user.id,
            details={"changed": changed},
            commit=False,
        )
    db.session.commit()
    return jsonify(user=user_to_dict(user))


@bp.post("/change-password")
@auth_required(allow_password_change_pending=True)
def change_password():
    user = current_user()
    data = json_body()
    current = data.get("currentPassword")
    new = data.get("newPassword")
    errors = {}
    if not isinstance(current, str) or not current:
        errors["currentPassword"] = "Current password is required."
    if not isinstance(new, str) or not new:
        errors["newPassword"] = "New password is required."
    elif problem := password_problem(new):
        errors["newPassword"] = problem
    if errors:
        raise ValidationError(errors)
    # 400 (not 401) so the frontend does not treat a typo as an expired session.
    if not verify_password(user.password_hash, current):
        audit_service.record(
            "auth.password_change",
            "failure",
            actor=user,
            details={"reason": "wrong current password"},
        )
        raise ApiError(
            400,
            "INVALID_CURRENT_PASSWORD",
            "The current password is incorrect.",
            {"currentPassword": "The current password is incorrect."},
        )
    if verify_password(user.password_hash, new):
        raise ValidationError({"newPassword": "Choose a password different from the current one."})

    user.password_hash = hash_password(new)
    user.password_changed_at = utcnow()
    user.must_change_password = False
    user.token_version += 1  # signs out every other session
    audit_service.record(
        "auth.password_change", actor=user, resource_type="user", resource_id=user.id, commit=False
    )
    db.session.commit()
    response = jsonify(user=user_to_dict(user), csrfToken=g.jwt_claims["csrf"])
    reissue_session(response, user, g.jwt_claims)  # keep this browser signed in
    g.session_ended = True  # already re-issued; skip the sliding refresh
    return response
