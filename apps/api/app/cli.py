"""Flask CLI commands.

    uv run flask --app run init-db
    uv run flask --app run create-admin --email admin@example.org --name "Farm Admin"
    uv run flask --app run purge-sessions

create-admin is the only way to obtain the first administrator: public
registration always creates an Analyst account. The password is typed at a
hidden prompt (or piped with --password-stdin), never passed as an argument,
so it does not end up in shell history or process lists.
"""

from __future__ import annotations

import sys

import click
from flask import Flask
from sqlalchemy import func, select

from app.extensions import db
from app.models import Role, User
from app.services import audit_service
from app.services.auth_service import purge_expired_revocations
from app.services.passwords import hash_password
from app.services.permissions import get_role, seed_roles
from app.utils.time import utcnow
from app.utils.validation import EMAIL_RE, password_problem


def register(app: Flask) -> None:
    @app.cli.command("init-db")
    def init_db() -> None:
        """Create tables and the four roles (safe to run repeatedly)."""
        db.create_all()
        seed_roles()
        click.echo("Database ready.")

    @app.cli.command("create-admin")
    @click.option("--email", required=True, help="Administrator email address.")
    @click.option("--name", "full_name", required=True, help="Administrator full name.")
    @click.option("--password-stdin", is_flag=True, help="Read the password from standard input.")
    @click.option(
        "--allow-additional",
        is_flag=True,
        help="Create another admin even though one exists (normally use Users & Roles instead).",
    )
    def create_admin(
        email: str, full_name: str, password_stdin: bool, allow_additional: bool
    ) -> None:
        """Bootstrap an administrator account."""
        email = email.strip().lower()
        full_name = full_name.strip()
        if not EMAIL_RE.match(email):
            raise click.ClickException("Enter a valid email address.")
        if not 2 <= len(full_name) <= 120:
            raise click.ClickException("Name must be 2-120 characters.")
        admins = db.session.scalar(
            select(func.count(User.id)).join(User.role).where(Role.name == "admin")
        )
        if admins and not allow_additional:
            raise click.ClickException(
                "An administrator already exists. Promote users from Users & Roles, "
                "or pass --allow-additional if you really need another bootstrap admin."
            )
        if db.session.scalar(select(User.id).where(User.email == email)) is not None:
            raise click.ClickException("An account with this email already exists.")

        if password_stdin:
            password = sys.stdin.readline().rstrip("\n")
        else:
            password = click.prompt("Password", hide_input=True, confirmation_prompt=True)
        if problem := password_problem(password):
            raise click.ClickException(problem)

        user = User(
            full_name=full_name,
            email=email,
            password_hash=hash_password(password),
            role=get_role("admin"),
            password_changed_at=utcnow(),
        )
        db.session.add(user)
        db.session.flush()
        audit_service.record(
            "user.admin_bootstrap",
            actor=user,
            resource_type="user",
            resource_id=user.id,
            details={"email": email},
            commit=False,
        )
        db.session.commit()
        click.echo(f"Administrator {email} created.")

    @app.cli.command("purge-sessions")
    def purge_sessions() -> None:
        """Delete revoked-session records that have expired anyway."""
        click.echo(f"Removed {purge_expired_revocations()} expired session record(s).")
