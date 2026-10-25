# Authentication and schedule writes

The server requires `DATABASE_URL`. It no longer contains fallback database credentials.

At startup, a transaction removes the default password, adds `users.revision`,
creates `auth_sessions`, and hashes existing plaintext passwords using scrypt
(N=131072, r=8, p=1, a random salt). Existing passwords continue to work.
The migration is idempotent; password values are never logged.

Login and registration issue HttpOnly, SameSite=Strict cookies. Session tokens are
random; only SHA-256 token digests are stored in PostgreSQL. Sessions expire after
30 days. Logout revokes the session. Password changes revoke every previous
session. Saved-account switching requires the corresponding remembered cookie;
an account ID alone does not authenticate a user.

`GET /api/auth/accounts?ids=...` returns lightweight saved-account card metadata
(name, username, avatar) before login. Its `requiresPassword` flag is checked
against that account's cookie and an unexpired database session. It does not
return schedules, passwords or tokens, and its responses use `Cache-Control: no-store`.

Serve the UI and `/api` from the same origin. For HTTPS behind a reverse proxy,
set `COOKIE_SECURE=true` and configure `APP_ORIGINS` with the public origin(s).
The Vite development proxy preserves the original Host header. Writes require
`application/json`; cross-site browser writes are rejected. Login, registration
and password changes are rate-limited in this single-server process.

The server enforces self-only user mutations. Group creation uses the session
identity; accepted members can invite, users can respond only to their own pending
invitations, and owners manage group details, removal and ownership transfer.
Users can leave a group themselves. Permission checks and group mutations share
a transaction and lock the group row. Only accepted members may become owners.

Profile PUT and schedule PATCH require the last-read `revision`. A stale revision
returns HTTP 409. Unspecified profile fields are never rewritten. Day PUT accepts
`{ "expectedOverride": <previous value or null>, "override": <new value> }`;
day DELETE accepts `{ "expectedOverride": <previous value or null> }`.
Day updates atomically compare and change just that JSON key, so different days
can save concurrently. A stale value for the same day returns 409. The client
keeps the original edit snapshot even when SSE refreshes background data.

All schedule entry points validate times, actual calendar dates, cycle lengths,
weekly keys, status, and JSON shape. Overnight and overlapping intervals are valid.
`24:00` is accepted only as an end time; equal endpoints are rejected.

Run `node --test server/security.test.cjs` (or `pnpm test`). Tests use the database
connection from `.env` to create an isolated random schema, start a server against
only that schema, and remove it afterward. They require CREATE SCHEMA permission.
Existing application tables are not used for test writes. Use a dedicated test
database via `DATABASE_URL` in CI.
