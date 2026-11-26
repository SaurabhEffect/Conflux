# Conflux

**Collaboration in sync.**

[![CI](https://github.com/SaurabhEffect/Conflux/actions/workflows/ci.yml/badge.svg)](https://github.com/SaurabhEffect/Conflux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

I built Conflux as a real-time collaborative workspace where people can work on
the same page and see each other's edits and cursors as they happen. It is an
early-stage portfolio project. This version has a demo that needs no account,
with a bot that works on the page beside you, on top of accounts and
permissions: private workspaces, owner / editor / viewer roles, and invite
links. It is meant to run on your own computer.

## What it can do

- **Try it without an account.** One button opens a throw-away workspace with
  three starter pages. Send a link to up to five other people and write
  together. Everything is deleted when the demo ends: the person who started it
  can end it, and it ends by itself after 30 minutes with nobody typing, or 3
  hours at the most.
- **A bot that works next to you.** Write `@bot help` on its own line and press
  Enter. The bot is a participant in the live page with its own name, colour and
  cursor, and it types its answer under your line. It is rule-based, not AI.
- Sign up and sign in. Every account starts with its own private workspace and
  a welcome page.
- Create more workspaces. Nobody can see one until you invite them.
- Invite people with a link that says what they can be: an **editor** or a
  **viewer**. Owners can promote people to owner later.
- Edit pages together with rich text, live cursors, and collaborator indicators.
- Roles are enforced by the server, not just by the buttons on screen. A viewer
  can read and watch, but the server refuses their edits.
- Change someone's role, or remove them, and their open page reacts within
  seconds. The limit I set myself is 5 seconds.
- Keep a local browser copy of account pages. Full offline-merge and
  server-restart recovery are planned for Milestone 3 and are not yet verified.
- Save everything in a database that survives restarts: embedded Postgres by
  default, or your own Postgres if you set `DATABASE_URL`.
- Switch between light and dark themes; use the app on smaller screens.

## Run it locally

You need [Node.js](https://nodejs.org/) 22.13 or newer and a modern browser.
The database is embedded, so there is nothing else to install.

```sh
npm ci
npm run dev
```

Open <http://localhost:5173> when Vite is ready. Choose **Try the live demo, no
account** to be typing in a second, or **Create an account** to get your own
workspace and welcome page. The API and live sync server run on port `1234`;
Vite passes `/api` and `/collab` on to it, so the browser only ever talks to one
address. Press `Ctrl+C` in the terminal to stop.

There is no email step. Any address works locally, and passwords are only ever
stored as Argon2id hashes.

### Try the demo with the bot

1. On the sign-in page, press **Try the live demo, no account**.
2. Press **Invite someone**, copy the link and open it in a private window. That
   window is a second person. Type in both and watch each other's cursors.
3. On a new line write `@bot help` and press Enter. A moment later the bot types
   its answer under your line. `@bot count`, `@bot todo` and `@bot hello` work
   too.
4. Refresh: you are still the same person, and your words are still there.
5. The person who started the demo presses **End demo for everyone**; everybody
   else can **Leave demo**. Either way the pages are deleted.

How the demo works, its limits and what it does not do:
[docs/milestone-1.md](docs/milestone-1.md).

### Try it with two people

1. Create an account in your normal browser window.
2. Click **Members**, open **Invite links**, pick **Editor** and **Create link**.
   The link is shown once, so copy it now.
3. Open the link in a private window and create a second account. Click
   **Join workspace**.
4. Type in both windows. You will see each other's cursors.
5. Make a **Viewer** link and join with a third account: the page is read-only,
   and the server refuses edits even if the page is tampered with.
6. As the owner, remove someone under **Members** and watch their window lose
   access.

### Run the single-port version

This is how a real deployment runs: the server serves the built web app and the
API from one address.

```sh
npm run build
npm start
```

Open <http://localhost:1234>.

### Use it from another device on your network

```powershell
$env:CONFLUX_ALLOWED_ORIGINS="http://localhost:5173,http://192.168.1.23:5173"
npm run dev:lan
```

Replace `192.168.1.23` with the host computer's local IP address and open
`http://192.168.1.23:5173` on the other device. Only do this on a network you
trust. Passwords and sessions travel unencrypted over plain `http`.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the web app and the server locally. |
| `npm run dev:lan` | Make the web app available to devices on your local network. |
| `npm run build` | Build the web app. |
| `npm start` | Start the server; it serves the built web app if `npm run build` was run. |
| `npm run typecheck` | Type-check the shared package, server and web app. |
| `npm test` | Run the shared and server tests (embedded database, a few minutes). |
| `npm run test:e2e:setup` | One time: install the browser test tools and Chromium. |
| `npm run test:e2e` | Run the browser tests against a fresh server on port 4321. |
| `npm run reset` | Delete the server's saved data. Stop Conflux first. |

To run the server tests against a real Postgres, set `TEST_DATABASE_URL`, for
example `postgres://postgres:postgres@localhost:5432/postgres`. Each test creates a
scratch database there and drops it afterwards. The tests for requests that arrive
at the same moment (`server/test/concurrency.test.ts`) only run this way, because
the embedded database handles one query at a time.

## How it works

The web app uses React and Tiptap for editing. Yjs merges concurrent edits and
Hocuspocus relays them over WebSockets. One Fastify server handles the API
(accounts, workspaces, members, invites, pages, demos) and the live sync, and
stores everything through Drizzle in Postgres.

A browser never gets live access by being logged in alone. It asks the API for a
sync token that lasts one minute and is good for one page, and the server checks
the database again when the socket opens and every couple of seconds after.

The guest demo uses the same machinery with its own tables, its own cookie and
its own kind of token, so a demo visitor can never reach an account's pages and
an account cannot reach a demo's. The bot is a participant that lives inside the
server and edits the same Yjs document as the visitors.
[docs/architecture.md](docs/architecture.md) walks through it, and
[docs/decisions.md](docs/decisions.md) explains the choices.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `1234` | Server port. |
| `DATABASE_URL` | not set | Use this Postgres instead of the embedded database. |
| `CONFLUX_DATA_DIR` | `server/data/pglite` | Where the embedded database keeps its files. |
| `CONFLUX_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` and the server's own address | Comma-separated list of web origins allowed to use the API and open sync connections. |
| `NODE_ENV` | not set | `production` turns on the `__Host-` secure cookie and HSTS. It needs HTTPS. |
| `CONFLUX_SECRET` | random on every start | Signs sync tokens, at least 32 characters. Set it if you run more than one server. |
| `CONFLUX_COOKIE_SECURE` | `true` in production | Force the secure flag on or off. |
| `CONFLUX_TRUST_PROXY` | `false` | Number of reverse proxies in front of the server (so rate limits see the real address). |
| `CONFLUX_HOST` | `127.0.0.1` (`0.0.0.0` with `--lan`) | Address to listen on. |
| `CONFLUX_WEB_DIST` | `web/dist` if it exists | Folder with the built web app. |
| `CONFLUX_LOG_LEVEL` | `info` | Server log level. |
| `CONFLUX_DEMO` | `true` | Set to `false` to turn the guest demo off: the button disappears and every demo route answers 404. |
| `CONFLUX_DEMO_IDLE_MINUTES` | `30` | A demo ends after this many minutes with nobody typing in it. |
| `CONFLUX_DEMO_MAX_HOURS` | `3` | A demo ends this long after it started, whatever happens. |
| `CONFLUX_DEMO_MAX_ACTIVE` | `100` | The most demos alive at once on this server. |
| `CONFLUX_RATE_LIMIT_SCALE` | `1` | Multiplies every rate limit. Only the browser tests raise it. |
| `VITE_COLLAB_URL` | `ws(s)://<page host>/collab` | WebSocket URL used by the web app, if the sync server lives somewhere else. |

Origin checks and rate limits are part of the protection, not all of it. See
[SECURITY.md](SECURITY.md) for what is covered and what is not, and how to
report a problem.

## Evidence

| Claim | Where it is checked |
| --- | --- |
| Someone outside a workspace cannot read or change anything in it, and cannot tell it exists | `server/test/permissions.test.ts`, `server/test/pages.test.ts`, browser test "someone who is not in a workspace cannot even tell that it exists" |
| A viewer's edits are refused by the server, including from a modified client | `server/test/sync-permissions.test.ts`, browser tests in `tests/e2e/tests/roles.spec.ts` |
| A removed member loses live access within 5 seconds | `server/test/sync-revocation.test.ts`, browser test "removing a member takes their live access away within 5 seconds" |
| Roles change on an open page without a reload | `server/test/sync-revocation.test.ts`, browser test "changing someone's role takes effect on their open page" |
| Sessions, invite links and sync tokens behave as described | `server/test/auth.test.ts`, `server/test/invites.test.ts`, `server/test/sync-auth.test.ts`, `tests/e2e/tests/session.spec.ts` |
| Inputs are validated and requests are rate limited | `server/test/http-security.test.ts`, `server/test/units.test.ts` |
| A demo needs no account, holds six people at most, and keeps its secret link out of every request address | `server/test/demo-api.test.ts`, browser tests in `tests/e2e/tests/demo.spec.ts` ("starting a demo", "two people in one demo") |
| A demo and an account cannot reach each other's pages, in either direction | `server/test/demo-isolation.test.ts` |
| Guests edit together live, cannot fake presence, and are cut off when they flood, send something oversized or grow a page past its limit | `server/test/demo-sync.test.ts` |
| A demo ends on the clock or on purpose, everybody is told, and its pages are deleted | `server/test/demo-lifecycle.test.ts`, browser tests in `tests/e2e/tests/demo.spec.ts` ("ending a demo") |
| The bot answers its commands on the line under the question, never repeats what a visitor wrote, and cannot be impersonated | `server/test/demo-bot.test.ts`, `server/test/demo-sync.test.ts`, browser tests in `tests/e2e/tests/demo.spec.ts` ("the bot") |
| Pages written by the server itself are valid for the real editor | `server/test/demo-content.test.ts`, [docs/editor-schema.md](docs/editor-schema.md) |



## Current limitations

- There is no password reset and no email verification, because both need a
  way to send email. Forget a password and the account stays locked. This
  belongs in a later milestone.
- The demo's bot matches four words and has no AI behind it. A demo's pages
  cannot be moved into an account.
- Removing someone stops live access, but it cannot take back what already
  reached their device. This is how local-first apps work.
- Deleting a page hides it at once and removes its data after 30 days.
- Data saved by the first version (SQLite) is not carried over. Start with a
  fresh account.
- CI runs on Linux. The full local typecheck, shared/server tests, build and
  Chromium suite also passed on Windows with Node.js 24.6.0. macOS and Docker
  have not been tested.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for development and contribution guidelines.

## License

Conflux is available under the [MIT License](LICENSE).

## Author

Designed, developed, and maintained with ♥ by Saurabh Chauhan
