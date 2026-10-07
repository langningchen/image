#!/usr/bin/env bash

set -euo pipefail

retention_days="${RETENTION_DAYS:-7}"
now_epoch="${NOW_EPOCH:-$(date -u +%s)}"

if ! [[ "$retention_days" =~ ^[0-9]+$ ]] || (( retention_days < 1 )); then
    echo "RETENTION_DAYS must be a positive integer." >&2
    exit 1
fi
if ! [[ "$now_epoch" =~ ^[0-9]+$ ]]; then
    echo "NOW_EPOCH must be a Unix timestamp." >&2
    exit 1
fi

cutoff_epoch=$((now_epoch - retention_days * 86400))
current_commit_epoch=0
declare -A latest_deletion_by_path=()

# The image service accepts 32-character lowercase alphanumeric image names at repository
# root. Restricting the match protects unrelated files from a history rewrite.
while IFS= read -r line; do
    if [[ "$line" == @@DELETE_COMMIT:* ]]; then
        current_commit_epoch="${line#@@DELETE_COMMIT:}"
    elif [[ "$line" =~ ^[0-9a-z]{32}\.(jpeg|png|webp)$ ]] && [[ -z "${latest_deletion_by_path[$line]+present}" ]]; then
        # git log is newest-first, so the first deletion seen is the latest one.
        latest_deletion_by_path["$line"]="$current_commit_epoch"
    fi
done < <(git log HEAD --no-renames --diff-filter=D --format='@@DELETE_COMMIT:%ct' --name-only -- '*.jpeg' '*.png' '*.webp')

purge_paths=()
for path in "${!latest_deletion_by_path[@]}"; do
    deletion_epoch="${latest_deletion_by_path[$path]}"
    if (( deletion_epoch <= cutoff_epoch )) && ! git cat-file -e "HEAD:$path" 2>/dev/null; then
        purge_paths+=("$path")
    fi
done

if (( ${#purge_paths[@]} == 0 )); then
    echo "No image histories are old enough to purge."
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
