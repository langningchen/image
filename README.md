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

Workers Static Assets serves matching static files directly. `/upload` always enters the Worker, and unmatched image URLs enter the Worker. The public uploader and `/admin/` each have a static HTML entry, so SPA fallback is disabled: missing images and unknown paths must return 404 rather than HTML. Existing `POST /upload`, `GET /<32 lowercase letters>` and `?search` preview URLs are preserved.

Access timestamps use monotonic SQL upserts: delayed requests cannot move the timestamp backward. Preview requests do not renew retention. Successful conditional (304) image requests renew retention. Cleanup initializes untracked GitHub images with seven days of grace, rechecks access before deletion, serializes GitHub commits and removes orphaned metadata. GitHub and D1 do not share a transaction; an access during the GitHub deletion call can still race with cleanup. Image locks are enforced through atomic D1 deletion claims.

Browser and service-worker image caches retain the existing long-lived caching behavior. Only requests reaching the Worker renew retention; cache hits do not. Removing an image on the server does not invalidate existing browser copies.

## Administration and upload controls

Open `/admin/` and sign in with `ADMIN_PASSWORD`. Set a strong random secret before deployment:

```sh
pnpm wrangler:remote secret put ADMIN_PASSWORD
pnpm db:migrate:remote
pnpm deploy
```

For local development, add `ADMIN_PASSWORD` to `.dev.vars`. Without it, all management APIs return 503. The admin password is kept only in page memory and sent as a Bearer credential over HTTPS; it is never written to browser storage. There is no public navigation link to the administration page.

- Lock images to exclude them from inactivity deletion. Unlocking resumes the existing inactivity timer. Deletion claims and locks are mutually exclusive in D1; an image already being deleted cannot be locked. Interrupted deletion claims are recovered by the next daily job after one hour.
- Add individual IPv4 or IPv6 addresses to the exemption list to skip content assessment. Addresses are normalized; CIDR ranges are not supported. Explicit IP bans take precedence over exemption.
- Rejected uploads record the Cloudflare-provided client IP, category and timestamp. Three violations in a fixed 24-hour window produce a warning; five pause uploads for 24 hours. Counters update atomically. Administrators can impose a 24-hour ban or lift it and reset strikes.
- View UTC daily charts for upload/download bytes, request counts and active IPs over 7, 30 or 90 days, plus the top 20 IPs ranked by bytes or upload attempts. IP summaries show upload attempts, successful/failed uploads, and today's UTC upload count. The IP management list includes observed IPs as well as manually configured IPs. Counts include failed requests and gallery previews. Upload bytes measure request data consumed by the Worker (including base64 encoding); download bytes measure response chunks delivered by the Worker. Native static assets and browser/service-worker cache hits are excluded. Statistics are asynchronous and can lag briefly. Activity records are retained for 90 days by the daily job.

New uploads from non-exempt IPs are assessed before any GitHub write using the Workers AI vision model [`@cf/meta/llama-3.2-11b-vision-instruct`](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/). AI errors and inconclusive results return a generic temporary failure without recording a violation. Explicit sexual content, sexualized minors, graphic violence, encouragement of self-harm, and hateful/terrorist propaganda are rejected. Assessment is probabilistic; existing stored images are not retroactively scanned. Uploaded data URLs are limited to 10 MiB and accept JPEG, PNG and WebP.

This model requires a one-time account-level acceptance of Meta's license and acceptable-use policy. Review the linked model documentation and, if you agree, send the initial `{"prompt":"agree"}` request using your own account credentials:

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/meta/llama-3.2-11b-vision-instruct" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"prompt":"agree"}'
```

The public uploader and administration interface do not display AI assessment details. They show generic upload errors, violation warnings and temporary suspensions where applicable. An AI binding is declared in Wrangler; no AI API key is embedded in the application. Local Workers AI calls use Cloudflare's remote service and can incur usage.

The overview also includes an interactive doughnut chart of all tracked images by cleanup eligibility: ready now, remaining 1–7 days, locked, and deleting. Individual image cards show their remaining retention time. These estimates describe when an image becomes eligible; the daily job performs the actual deletion. Renewed access and locking can change the distribution.

IP location previews use [Cloudflare request metadata](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties): country, region, city, ASN and network organization. The latest known location is saved with the existing daily traffic update, without a separate geolocation API call or an additional write per request. Location is approximate and is unavailable for historical records until a new request supplies metadata. IP management counts span retained activity (up to 90 days); ranking counts follow the selected 7/30/90-day range. Counters include failed upload attempts and do not impose a frequency limit.

## Setup and deployment

1. Install dependencies with `pnpm install`.
2. Create a dedicated private GitHub image repository and a PAT with repository contents read/write access.
3. Create D1 and set its returned UUID in your shell or CI environment:

   ```sh
   pnpm exec wrangler d1 create image-access
   export D1_DATABASE_ID="YOUR_DATABASE_UUID"
   ```

4. Apply the schema to the remote database:

   ```sh
   pnpm db:migrate:remote
   ```

5. Set the repository and credential bindings:

   ```sh
   pnpm wrangler:remote secret put GithubPAT
   pnpm wrangler:remote secret put GithubOwner
   pnpm wrangler:remote secret put GithubRepo
   ```

6. Configure your existing Worker custom domain/route in Cloudflare (the template preserves `workers_dev: false`), or enable `workers_dev` in the shared configuration if you want a workers.dev URL.
7. Set `ADMIN_PASSWORD` and complete the model activation described above, then validate and deploy:

   ```sh
   pnpm typecheck
   pnpm test
   pnpm deploy
   ```

`wrangler.jsonc` contains only a placeholder database UUID for local development. Remote commands generate the Git-ignored `wrangler.deploy.jsonc` from `D1_DATABASE_ID`. Resource IDs identify resources; they are not credentials, but keeping deployment-specific IDs outside Git makes the template reusable. Never commit the GitHub PAT, Cloudflare API token or `.dev.vars`. Remote migrations are an explicit step and are not silently run by deployment.

The daily Cron Trigger runs at 03:45 UTC. D1 Free currently includes 100,000 rows written/day; writes to indexed columns also update index rows and count toward usage. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

## Local development

Create a Git-ignored `.dev.vars` with `GithubPAT`, `GithubOwner` and `GithubRepo` (one `NAME=value` per line). Local requests still access that GitHub repository, so use a separate development image repository.

```sh
pnpm db:migrate:local
pnpm start
```

`start` builds the frontend and runs the Worker with local D1 at `http://localhost:8787`. For frontend hot reload, run `pnpm dev` in a second terminal; Vite proxies upload and image requests to the local Worker. Exercise cron at `http://localhost:8787/cdn-cgi/handler/scheduled`.

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
