# Security

Conflux has accounts, private workspaces and owner / editor / viewer roles. The
server decides who may read or change a page; the buttons on screen only follow
its answer. It is still an early-stage project that has not been reviewed by an
outside security professional, so do not use it for sensitive or regulated
information.

## What is covered

- Passwords are stored as Argon2id hashes. Sessions are random tokens in an
  httpOnly cookie, and the database holds only a hash of each one.
- Every API route and every live connection checks the person's membership in
  the database. Someone outside a workspace gets the same "not found" answer as
  for an id that was never used.
- Viewers are connected read-only: the server ignores their edits. A modified
  browser does not change that.
- Removing a member, changing a role, signing out and deleting a workspace all
  reach open pages within a few seconds (the target is 5).
- Invite links are random, expire, can be limited in use, can be revoked, are
  stored only as hashes, and can never make someone an owner.
- Requests are validated, size-limited and rate limited. Writes that claim to
  come from another website are refused.
- Sessions end after 30 days without use, and 90 days after sign-in at the latest.


## What is not covered yet

- No password reset, email verification or two-factor sign-in.
- The sign-up form says when an email already has an account. Rate limits slow
  down anyone using that to look people up, but do not stop it.
- Rate limits are kept in memory, per server process, and start over when the
  server restarts.
- Content that already reached a person's device before they were removed cannot
  be taken back. The app deletes its saved copies when access is lost, but a
  modified client could keep them.
- It runs as a single server. Nothing is designed for several.
- There is no limit on how much one account can store, or on the traffic of one
  live connection. Add a storage quota and disk monitoring before opening sign-up
  to strangers.
- Passwords can be guessed from many addresses at once; there is no per-account
  lock, because without email recovery that would let anyone lock a person out.

## Running it on a public address

Use HTTPS in front of it, set `NODE_ENV=production`, set `CONFLUX_SECRET`,
`CONFLUX_ALLOWED_ORIGINS` and `CONFLUX_TRUST_PROXY`, and use a Postgres database
you back up (`DATABASE_URL`). The README lists every setting.

## Reporting a vulnerability

Please do not disclose a vulnerability in a public issue. Use GitHub's private
vulnerability reporting for this repository if it is enabled, or contact the
repository maintainer privately. Include what you did, what you expected and
what happened. I will answer as soon as I can; this is a one-person project.

There are no supported released versions with a security update policy yet.
