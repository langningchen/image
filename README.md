# Image

> A lightweight image hosting service with AI moderation and an administration dashboard.

Built with React, Cloudflare Workers and D1. Images are stored in a dedicated private GitHub repository.

## Features

- Upload JPEG, PNG and WebP by selecting, dragging or pasting images.
- Configure a maximum image edge and upload size independently from the admin settings, or disable either limit.
- AI moderation, optional upload password and automatic inactivity cleanup.
- Administration at `/admin/`: image filters, manual review, retention locks, IP controls and traffic statistics.
- Sync the data repository’s daily deleted-image history cleanup workflow and script from Settings.

## Quick Start

Requires Node.js 22.15+ and pnpm. Create a dedicated private GitHub data repository and initialize it with a README so its default branch exists. Create a fine-grained PAT with access to that repository and **Contents: Read and write** plus **Workflows: Read and write** permissions. For a classic PAT, use the `repo` and `workflow` scopes.

Configure a custom domain/route in `wrangler.jsonc`, or enable `workers_dev` before deployment. Then authenticate Wrangler, set the data repository credentials and administrator password, and deploy:

```sh
pnpm install
pnpm exec wrangler login
pnpm wrangler:remote secret put GITHUB_OWNER
pnpm wrangler:remote secret put GITHUB_REPO
pnpm wrangler:remote secret put GITHUB_PAT
pnpm wrangler:remote secret put ADMIN_PASSWORD
pnpm deploy
```

Deployment creates or reuses D1 and applies migrations automatically. After deployment:

1. Open `/admin/`, sign in with `ADMIN_PASSWORD`, and go to **Settings → Daily history cleanup → Sync to data repository**. This installs or updates the Actions workflow and cleanup script together; no manual file copying is needed. Re-sync after upgrading the application to apply updated templates.
2. In the data repository, enable GitHub Actions, allow workflow read/write permissions, and ensure the default branch permits the cleanup workflow to force-push. See the [history cleanup setup](docs/guide.md#purge-deleted-files-from-git-history) for details.
3. Open the data repository's **Actions → Purge deleted image history → Run workflow** to verify it. The workflow then runs daily at **00:00 UTC (08:00 China time)** and purges Git history for images already deleted from the current branch.
4. With AI enabled, complete **Settings → Connect image assessment** in `/admin/` before accepting uploads.

Inactive images are removed by the Worker's daily cleanup according to `IMAGE_RETENTION_DAYS`. To run it immediately, use **Overview / Image library → Clean up expired images**. The data repository's Action handles Git history cleanup separately.

## Configuration

Use Worker secrets for credentials and the Cloudflare dashboard or `wrangler.jsonc` → `vars` for other settings. Deployments preserve dashboard variables (`keep_vars: true`). For local development, put variables in a Git-ignored `.dev.vars`.

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_OWNER` | required | Image repository owner. |
| `GITHUB_REPO` | required | Image repository name. |
| `GITHUB_PAT` | required | GitHub token with contents read/write access and workflow write access for syncing data repository configuration. |
| `ADMIN_PASSWORD` | unset | Administration password; unset disables administration. |
| `UPLOAD_PASSWORD` | unset | Optional password required for all uploads. |
| `IMAGE_RETENTION_DAYS` | `7` | Inactivity period in days; positive, at most 3650. |
| `AI_MODERATION_ENABLED` | `true` | Set to `false` to skip upload AI assessment. |
| `AI_MODERATION_TIMEOUT_MS` | `20000` | Assessment timeout; positive, at most 300000 ms. |
| `AI_MODERATION_FALLBACK` | unset | `allow` or `deny`; overrides the admin setting (initially `allow`). |

Image processing and upload limits are managed in `/admin/` → **Settings**. The defaults are a 1920 px longest edge and a 10 MiB upload body. Each can be changed independently or disabled. The uploader resizes oversized images, while the Worker independently rejects direct uploads over the configured edge. Disabling the upload limit removes only the application-level check; Cloudflare request-size limits still apply.

Upgrading from mixed-case names? Recreate `GithubOwner`, `GithubRepo` and `GithubPAT` as `GITHUB_OWNER`, `GITHUB_REPO` and `GITHUB_PAT` before deploying, and update local `.dev.vars`. Old names are no longer read.

## Development

```sh
pnpm db:migrate:local
pnpm start
# In another terminal, for frontend hot reload:
pnpm dev
```

Run `pnpm typecheck`, `pnpm test` and `pnpm build` to validate changes. Local uploads access the configured GitHub repository; use a separate development repository.

## Documentation

See the [deployment and operations guide](docs/guide.md) for moderation, API usage, KV migration and Git history cleanup. Only image requests reaching the Worker renew retention; cached copies and Git history can outlive server deletion.

## Known Issues

See [GitHub Issues](https://github.com/langningchen/image/issues).

## License

[GNU General Public License v3.0](LICENSE).
