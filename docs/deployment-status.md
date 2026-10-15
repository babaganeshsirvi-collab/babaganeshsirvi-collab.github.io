# Deployment status — 15 October 2026

Public site: https://babas-bar-restro.baba-ganeshsirvi.workers.dev

The Worker `babas-bar-restro` is deployed with static assets and a dedicated D1 database. The production catalogue contains 1,954 products and 482 refined image entries. Refinement and visual review remain incomplete. Public browsing, sample product images and configuration endpoints passed HTTP checks. Checkout, payments and SMS OTP remain disabled. Admin upload storage is not connected.

## Requested domain: baba.in

Cloudflare reports the zone as `pending`. Its assigned nameservers are `grace.ns.cloudflare.com` and `skip.ns.cloudflare.com`; public delegation currently points to BigRock nameservers. No custom-domain route or DNS record has been changed.

Before changing nameservers, confirm registrar ownership/access and preserve the complete existing DNS zone. Read-only checks found matching Zoho MX and DMARC records at the assigned Cloudflare nameserver, but the current apex SPF and Zoho verification TXT records appeared missing. A complete registrar DNS export is required to preserve other records such as DKIM and subdomains. Do not change delegation based only on a partial DNS scan.

After ownership/access and DNS preservation are confirmed, activate the Cloudflare zone, add the Worker custom domain and verify HTTPS on baba.in. The current deployment guard intentionally permits workers.dev only until that final setup is prepared.

## Operations

The ignored `.private/admin-login.txt` contains owner credentials; never publish it. Initial credentials are randomly generated and runtime secrets are installed privately. No payment/SMS credentials are configured. Do not enable paid services, ordering or a gateway without the separate setup and acceptance checks described in the README.
