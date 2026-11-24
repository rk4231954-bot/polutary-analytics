#!/usr/bin/env python3
"""Adds or updates a HiveServer2 user in the credentials file read by
FileAuthenticationProvider (PBKDF2-HMAC-SHA256, 600 000 iterations, random salt).

Usage:
    python3 hs2_passwd.py FILE USER            # prompts for the password twice
    python3 hs2_passwd.py FILE USER --stdin    # reads the password from standard input

The file is created with mode 0600 and rewritten atomically; other users are kept.
Standard library only, so it runs without the project's virtual environments.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import os
import re
import secrets
import sys
import tempfile
from pathlib import Path

ITERATIONS = 600_000
USER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$")
MIN_LENGTH = 12


def entry(user: str, password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS, dklen=32)
    b64 = base64.b64encode
    return f"{user}:pbkdf2-sha256:{ITERATIONS}:{b64(salt).decode()}:{b64(digest).decode()}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("file", type=Path)
    parser.add_argument("user")
    parser.add_argument("--stdin", action="store_true", help="read the password from stdin")
    args = parser.parse_args()

    if not USER_RE.match(args.user):
        parser.error("user names may contain letters, digits, '_', '.' and '-' only")
    if args.stdin:
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = getpass.getpass(f"New HiveServer2 password for {args.user}: ")
        if password != getpass.getpass("Repeat: "):
            parser.error("the passwords do not match")
    if len(password) < MIN_LENGTH or ":" in password:
        parser.error(f"use at least {MIN_LENGTH} characters and no ':'")

    lines = []
    if args.file.exists():
        lines = [
            line
            for line in args.file.read_text(encoding="utf-8").splitlines()
            if line.split(":", 1)[0] != args.user
        ]
    else:
        lines = ["# HiveServer2 users: user:pbkdf2-sha256:iterations:salt:hash (hs2_passwd.py)"]
    lines.append(entry(args.user, password))

    args.file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=args.file.parent, prefix=".hs2-users.")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        os.replace(tmp, args.file)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    print(f"Saved HiveServer2 user '{args.user}' in {args.file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
