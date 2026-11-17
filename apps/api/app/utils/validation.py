"""Small, explicit input validators. Each returns a clean value or records a field error."""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from app.utils.errors import ValidationError

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
CODE_RE = re.compile(r"^[A-Za-z0-9-]{2,20}$")
PASSWORD_MIN, PASSWORD_MAX = 8, 128


class Validator:
    """Collects errors for all fields, then raises one ValidationError.

    Usage:
        v = Validator(payload)
        name = v.string("name", required=True, max_len=120)
        v.done()   # raises if anything failed
    """

    def __init__(self, data: Any, *, partial: bool = False) -> None:
        if not isinstance(data, dict):
            raise ValidationError({}, "The request body must be a JSON object.")
        self.data = data
        self.partial = partial  # PATCH: absent fields are skipped
        self.errors: dict[str, str] = {}

    def has(self, field: str) -> bool:
        return field in self.data

    def _skip(self, field: str) -> bool:
        return self.partial and field not in self.data

    def _missing(self, field: str, label: str, required: bool) -> bool:
        value = self.data.get(field)
        if value is None or (isinstance(value, str) and value.strip() == ""):
            if required:
                self.errors[field] = f"{label} is required."
            return True
        return False

    def string(
        self,
        field,
        label=None,
        *,
        required=False,
        max_len=255,
        min_len=0,
        pattern=None,
        pattern_msg=None,
    ):
        label = label or field
        if self._skip(field) or self._missing(field, label, required):
            return None
        value = self.data[field]
        if not isinstance(value, str):
            self.errors[field] = f"{label} must be text."
            return None
        value = value.strip()
        if len(value) < min_len:
            self.errors[field] = f"{label} must be at least {min_len} characters."
        elif len(value) > max_len:
            self.errors[field] = f"{label} must be at most {max_len} characters."
        elif pattern and not pattern.match(value):
            self.errors[field] = pattern_msg or f"{label} has an invalid format."
        return value

    def email(self, field="email", *, required=True):
        value = self.string(field, "Email", required=required, max_len=254)
        if value and field not in self.errors and not EMAIL_RE.match(value):
            self.errors[field] = "Enter a valid email address."
        return value.lower() if value else value

    def integer(self, field, label=None, *, required=False, min_value=None, max_value=None):
        label = label or field
        if self._skip(field) or self._missing(field, label, required):
            return None
        value = self.data[field]
        if isinstance(value, bool) or not isinstance(value, int):
            if isinstance(value, str) and value.strip().lstrip("-").isdigit():
                value = int(value.strip())
            else:
                self.errors[field] = f"{label} must be a whole number."
                return None
        if min_value is not None and value < min_value:
            self.errors[field] = f"{label} must be at least {min_value}."
        elif max_value is not None and value > max_value:
            self.errors[field] = f"{label} must be at most {max_value}."
        return value

    def choice(self, field, choices, label=None, *, required=False):
        label = label or field
        if self._skip(field) or self._missing(field, label, required):
            return None
        value = self.data[field]
        if value not in choices:
            self.errors[field] = f"{label} must be one of: {', '.join(map(str, choices))}."
            return None
        return value

    def date(self, field, label=None, *, required=False):
        label = label or field
        if self._skip(field) or self._missing(field, label, required):
            return None
        value = self.data[field]
        try:
            return date.fromisoformat(str(value))
        except ValueError:
            self.errors[field] = f"{label} must be a date in YYYY-MM-DD format."
            return None

    def boolean(self, field, *, default=False):
        value = self.data.get(field, default)
        return value if isinstance(value, bool) else default

    def int_list(self, field, label=None):
        label = label or field
        if self._skip(field):
            return None
        value = self.data.get(field, [])
        if value is None:
            return []
        if not isinstance(value, list) or not all(
            isinstance(i, int) and not isinstance(i, bool) for i in value
        ):
            self.errors[field] = f"{label} must be a list of ids."
            return None
        return sorted(set(value))

    def password(self, field="password", label="Password"):
        value = self.data.get(field)
        if not isinstance(value, str) or value == "":
            self.errors[field] = f"{label} is required."
            return None
        problem = password_problem(value)
        if problem:
            self.errors[field] = problem
            return None
        return value

    def done(self) -> None:
        if self.errors:
            raise ValidationError(self.errors)


def password_problem(value: str) -> str | None:
    """Same policy as the frontend checklist: 8+ chars with a letter and a number."""
    if len(value) < PASSWORD_MIN:
        return f"Use at least {PASSWORD_MIN} characters, including a letter and a number."
    if len(value) > PASSWORD_MAX:
        return f"Use at most {PASSWORD_MAX} characters."
    if not re.search(r"[A-Za-z]", value) or not re.search(r"\d", value):
        return f"Use at least {PASSWORD_MIN} characters, including a letter and a number."
    return None
