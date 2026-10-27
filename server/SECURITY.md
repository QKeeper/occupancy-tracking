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
Day updates lock the user, compare only the requested day's snapshot, and replace
the day and its interval rows in a transaction. Different days can save without
overwriting one another. A stale value for the same day returns 409. The client
keeps the original edit snapshot even when SSE refreshes background data.

Manual overrides are stored in `day_overrides` (user, date, status, day note,
IANA timezone) and `occupancy_intervals` (start/end `timestamptz`, position).
A free day remains a day row with no intervals. Deleting the day cascades only
its intervals and restores the regular schedule for that day. Weekly and
shift-cycle rules remain in `users.schedule_config` JSONB.

Startup migrates legacy `users.overrides` in a transaction. It reconstructs and
compares every old document before dropping the JSONB column; any mismatch rolls
back the whole migration. Repeated startup is safe. `user_profiles` and
`manual_override_documents` are read-only projections used for API compatibility;
there is no second writable copy of manual data.

`SCHEDULE_TIMEZONE` defaults to `Asia/Yekaterinburg` and supplies the zone for new
manual days and legacy migration. Existing days retain their stored zone. Midnight
and overnight slots preserve the old `HH:MM` representation, including `24:00`.
Notes are stored at the day level (`day_overrides.note`); time slots only contain
`start` and `end`. Overlaps are intentional and no exclusion constraint merges or
prohibits them.

`GET /api/users/:id/overrides?from=YYYY-MM-DD&to=YYYY-MM-DD` returns own manual
days and absolute interval timestamps. Both bounds are optional and inclusive on
the override's source date, not interval intersection. Interval IDs are strings
because PostgreSQL uses BIGSERIAL, and change when a whole day is replaced.
`GET /api/users/:id/overrides/:date` returns `{date, override}`; pass that snapshot
as `expectedOverride` for PUT/DELETE. Profile PUT no longer accepts `overrides`.
The generated OpenAPI specification and llms.txt describe these contracts.

All schedule entry points validate times, actual calendar dates, cycle lengths,
weekly keys, status, and JSON shape. Overnight and overlapping intervals are valid.
`24:00` is accepted only as an end time; equal endpoints are rejected.

Run `node --test server/security.test.cjs` (or `pnpm test`). Tests use the database
connection from `.env` to create an isolated random schema, start a server against
only that schema, and remove it afterward. They require CREATE SCHEMA permission.
Existing application tables are not used for test writes. Use a dedicated test
database via `DATABASE_URL` in CI.
