# Image

A simple image hosting service built with React, Vite, Cloudflare Workers and D1. Image bytes remain in a dedicated private GitHub repository; D1 stores image access times, management settings, upload violations and traffic aggregates.

## Architecture

- `index.html` and `src/main.tsx`: Vite entry; `src/frontend/`: React UI.
- `public/`: source static files such as `sw.js`; `dist/`: ignored production build with hashed asset filenames.
- `src/worker/index.ts`: HTTP and scheduled entry points.
- `src/worker/handlers/`: upload and image responses, including CORS and conditional requests.
- `src/worker/repositories/`: GitHub API and parameterized D1 queries.
- `src/worker/services/cleanup.ts`: daily reconciliation and inactivity cleanup.
- `migrations/`: versioned D1 schema; `scripts/`: deployment configuration and KV import.

Workers Static Assets serves matching static files directly. `/upload` always enters the Worker, and unmatched image URLs enter the Worker. The public uploader and `/admin/` each have a static HTML entry, so SPA fallback is disabled: missing images and unknown paths must return 404 rather than HTML. Existing `POST /upload`, `GET /<32 lowercase letters or digits>` and `?search` preview URLs are preserved.

Access timestamps use monotonic SQL upserts: delayed requests cannot move the timestamp backward. Preview requests do not renew retention. Successful conditional (304) image requests renew retention. Cleanup initializes untracked GitHub images with seven days of grace, rechecks access before deletion, serializes GitHub commits and removes orphaned metadata. GitHub and D1 do not share a transaction; an access during the GitHub deletion call can still race with cleanup. Image locks are enforced through atomic D1 deletion claims.

Browser and service-worker image caches retain the existing long-lived caching behavior. Only requests reaching the Worker renew retention; cache hits do not. Removing an image on the server does not invalidate existing browser copies.

## Administration and upload controls

Open `/admin/` and sign in with `ADMIN_PASSWORD`. Set a strong random secret before deployment:

```sh
pnpm wrangler:remote secret put ADMIN_PASSWORD
pnpm deploy
```

For local development, add `ADMIN_PASSWORD` to `.dev.vars`. Without it, all management APIs return 503. The admin password is kept only in page memory and sent as a Bearer credential over HTTPS; it is never written to browser storage. There is no public navigation link to the administration page.

- Lock images to exclude them from inactivity deletion. Unlocking resumes the existing inactivity timer. Deletion claims and locks are mutually exclusive in D1; an image already being deleted cannot be locked. Interrupted deletion claims are recovered by the next daily job after one hour.
- Add individual IPv4 or IPv6 addresses to the exemption list to skip content assessment. Addresses are normalized; CIDR ranges are not supported. Explicit IP bans take precedence over exemption.
- Rejected uploads record the Cloudflare-provided client IP, category and timestamp. Three violations in a fixed 24-hour window produce a warning; five pause uploads for 24 hours. Counters update atomically. Administrators can impose a 24-hour ban or lift it and reset strikes.
- View UTC daily charts for upload/download bytes, request counts and active IPs over 7, 30 or 90 days, plus the top 20 IPs ranked by bytes or upload attempts. IP summaries show upload attempts, successful/failed uploads, and today's UTC upload count. The IP management list includes observed IPs as well as manually configured IPs. Counts include failed requests and gallery previews. Upload bytes measure request data consumed by the Worker (including base64 encoding); download bytes measure response chunks delivered by the Worker. Native static assets and browser/service-worker cache hits are excluded. Statistics are asynchronous and can lag briefly. Activity records are retained for 90 days by the daily job.

New uploads from non-exempt IPs are assessed before any GitHub write using the Workers AI vision model [`@cf/meta/llama-3.2-11b-vision-instruct`](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/). Provider errors, a 20-second timeout, malformed output and inconclusive results follow a configurable fallback: **allow upload by default**, or **deny upload**. These failures never record user violations. Workers AI may return a verdict object in `response` despite the generated type declaring a string. Both object verdicts and text (complete JSON, Markdown-fenced JSON, or a single flat verdict surrounded by prose) are strictly validated; a plain natural-language description is treated as a failed assessment. Explicit sexual content, sexualized minors, graphic violence, encouragement of self-harm, and hateful/terrorist propaganda are rejected. Assessment is probabilistic; existing stored images are not retroactively scanned. JPEG, PNG and WebP uploads retain their original storage format and response MIME type. PNG files bypass canvas compression to preserve transparent pixels; large WebP files retain WebP encoding. Uploaded data URLs are limited to 10 MiB and accept JPEG, PNG and WebP.

This model requires one-time account-level acceptance of Meta's license and acceptable-use policy. After deployment, the authorized Cloudflare account operator must open `/admin/` → **Model setup**, read the linked license/policy, explicitly confirm acceptance and non-EU operator eligibility, then select **Agree and activate model**. The authenticated endpoint sends `{"prompt":"agree"}` to Workers AI. No license is automatically accepted on an upload or on deployment. Activation failure leaves assessment unavailable and does not count as a user violation.

Before uploading, users must explicitly accept the [Terms of Service](/terms.html), model license/policy and eligibility statement. Upload controls (including paste and drag/drop) appear only after acceptance. The accepted version is stored in the browser; **Review consent** clears it. All `POST /upload` clients, including exempt IPs, must send `X-Terms-Version: 2026-10-07.2` after obtaining agreement; missing/outdated versions return 428 before reading the image or calling AI/GitHub. This header is a client declaration, not identity verification or a server-side consent audit. When terms change, update both `src/terms.ts` and `public/terms.html` so users must accept again.

The public uploader shows generic errors, violation warnings and temporary suspensions. Assessment failure details are visible only through authenticated administration APIs and the management interface. An AI binding is declared in Wrangler; no AI API key is embedded in the application. Local Workers AI calls use Cloudflare's remote service and can incur usage.

### AI fallback and manual review

Apply `migrations/0005_moderation_fallback.sql` before running this version (`pnpm deploy` applies it automatically). In `/admin/` → **Model setup**, choose **Allow upload (default)** or **Deny upload**. D1 persists the selection; explicit unsafe verdicts, bans, consent requirements and image validation still take precedence. If the policy/audit database is unavailable, uploads fail rather than bypassing management.

Allowed fallback uploads reserve an `error` image record and audit event in a D1 transaction before storing bytes in GitHub. The record includes uploader IP, upload time, failure category/message and at most 2,000 characters of the model response. The overview shows moderation counts; **Images / Review** filters all images by status on the server with pagination. Review the preview/details, then **Approve** to record a manual decision or **Remove** to delete the image from current GitHub storage. Unlock locked images first. Deletion claims prevent races with cleanup or another review; failed removals release the claim and leave the image flagged for retry. Approval preserves the original failure evidence.

**Assessment audit** contains failure decisions and manual actions, newest first with pagination, including denied attempts (no image bytes are retained), uploader IP, diagnostics, storage outcome and current image status. Audit records survive image removal and expire after 90 days; evidence attached to an existing image stays with its metadata. Confirmed storage failures remove reserved image metadata. A transport error or unexpected GitHub response can leave a **pending** outcome because the file may already have been written; evidence is preserved for reconciliation and review. Recent upload reservations receive one hour of protection from orphan cleanup based on an older repository snapshot. The assessment timeout bounds the upload's wait; it does not cancel the underlying inference request.

### Debugging real model responses

In `/admin/` → **Model setup** → **Test image assessment**, select an image to invoke the same model and parser as production. It shows the actual allow/reject verdict, response format (`object` or `text`), response excerpt and duration. A failed/inconclusive assessment is displayed as an error rather than silently using fallback. Tests do not host the image, write an audit record or record an IP violation. Missing, empty, wrong-type and oversized responses have distinct error codes; missing response fields include the returned top-level key names for diagnosis.

For reproducible real-model checks using four synthetic fixtures:

```sh
# Supply your account ID; use a current Wrangler login or CLOUDFLARE_API_TOKEN.
CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID pnpm debug:moderation
```

This runs the production assessment function against the real Workers AI API, validates benign landscape/portrait images and rejects a terrorist propaganda poster with and without an embedded instruction to output a safe verdict. The command exits nonzero on any mismatch or inference error and never accepts licenses or invokes upload fallback. `MODERATION_DEBUG_REPEATS=2` optionally repeats the checks. Fixture outcomes are a regression check, not a guarantee for all images.

On 2026-10-07, all four fixtures returned the expected verdict through both the real API and a temporary Worker with a real AI binding. Every response contained a structured verdict object; binding calls took approximately 0.8–1.5 seconds. This reproduced the former `invalid_response` error: our string-only parser rejected already-correct object verdicts.

Image deletion cannot invalidate copies in browsers/service-worker caches or Git history. Historical uploads that failed before this migration have no stored bytes or assessment audit and cannot be reconstructed for preview.

The overview also includes an interactive doughnut chart of all tracked images by cleanup eligibility: ready now, remaining 1–7 days, locked, and deleting. Individual image cards show their remaining retention time. These estimates describe when an image becomes eligible; the daily job performs the actual deletion. Renewed access and locking can change the distribution.

IP location previews use [Cloudflare request metadata](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties): country, region, city, ASN and network organization. The latest known location is saved with the existing daily traffic update, without a separate geolocation API call or an additional write per request. Location is approximate and is unavailable for historical records until a new request supplies metadata. IP management counts span retained activity (up to 90 days); ranking counts follow the selected 7/30/90-day range. Counters include failed upload attempts and do not impose a frequency limit.

## Setup and deployment

1. Install dependencies with `pnpm install`.
2. Create a dedicated private GitHub image repository and a PAT with repository contents read/write access.
3. Set the repository credentials and administrator password:

   ```sh
   pnpm wrangler:remote secret put GithubPAT
   pnpm wrangler:remote secret put GithubOwner
   pnpm wrangler:remote secret put GithubRepo
   pnpm wrangler:remote secret put ADMIN_PASSWORD
   ```

4. Configure your Worker custom domain/route in Cloudflare (`workers_dev` is disabled), or enable `workers_dev` in the shared configuration for a workers.dev URL. Keep any production routes and preview settings in your deployment configuration so that deployments do not overwrite dashboard settings unexpectedly.
5. Validate and deploy, then complete the model activation described above before assessed uploads:

   ```sh
   pnpm typecheck
   pnpm test
   pnpm deploy
   ```

`wrangler.jsonc` intentionally omits `database_id`. Wrangler supports [automatic resource provisioning](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/): local development works without an ID, and direct deployment can associate or create the named database. Never use an empty string or an all-zero UUID as a placeholder.

`pnpm deploy` builds the frontend, finds or creates `image-access`, applies all remote migrations, and then publishes the Worker. Authentication or migration failures stop publication. It generates a Git-ignored `wrangler.deploy.jsonc`, so Wrangler's resource ID writeback never modifies the shared configuration. Set `D1_DATABASE_ID` only when explicitly selecting a different existing database. Standalone remote migrations require the database to exist already.

In **Cloudflare Workers Builds**, use `pnpm build` as the build command and `pnpm deploy` as the deploy command, replacing `npx wrangler deploy`. The latter supports provisioning but does not apply this application's D1 migrations. Both local and hosted deployments require Cloudflare credentials with D1 and Worker deployment permissions. Resource IDs are identifiers rather than secrets; omitting them makes the public template portable. Never commit the GitHub PAT, Cloudflare API token or `.dev.vars`.

The daily Cron Trigger runs at 03:45 UTC. D1 Free currently includes 100,000 rows written/day; writes to indexed columns also update index rows and count toward usage. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

## Local development

Create a Git-ignored `.dev.vars` with `GithubPAT`, `GithubOwner` and `GithubRepo` (one `NAME=value` per line). Local requests still access that GitHub repository, so use a separate development image repository.

```sh
pnpm db:migrate:local
pnpm start
```

`start` builds the frontend and runs the Worker with local D1 at `http://localhost:8787`. For frontend hot reload, run `pnpm dev` in a second terminal; Vite proxies upload and image requests to the local Worker. Exercise cron at `http://localhost:8787/cdn-cgi/handler/scheduled`.

## Alphanumeric image IDs

Image IDs accept exactly 32 characters from `a-z` and `0-9`, including legacy IDs containing digits. Upload response validation, image routes, traffic recording, admin review/lock routes and cursors, service-worker caching, the Vite proxy, KV import and history cleanup use this format. The current generator still produces letters only; those IDs remain valid.

Apply `migrations/0006_alphanumeric_image_ids.sql` before using numeric IDs in D1. It rebuilds the old letter-only CHECK constraint while preserving all image records, access times, locks, deletion claims and moderation evidence, and recreates the indexes. `pnpm deploy` applies it automatically. Historical migration `0001` intentionally retains its original schema. If the purge-history script is installed in a separate image repository, copy the updated script there as well.

## Migrating existing KV access times

Import before switching production to D1 if you want to preserve existing inactivity timers. Export the old KV keys using their namespace ID (pass it locally; do not commit it):

```sh
pnpm exec wrangler kv key list --namespace-id YOUR_OLD_KV_NAMESPACE_ID --prefix image: > kv-export.json
pnpm db:import:kv kv-export.json kv-import.sql
pnpm wrangler:remote d1 execute DB --remote --file kv-import.sql
```

The importer accepts Wrangler key-list metadata (`name`, `metadata.lastAccessedAt`) or bulk JSON records (`key`, `value`). It rejects image keys with missing/invalid timestamps; export those values explicitly rather than silently resetting retention. Imports preserve the maximum timestamp already in D1. Export all pages if your export mechanism paginates. For a consistent cutover, pause uploads/traffic while exporting and importing, or accept that accesses after the snapshot are absent from the import.

If you skip importing, the first daily cleanup initializes existing images with a fresh seven-day grace period. After verifying D1 in production, retire the old KV namespace manually.

## Purge deleted files from Git history

Deleting a file normally leaves its content in Git history. This repository includes a second cleanup stage under `target-repository/`:

- `scripts/purge-deleted-image-history.sh` finds root-level image files that are absent from `HEAD` and whose latest deletion commit is at least seven days old. It removes those paths from the branch's entire history with `git-filter-repo`.
- `.github/workflows/purge-deleted-image-history.yml` runs the script every day at `04:23 UTC` and performs a lease-protected force-push only when history changed.

Deploy these two files **in the dedicated target image repository**, not only in this application repository. From a checkout of this project, copy them into a checkout of the target repository:

```sh
cp -R target-repository/.github /path/to/image-data/
mkdir -p /path/to/image-data/scripts
cp target-repository/scripts/purge-deleted-image-history.sh /path/to/image-data/scripts/
chmod +x /path/to/image-data/scripts/purge-deleted-image-history.sh
```

Commit and push the copied files in the target repository. Then:

1. Open the target repository's **Settings → Actions → General** and set **Workflow permissions** to **Read and write permissions**.
2. Ensure the default branch permits this workflow to force-push. Branch protection or rulesets that reject force-pushes must be adjusted for this dedicated repository.
3. Keep the target repository dedicated to image storage, with one active branch and no tags that retain old image objects. The supplied workflow rewrites and pushes only the branch on which it runs.
4. Run **Purge deleted image history → Run workflow** once to verify the setup.

The push uses `--force-with-lease`. If an upload changes the target branch while cleanup is running, the push fails safely instead of overwriting that upload; the next daily run can retry. History rewrites change commit IDs and invalidate old clones, so do not install this workflow in a general-purpose source repository. GitHub may also take time to compact unreachable server-side objects, so displayed repository size may not fall immediately.

## License

This project is licensed under the terms of the GNU General Public License v3.0.

### Environment configuration

Set non-secret Worker variables in `wrangler.jsonc` under `vars` (or in the deployment configuration); use `.dev.vars` locally. Defaults preserve existing behavior:

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMAGE_RETENTION_DAYS` | `7` | Positive inactivity period in days, up to 3650; fractional days supported. Applies to existing images too. |
| `AI_MODERATION_ENABLED` | `true` | `false` skips upload AI assessment and records `moderation_disabled`; IP bans and consent still apply. |
| `AI_MODERATION_TIMEOUT_MS` | `20000` | Positive assessment timeout, up to 300000 milliseconds. |
| `AI_MODERATION_FALLBACK` | unset | `allow` or `deny`; when set, overrides the persisted admin setting and prevents changing it through the admin API. |

The public `/api/config` endpoint exposes the retention period and AI enabled flag only. Cleanup eligibility, admin cards and retention statistics use the same configured period. The daily cron remains configured through Wrangler `triggers.crons`.

**Images / Review** supports combined server-side moderation status, retention state (locked, unlocked, deleting, expired, expiring within 24 hours, active), approval source, partial image ID and exact uploader IP filters. Search applies before pagination; resetting filters restores all images. Expiry filters use the configured inactivity period and exclude locked/deleting images.
