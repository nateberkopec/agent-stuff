### 13. hk Git Hooks

Git hooks are managed with [hk](https://hk.jdx.dev/). Configure them in `hk.pkl` at the project root.

The managed user config at `~/.config/hk/config.pkl` supplies `lint` and `test` steps to both `pre-push` and `check`, calling the standard `mise run lint` and `mise run test` tasks. A project opts in by adding an `hk.pkl` with a 10s pre-commit timeout; redefine those step names only when the project needs more granular checks or different commands.

Key rules:
- **Split hooks for parallelism.** hk runs steps in parallel, so separate independent checks rather than combining them into one script.
- **Pre-commit finishes in 10s.** Set `timeout = "10s"` on the `pre-commit` hook. Keep only fast checks on staged files there; time each with `mise run --force <task>` and move anything that cannot fit to pre-push.
- **Pre-push and check must include lint and test.** Give `pre-push` a `timeout` sized to the full suite with headroom. Tests too slow even for pre-push, such as system tests, run only in CI.
- **Steps should invoke mise tasks.** Use `mise run <task>` as the check command.
- **Project definitions win.** User and project hooks merge additively; use the shared `lint` and `test` names when overriding defaults to avoid duplicate runs.
- **Use local overrides for personal exceptions.** Put `hk.local.pkl` next to `hk.pkl`, begin it with `amends "./hk.pkl"`, and exclude it with `.git/info/exclude` or `.gitignore`.
- **Match the schema to the hk that runs it.** Every `hk.pkl` amends a versioned `Config.pkl` package; there is no unversioned form. hk 2 cannot evaluate an hk 1 schema (`union property 'command' has no selected default`), so a project whose mise resolves `hk = "latest"` breaks when hk changes major. Never copy a version from this file. Take it from the hk the project resolves, and regenerate the line after a major upgrade. A schema matching the executable exactly is built in and needs no download.

Minimal `hk.pkl` for projects using the standard tasks, written from the resolved hk version:

```bash
v=$(mise exec -- hk --version | cut -d' ' -f2)
printf 'amends "package://github.com/jdx/hk/releases/download/v%s/hk@%s#/Config.pkl"\n\nhooks {\n  ["pre-commit"] {\n    timeout = "10s"\n  }\n}\n' "$v" "$v" > hk.pkl
```

A project with additional checks can redefine the shared names, reuse one mapping across pre-push and check, and keep fast staged-file checks in pre-commit. Start from that same generated line:

```pkl
amends "package://github.com/jdx/hk/releases/download/v<version>/hk@<version>#/Config.pkl"

local checks = new Mapping<String, Step> {
  ["lint"] {
    check = "mise run lint:standard"
  }
  ["test"] {
    check = "mise run test"
  }
}

hooks {
  ["pre-commit"] {
    timeout = "10s"
    steps {
      ["complexity"] {
        check = "mise run lint:complexity"
      }
    }
  }
  ["pre-push"] {
    timeout = "5m"
    steps = checks
  }
  ["check"] {
    steps = checks
  }
}
```

Ensure hk is in the mise `[tools]` section, then run `mise deps hk` when a custom dependency provider is configured, or:

```bash
mise run -- hk install
```
