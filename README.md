# Baba's Bar & Restro

Portable GitHub source for Cloudflare Workers and Pages with static assets, D1 storage and internal password hashing. The site is publicly deployed on [Cloudflare Workers](https://babas-bar-restro.baba-ganeshsirvi.workers.dev), with source in [GitHub](https://github.com/babaganeshsirvi-collab/babaganeshsirvi-collab.github.io). The owner selected `bar.bababeardo.world` for a separate Cloudflare Pages deployment, preserving the existing main website and GoDaddy nameservers. Pages authorization and the new subdomain record are still pending; no existing DNS records have been changed. See [deployment status](docs/deployment-status.md).

The current catalogue has 1,954 products. The snapshot contains 481 ImageGen-refined image entries and one separately counted AI-assisted cutout; image refinement and visual review are still ongoing. All referenced product image files are included. Public menu, category descriptions, pricing, cart, favourites and current branding are preserved.

## Local verification

Use Node.js 24.15 or newer within version 24:

```sh
npm ci
npm run build
npm test
npm run preview
```

The temporary preview is at `http://127.0.0.1:8082`. It uses local, temporary storage and does not send SMS or payments. `dist/` is generated and ignored. Keep `public/`, `worker/`, `migrations/`, scripts and the lockfile in Git.

## Initial Cloudflare setup

After the owner signs in to a verified Cloudflare account, authorizes the intended GitHub repository, and approves provisioning/deployment:

1. Create a D1 database named `babas-restro-db`. Replace `REPLACE_WITH_CLOUDFLARE_D1_DATABASE_ID` in `wrangler.json` with the actual ID. No database is provisioned by this package.
2. Apply the schema using `npm run db:migrate:remote`. This command modifies the configured remote database. The migrations create only this application's `br_` tables; no old store database or customer records are included.
3. Run `npm run admin:bootstrap` once on a trusted computer. It saves a newly generated login and secret values under ignored `.private/` files with private file permissions. Do not commit, paste into chat, or expose those files. Set the three `BR_ADMIN_*` secrets in the Cloudflare Worker's runtime secrets, using `.private/admin-secrets.json` with Wrangler's secret bulk command or the dashboard. The initial password must be changed in admin before orders can be enabled.
4. Verify with `npm run build && npm test`. In Workers Builds use build command `npm run build && npm test`, deploy command `npm run deploy`, and repository root `/`. Initial deployment is to `workers.dev`. The deployment guard rejects the placeholder database ID; it does not provision resources.
5. After the first deployment, verify public browsing, disabled checkout/SMS, and private admin sign-in before any further activation.

The website can be public while its GitHub repository stays private. The `private: true` value in `package.json` prevents accidental npm publication; GitHub repository visibility is selected separately. The repository contains the application source and public assets. Private account tokens, credentials and runtime database files are excluded. The earlier repository history is preserved; its original README is archived in [docs](docs/previous-repository-readme.md).

## Separate subdomain with Pages

The Pages package supports a subdomain on external GoDaddy DNS. Follow [the Pages deployment guide](docs/pages-deployment.md). Deploy the existing Worker first so its private `AdminPasswordHasher` namespace is available, then use `npm run deploy:pages`. Pages uses the same D1 database and internal hashing namespace, with the same private admin runtime secrets. Do not register another database, reset credentials, replace the main website, or change nameservers.

The production Worker now offloads the unchanged 310,000-iteration password hash through an internal Durable Object. Live login, logout, password rotation and revoked-session checks passed. Owner credentials are saved only in the ignored private login file. See [admin authentication](docs/admin-auth.md).

## Optional image uploads

R2 is not required for the initial catalogue launch. Without it, admin image uploads report that storage is not connected, and existing static images remain available. After the owner enables R2 and approves creating a private bucket, add its actual binding to `wrangler.json`:

```json
"r2_buckets": [{ "binding": "BUCKET", "bucket_name": "your-actual-private-bucket-name" }]
```

Do not enable public bucket access. Uploads are served by the Worker; upload writes require an authenticated admin session and CSRF token.

## Ordering remains disabled

`worker/launch-seed.json` keeps ordering and policy approval off. No payment/SMS credentials are bundled. Checkout requires separately configured Razorpay keys and signed webhooks, policy approval, a changed admin password and provider acceptance testing. OTP requires a connected private HTTPS SMS relay and real delivery testing. Provider requests in tests are mocked; they do not verify a live service.

Service settings preserve Rajasthan-only delivery within India, dine-in 8% off, delivery 5% off, 24/7 hours and public support `ganesh@bababeardo.world`. Restaurant phone/address are not public. Existing D1 admin edits persist across redeployments; seeds initialize only missing settings. Keep private database backups and test restoration before taking real orders. No existing Python-preview database or legacy store content is migrated automatically.

The lockfile pins tooling. Miniflare stays on its compatible v4 API, with current patched Sharp and Undici overrides; Wrangler uses its own supported runtime. Re-run the tests after dependency changes.

The example in `docs/github-actions-ci.yml.example` is inactive. Build and test checks were run locally; automatic GitHub Actions or Cloudflare Git integration is not configured.

Official references: [Workers GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [runtime secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
