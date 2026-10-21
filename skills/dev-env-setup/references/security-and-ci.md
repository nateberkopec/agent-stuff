# Security and CI
### 8. Secret Scanning

Pre-commit must include a secret scan via [gitleaks](https://github.com/gitleaks/gitleaks). The audit also runs gitleaks against the working tree (including gitignored files like `.env`) so the standard catches plaintext credentials before they're committed *and* while they sit on disk where an agent could read them.

Add a dedicated mise task named `lint:secrets`:

```toml
[tasks."lint:secrets"]
description = "Scan working tree for hardcoded secrets"
run = "gitleaks dir --redact=75 --no-banner --no-color --max-target-megabytes 5 ."
```

`gitleaks` is expected from the global mise config; the audit treats a missing `gitleaks` as a warning, not a failure, but the pre-commit task will error if it's not on PATH.

Use the right command for the right scope:

- `gitleaks dir .` (used here) scans the working tree, including gitignored files. This is the load-bearing scan because real secrets often live in gitignored paths like `.env`.
- `gitleaks git` scans `git log -p` history. Useful for catching past commits but slower and out of scope for the standard pre-commit step.

Always pass `--redact=75` so secret values do not end up in mise/hk output or CI logs. `--max-target-megabytes 5` skips lockfiles and binary blobs.

**Default config:** when the audit runs without a project-level `.gitleaks.toml`, it uses the bundled `scripts/check-dev-env/gitleaks-default.toml`, which extends gitleaks' defaults and allowlists common vendored or generated directories (`node_modules/`, `.bundle/ruby/`, `vendor/bundle/`, `target/`, `dist/`, etc.). Bundler config files are intentionally scanned so private gem credentials do not settle in plaintext. Drop a project-local `.gitleaks.toml` if you need different rules.

**Handling false positives:**

- **Per-finding**: append the printed `Fingerprint:` value (one per line) to a `.gitleaksignore` file at the project root. gitleaks reads it automatically.
- **Per-line**: annotate the offending line with a `gitleaks:allow` comment. Useful for fixtures, examples, and intentional test data.
- **Per-path**: add the path to `[[allowlists]] paths = [...]` in a project-level `.gitleaks.toml`.

**Adopting on an existing repo with old findings:** generate a baseline rather than fixing everything up front:

```fish
gitleaks dir --redact=75 --report-path .gitleaks-baseline.json .
```

The audit picks up `.gitleaks-baseline.json` automatically. Before committing it, inspect its structure without displaying findings and confirm that it contains no recovered secret values. A baseline is not inherently safe.

### 12. GitHub Actions

Lint workflows with [jactionlint](https://jactionlint.jdx.dev) in its default profile. Pin it in the project mise `[tools]` and add a `lint:actions` task to the `lint` fan-out:

```toml
[tools]
jactionlint = "2.2.0"

[tasks."lint:actions"]
description = "Check GitHub Actions workflows"
sources = [".github/workflows/*.yml", ".github/workflows/*.yaml", ".github/jactionlint.yaml"]
run = "jactionlint --strict-exit"
```

Pay the whole backlog down on adoption; the audit runs `jactionlint --strict-exit --no-baseline`, so only a clean run passes.

1. Preview mechanical fixes with `jactionlint --diff --fix=unsafe`, review them, then apply with `--fix=unsafe`. Before accepting `persist-credentials: false`, confirm no later step pushes or fetches with the checkout credentials.
2. Set `timeout-minutes` on each remaining job from `jactionlint --suggest-timeouts`, which reads recent run durations.
3. List self-hosted runner labels under `self-hosted-runner.labels` in `.github/jactionlint.yaml`; globs such as `my-runner-*` work.
4. Fix everything else by hand. `jactionlint --explain RULE` describes a rule and its fix.

Pin third-party actions to full commit SHAs, with the version as a comment:

```yaml
- uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```

Resolve tags with `git ls-remote https://github.com/<owner>/<repo>.git refs/tags/<tag>`.
