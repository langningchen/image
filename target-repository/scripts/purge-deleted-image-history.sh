#!/usr/bin/env bash

set -euo pipefail

# Only root-level image files absent from HEAD are eligible. A file re-added
# since its deletion must keep its history, regardless of when it was deleted.
# Capture git log first so a failed history read stops the workflow.
deleted_paths="$(git log HEAD --no-renames --diff-filter=D --format= --name-only -- '*.jpeg' '*.png' '*.webp')"
declare -A seen_paths=()
purge_paths=()
while IFS= read -r path; do
    if [[ "$path" =~ ^[0-9a-z]{32}\.(jpeg|png|webp)$ ]] && [[ -z "${seen_paths[$path]+present}" ]]; then
        seen_paths["$path"]=1
        if ! git cat-file -e "HEAD:$path" 2>/dev/null; then
            purge_paths+=("$path")
        fi
    fi
done <<< "$deleted_paths"

if (( ${#purge_paths[@]} == 0 )); then
    echo "No deleted image histories to purge."
    exit 0
fi

mapfile -t purge_paths < <(printf '%s\n' "${purge_paths[@]}" | sort)
printf 'Purging history for %d image(s):\n' "${#purge_paths[@]}"
printf '  %s\n' "${purge_paths[@]}"

filter_args=()
for path in "${purge_paths[@]}"; do
    filter_args+=(--path "$path")
done

git filter-repo --force --invert-paths "${filter_args[@]}"
