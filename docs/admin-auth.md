# Admin password verification

The HTTP Worker sends password derivation to the internal `ADMIN_PASSWORD_HASHER`
Durable Object binding. A single named instance, `admin-pbkdf2-v1`, handles these
RPC calls. The class has no hashing HTTP endpoint and writes nothing to its
SQLite-backed storage. Passwords are not logged, cached or persisted by the object.

Credentials remain in the existing private D1 `br_credentials` table. The hash
format is unchanged: PBKDF2-HMAC-SHA256, 310,000 iterations, 32 output bytes,
hex-decoded salt and lowercase hexadecimal output. Native WebCrypto is attempted
inside the object; when the runtime rejects its iteration count, the existing
`@noble/hashes` implementation computes the same derivation. The HTTP Worker never
performs this fallback itself. A missing binding, failed RPC or invalid result
returns HTTP 503 and creates no authenticated session.

Login attempts pass the existing atomic D1 rate limit before invoking hashing.
Password changes still verify the current password, atomically replace its salt
and hash, revoke all admin sessions and leave customer sessions intact. This
change does not rotate credentials or reset existing data.

## Deployment

`wrangler.json` declares the internal binding and the
`admin-password-hasher-v1` migration with `new_sqlite_classes`. The Worker exports
`AdminPasswordHasher`; the build keeps the runtime-provided `cloudflare:workers`
module external. SQLite-backed Durable Objects are available on the Workers Free
plan, so this configuration does not require a paid plan. The documented Durable
Object CPU budget is separate from the HTTP Worker's 10 ms free-plan budget.

Free request, compute-duration and storage quotas still apply; operations fail
when free quotas are exhausted. The namespace is used only for bounded admin
authentication work, not for customer password hashing or general public compute.

After deployment, test login, private admin read, logout, a second login, password
change and session revocation. Local Workerd tests check the RPC binding and exact
hash compatibility, but cannot establish the hosted CPU budget or resource
provisioning. Confirm successful hosted invocations in Cloudflare logs before
reporting admin acceptance complete.

References: [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Free quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Worker CPU limits](https://developers.cloudflare.com/workers/platform/limits/).
