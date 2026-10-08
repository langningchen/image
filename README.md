# Image

> A lightweight image hosting service with AI moderation and an administration dashboard.

Built with React, Cloudflare Workers and D1. Images are stored in a dedicated private GitHub repository.

## Features

- Upload JPEG, PNG and WebP by selecting, dragging or pasting images.
- AI moderation, optional upload password and automatic inactivity cleanup.
- Administration at `/admin/`: image filters, manual review, retention locks, IP controls and traffic statistics.

## Quick Start

Requires Node.js 22.15+ and pnpm. Create a private GitHub image repository and a PAT with contents read/write access, then authenticate Wrangler with your Cloudflare account.

```sh
pnpm install
pnpm exec wrangler login
pnpm wrangler:remote secret put GITHUB_OWNER
pnpm wrangler:remote secret put GITHUB_REPO
pnpm wrangler:remote secret put GITHUB_PAT
pnpm wrangler:remote secret put ADMIN_PASSWORD
pnpm deploy
```

Configure a custom domain/route in `wrangler.jsonc`, or enable `workers_dev` before deployment. Deployment creates or reuses D1 and applies migrations automatically. With AI enabled, complete model license activation in `/admin/` → **Model setup** before accepting uploads.

## Configuration

Use Worker secrets for credentials and `wrangler.jsonc` → `vars` for other settings. For local development, put variables in a Git-ignored `.dev.vars`.

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_OWNER` | required | Image repository owner. |
| `GITHUB_REPO` | required | Image repository name. |
| `GITHUB_PAT` | required | GitHub token with contents read/write access. |
| `ADMIN_PASSWORD` | unset | Administration password; unset disables administration. |
| `UPLOAD_PASSWORD` | unset | Optional password required for all uploads. |
| `IMAGE_RETENTION_DAYS` | `7` | Inactivity period in days; positive, at most 3650. |
| `AI_MODERATION_ENABLED` | `true` | Set to `false` to skip upload AI assessment. |
| `AI_MODERATION_TIMEOUT_MS` | `20000` | Assessment timeout; positive, at most 300000 ms. |
| `AI_MODERATION_FALLBACK` | unset | `allow` or `deny`; overrides the admin setting (initially `allow`). |

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
