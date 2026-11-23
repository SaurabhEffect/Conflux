# Conflux

**Collaboration in sync.**

[![CI](https://github.com/SaurabhEffect/Conflux/actions/workflows/ci.yml/badge.svg)](https://github.com/SaurabhEffect/Conflux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

I built Conflux as a real-time collaborative workspace where people can work on
the same page and see each other's edits and cursors as they happen. It is an
early-stage portfolio project. This version adds accounts and permissions:
private workspaces, owner / editor / viewer roles, and invite links. It is
meant to run on your own computer.

## What it can do

- Sign up and sign in. Every account starts with its own private workspace and
  a welcome page.
- Create more workspaces. Nobody can see one until you invite them.
- Invite people with a link that says what they can be: an **editor** or a
  **viewer**. Owners can promote people to owner later.
- Edit pages together with rich text, live cursors, and collaborator indicators.
- Roles are enforced by the server, not just by the buttons on screen. A viewer
  can read and watch, but the server refuses their edits.

- Keep editing while offline. The browser saves a copy and merges it after
  reconnecting.
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

Open <http://localhost:5173> when Vite is ready, choose **Create an account**,
and you land on your welcome page. The API and live sync server run on port
`1234`; Vite passes `/api` and `/collab` on to it, so the browser only ever
talks to one address. Press `Ctrl+C` in the terminal to stop.

There is no email step. Any address works locally, and passwords are only ever
stored as Argon2id hashes.

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
| `npm test` | Run the shared and server tests (embedded database, a minute or two). |
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
(accounts, workspaces, members, invites, pages) and the live sync, and stores
everything through Drizzle in Postgres.

A browser never gets live access by being logged in alone. It asks the API for a
sync token that lasts one minute and is good for one page, and the server checks
the database again when the socket opens and every couple of seconds after.



## Evidence

| Claim | Where it is checked |
| --- | --- |
| Someone outside a workspace cannot read or change anything in it, and cannot tell it exists | `server/test/permissions.test.ts`, `server/test/pages.test.ts`, browser test "someone who is not in a workspace cannot even tell that it exists" |
| A viewer's edits are refused by the server, including from a modified client | `server/test/sync-permissions.test.ts`, browser tests in `tests/e2e/tests/roles.spec.ts` |
| A removed member loses live access within 5 seconds | `server/test/sync-revocation.test.ts`, browser test "removing a member takes their live access away within 5 seconds" |
| Roles change on an open page without a reload | `server/test/sync-revocation.test.ts`, browser test "changing someone's role takes effect on their open page" |
| Sessions, invite links and sync tokens behave as described | `server/test/auth.test.ts`, `server/test/invites.test.ts`, `server/test/sync-auth.test.ts`, `tests/e2e/tests/session.spec.ts` |
| Inputs are validated and requests are rate limited | `server/test/http-security.test.ts`, `server/test/units.test.ts` |


## Current limitations

- There is no password reset and no email verification, because both need a
  way to send email. Forget a password and the account stays locked. This
  belongs in a later milestone.
- There is no guest demo without sign-up yet, and nothing is deployed. The
  intended setup is still running it yourself.
- Removing someone stops live access, but it cannot take back what already
  reached their device. This is how local-first apps work.
- Deleting a page hides it at once and removes its data after 30 days.
- Data saved by the first version (SQLite) is not carried over. Start with a
  fresh account.
- The automated tests run on Linux. Windows, macOS and Docker setups work in
  principle, because everything is plain Node.js, but they are not part of CI.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for development and contribution guidelines.

## License

Conflux is available under the [MIT License](LICENSE).

## Author

Designed, developed, and maintained with ♥ by Saurabh Chauhan
