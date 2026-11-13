function check_ci_guardrail
    set -l workflow_dir "$target_dir/.github/workflows"
    set -l missing

    for task in lint test
        grep -RqsE "mise run $task([[:space:]]|\$)" "$workflow_dir"
        or set -a missing $task
    end

    if test (count $missing) -eq 0
        check_pass "CI runs lint and test"
    else
        check_fail "CI runs lint and test" "Add a GitHub Actions job that runs: mise run "(string join " and mise run " $missing)
    end
end
