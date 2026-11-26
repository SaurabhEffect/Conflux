# Security

Conflux has accounts, private workspaces and owner / editor / viewer roles, and
a demo that needs no account. The server decides who may read or change a page;
the buttons on screen only follow its answer. It is still an early-stage project that has not been reviewed by an
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
- The no-account demo is kept apart from accounts: its own tables, its own cookie
  and its own kind of live-sync token, so a guest cannot open an account's pages
  and an account cannot open a demo's. Its invite link is a random secret that
  never travels in a web address and is stored only as a hash. A demo holds six
  people at most, limits how much a guest can send and how big a page can grow,
  ends by itself after 30 minutes without typing (3 hours at most), and is deleted
  when it ends. The demo's bot answers fixed sentences only and never repeats what
  a guest wrote.
- The code was reviewed once more for ways in, and what that found was fixed and
  tested. That was done by the assistant that helped write it, not by an
  independent person, so it is not an audit. 


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
- There is no limit on how much one account can store, or on how many bytes one
  live connection sends in a second (only on how many messages). Add a storage
  quota and disk monitoring before opening sign-up to strangers.
- Anyone can start a demo. Limits (5 an hour from one address, 100 alive at once)
  stop one person, not a crowd with many addresses. A demo's link cannot be
  cancelled on its own, only by ending the demo, and guests can write anything
  into a demo: nothing is moderated.
- Passwords can be guessed from many addresses at once; there is no per-account
  lock, because without email recovery that would let anyone lock a person out.

## Running it on a public address

Use HTTPS in front of it, set `NODE_ENV=production`, set `CONFLUX_SECRET`,
`CONFLUX_ALLOWED_ORIGINS` and `CONFLUX_TRUST_PROXY`, and use a Postgres database
you back up (`DATABASE_URL`). If you do not want the open demo, set
`CONFLUX_DEMO=false`; otherwise limit requests in the proxy or firewall too. The
README lists every setting.

## Reporting a vulnerability

Please do not disclose a vulnerability in a public issue. Use GitHub's private
vulnerability reporting for this repository if it is enabled, or contact the
repository maintainer privately. Include what you did, what you expected and
what happened. I will answer as soon as I can; this is a one-person project.

There are no supported released versions with a security update policy yet.
