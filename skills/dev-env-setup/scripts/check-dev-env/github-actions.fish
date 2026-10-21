function check_github_actions_pinned
    set workflow_dir "$target_dir/.github/workflows"

    if not test -d "$workflow_dir"
        check_pass "GitHub Actions pinned"
        return
    end

    set unpinned_actions (grep -RHE "uses:[[:space:]]*['\"]?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+[^[:space:]#]*@[^[:space:]#]+" "$workflow_dir" 2>/dev/null | grep -Ev "@[0-9a-f]{40}['\"]?([[:space:]#]|\$)")

    if test (count $unpinned_actions) -eq 0
        check_pass "GitHub Actions pinned"
    else
        check_fail "GitHub Actions pinned" "Pin workflow actions to full commit SHAs and keep the version as a comment, e.g. uses: actions/checkout@<sha> # v4. $unpinned_actions[1]"
    end
end

function check_github_actions_lint
    if not test -d "$target_dir/.github/workflows"
        check_pass "GitHub Actions lint"
        return
    end

    if not grep -qs jactionlint $target_dir/{,.}mise{,.local}.toml
        check_fail "GitHub Actions lint" "Pin jactionlint in the project mise [tools] and add a lint:actions task that runs 'jactionlint --strict-exit'."
        return
    end

    if not command -q jactionlint
        check_warn "GitHub Actions lint" "jactionlint is not installed. Run 'mise install' in the project so the audit can lint its workflows."
        return
    end

    set lint_output (builtin cd "$target_dir"; and jactionlint --strict-exit --no-baseline --no-color --format oneline 2>&1)
    switch $status
        case 0
            check_pass "GitHub Actions lint"
        case 1
            check_fail "GitHub Actions lint" "jactionlint reported "(count $lint_output)" finding(s). Fix them; do not baseline them. Start with 'jactionlint --diff --fix=unsafe' in $target_dir. $lint_output[1]"
        case '*'
            check_warn "GitHub Actions lint" "jactionlint could not run. $lint_output[1]"
    end
end
