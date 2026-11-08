#!/usr/bin/env bash

set -euo pipefail

# Only root-level image files absent from HEAD are eligible. A file re-added
# since its deletion must keep its history, regardless of when it was deleted.
# Use files so long histories and filter lists do not fill shell variables or argv.
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
git log HEAD --no-renames --diff-filter=D --format= --name-only -- '*.jpeg' '*.png' '*.webp' > "$work_dir/deleted"
git ls-tree --name-only HEAD > "$work_dir/current"
declare -A current_images=()
while IFS= read -r path; do
    if [[ "$path" =~ ^[0-9a-z]{32}\.(jpeg|png|webp)$ ]]; then
        current_images["$path"]=1
    fi
done < "$work_dir/current"
declare -A seen_paths=()
purge_paths=()
while IFS= read -r path; do
    if [[ "$path" =~ ^[0-9a-z]{32}\.(jpeg|png|webp)$ ]] && [[ -z "${seen_paths[$path]+present}" ]]; then
        seen_paths["$path"]=1
        if [[ -z "${current_images[$path]+present}" ]]; then
            purge_paths+=("$path")
        fi
    fi
done < "$work_dir/deleted"

if (( ${#purge_paths[@]} == 0 )); then
    echo "No deleted image histories to purge."
    exit 0
fi

printf '%s\n' "${purge_paths[@]}" | sort > "$work_dir/purge"
mapfile -t purge_paths < "$work_dir/purge"
printf 'Purging history for %d image(s):\n' "${#purge_paths[@]}"
for ((index = 0; index < ${#purge_paths[@]} && index < 20; index++)); do
    printf '  %s\n' "${purge_paths[$index]}"
done
if (( ${#purge_paths[@]} > 20 )); then
    printf '  ... and %d more\n' "$((${#purge_paths[@]} - 20))"
fi

git filter-repo --force --invert-paths --paths-from-file "$work_dir/purge"
