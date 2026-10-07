# Image

A simple image hosting service built with React, Vite, Cloudflare Workers and D1. Image bytes remain in a dedicated private GitHub repository; D1 stores image access times for the seven-day inactivity cleanup.

## Architecture

- `index.html` and `src/main.tsx`: Vite entry; `src/frontend/`: React UI.
- `public/`: source static files such as `sw.js`; `dist/`: ignored production build with hashed asset filenames.
- `src/worker/index.ts`: HTTP and scheduled entry points.
- `src/worker/handlers/`: upload and image responses, including CORS and conditional requests.
- `src/worker/repositories/`: GitHub API and parameterized D1 queries.
- `src/worker/services/cleanup.ts`: daily reconciliation and inactivity cleanup.
- `migrations/`: versioned D1 schema; `scripts/`: deployment configuration and KV import.

Workers Static Assets serves matching static files directly. `/upload` always enters the Worker, and unmatched image URLs enter the Worker. This app has one page, so SPA fallback is disabled: missing images and unknown paths must return 404 rather than HTML. Existing `POST /upload`, `GET /<32 lowercase letters>` and `?search` preview URLs are preserved.

Access timestamps use monotonic SQL upserts: delayed requests cannot move the timestamp backward. Preview requests do not renew retention. Successful conditional (304) image requests renew retention. Cleanup initializes untracked GitHub images with seven days of grace, rechecks access before deletion, serializes GitHub commits and removes orphaned metadata. GitHub and D1 do not share a transaction; an access during the GitHub deletion call can still race with cleanup.

Browser and service-worker image caches retain the existing long-lived caching behavior. Only requests reaching the Worker renew retention; cache hits do not. Removing an image on the server does not invalidate existing browser copies.

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
7. Validate and deploy:

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
