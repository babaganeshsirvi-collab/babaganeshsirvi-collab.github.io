# Deployment status — 16 October 2026

Public site: https://babas-bar-restro.baba-ganeshsirvi.workers.dev

Worker `babas-bar-restro` is deployed with static assets, dedicated D1 storage and the internal SQLite-backed password hashing namespace. Current Worker version: `0e5ffc41-fb02-4e36-9b4a-6803fb43c560`.

The catalogue has 1,954 products, including 481 ImageGen-refined image entries and one separately counted AI-assisted cutout. Refinement and visual review remain incomplete. Accepted carton/label repairs for4014,2268 and4840 are copied into the public package. Phone/address remain hidden. Ordering, payments and SMS OTP remain disabled; checkout now reports unavailability without collecting details or simulating a payment. Admin image upload storage is not connected.

All26 local tests pass, including the real Pages/D1/external-Durable-Object runtime. Hosted owner login, password rotation, rejection of old credentials, session revocation and repeated login/logout passed. The current private owner login is in ignored `.private/admin-login.txt`; no credentials are public.

## Requested subdomain

The owner selected `bar.bababeardo.world` while keeping the existing main website. DNS remains at GoDaddy. Existing apex records, nameservers, email records and `restro` remain unchanged. No `bar` record has been added yet.

The isolated Pages build is ready. Cloudflare Pages authorization is pending due to OAuth session/CSRF errors. After authorization, create/deploy the Pages project, privately set the same admin runtime secrets, attach the exact custom hostname, and add only its confirmed `bar` CNAME target in GoDaddy. Verify HTTPS, both websites and the preserved DNS records afterward. Do not point DNS to an unverified/unclaimed Pages hostname.

## Earlier domain request

The owner confirmed `baba.in` was only added to Cloudflare, without registrar ownership/access. It is not a target for deployment. No DNS or nameserver changes were made for it.
