#!/usr/bin/env bash
# Reports which required development tools are installed. Changes nothing.
set -u
status=0
check() {
  local out
  # Require the tool to actually run: WSL ships a placeholder `docker` that only prints a hint.
  if command -v "$1" >/dev/null 2>&1 && out="$("$1" --version 2>/dev/null)"; then
    printf '  [ok]      %-8s %s\n' "$1" "$(head -n1 <<<"$out")"
  else
    printf '  [missing] %-8s %s\n' "$1" "$2"
    status=1
  fi
}
echo "Polutary Analytics: environment check"
check bun     "https://bun.sh/docs/installation"
check uv      "https://docs.astral.sh/uv/getting-started/installation/"
check python3 "Python 3.12 is required"
check git     "https://git-scm.com/downloads"
check docker  "needed from stage 7 (Hadoop/Hive)"
exit $status
