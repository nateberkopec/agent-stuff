function check_hk_config
    if test -f "$target_dir/hk.pkl"
        set -g hk_file "$target_dir/hk.pkl"
        check_pass "hk config (hk.pkl)"
    else if test -f "$target_dir/hk.toml"
        set -g hk_file "$target_dir/hk.toml"
        check_pass "hk config (hk.toml)"
    else if test -d "$target_dir/.hk"
        set -g hk_file "$target_dir/.hk"
        check_pass "hk config (.hk/)"
    else
        check_fail "hk config" "Create hk.pkl with a 10s pre-commit timeout and pre-push lint and test steps. See: https://hk.jdx.dev/"
    end
end

function check_hk_prepush
    collect_hk_flags

    if test -z "$hk_file"
        return
    end

    report_flag has_prepush_lint "pre-push: lint step" check_fail "Add a lint step to pre-push in hk config. Use: check = \"mise run lint\""
    report_flag has_prepush_test "pre-push: test step" check_fail "Add a test step to pre-push in hk config. Use: check = \"mise run test\""
end

function check_hk_precommit_timeout
    if test "$hk_file" != "$target_dir/hk.pkl"
        return
    end

    set -l timeout (awk '/\["pre-commit"\][[:space:]]*\{/ { hook = 1; depth = 0 } hook { depth += gsub(/\{/, "{"); depth -= gsub(/\}/, "}"); if (depth == 1 && match($0, /timeout[[:space:]]*=[[:space:]]*"[^"]+"/)) { value = substr($0, RSTART, RLENGTH); sub(/^[^"]*"/, "", value); sub(/"$/, "", value); print value; exit } if (depth <= 0) hook = 0 }' "$hk_file")
    if test -z "$timeout"
        check_fail "pre-commit: timeout" "Add timeout = \"10s\" to the pre-commit hook in hk.pkl, and move slow checks to pre-push."
    else if test (hk_duration_ms "$timeout") -gt 10000
        check_fail "pre-commit: timeout" "Lower the pre-commit timeout from $timeout to 10s or less, and move slow checks to pre-push."
    else
        check_pass "pre-commit: timeout ($timeout)"
    end
end

function hk_duration_ms
    set -l total 0
    for part in (string match -ar '\d+(?:ms|s|m|h)' -- $argv[1])
        set -l value (string match -r '^\d+' -- $part)
        switch (string replace -r '^\d+' '' -- $part)
            case ms
                set total (math $total + $value)
            case s
                set total (math $total + $value \* 1000)
            case m
                set total (math $total + $value \* 60000)
            case h
                set total (math $total + $value \* 3600000)
        end
    end
    echo $total
end

function collect_hk_flags
    set -g has_prepush_lint 0
    set -g has_prepush_test 0

    if test -z "$hk_file"; or not command -q hk
        return
    end

    set -l plan_output (builtin cd "$target_dir"; and hk run pre-push --plan --json --from-ref HEAD --to-ref HEAD 2>/dev/null)
    if test $status -ne 0
        return
    end

    set -l step_name ""
    for line in $plan_output
        set -l name_match (string match -r '"name": "([^"]+)"' -- "$line")
        if test (count $name_match) -gt 1
            set step_name $name_match[2]
            continue
        end

        if test -n "$step_name"; and string match -rq '"status": "included"' -- "$line"
            collect_hk_step_flag "$step_name"
            set step_name ""
        end
    end
end

function collect_hk_step_flag
    set -l step_name $argv[1]

    if string match -rq '(^|[-_:])(lint|standard|eslint|rubocop|clippy|ruff|biome)($|[-_:])' -- "$step_name"
        set -g has_prepush_lint 1
    end
    if string match -rq '(^|[-_:])(test|spec|check)($|[-_:])' -- "$step_name"
        set -g has_prepush_test 1
    end
end
