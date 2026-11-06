#!/usr/bin/env bash
set -euo pipefail

git_environment="$(git rev-parse --local-env-vars)"
while IFS= read -r name; do
  unset "$name"
done <<< "$git_environment"

exec "$@"
