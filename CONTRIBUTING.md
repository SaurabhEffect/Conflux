# Contributing

Thanks for helping improve Conflux. Issues and pull requests are welcome.

## Set up locally

1. Install Node.js 22.13 or newer.
2. Clone the repository and run `npm ci` from its root.
3. Start the app with `npm run dev`, then open <http://localhost:5173>.

The database is embedded, so nothing else needs installing.

## Before opening a pull request

Run the checks from the repository root:

```sh
npm run typecheck
npm test
npm run build
```

If you touched the web app, sign-in, roles, live sync, the demo or the bot, also
run the browser tests. They use a real Chromium, so they need a one-time setup (about 200 MB):

```sh
npm run test:e2e:setup
npm run test:e2e
```

The browser tests build the web app, start the server on port 4321 with an empty
database, and drive it like a person would. They live in `tests/e2e`, which is a
separate project so the normal install stays small.

To run the server tests against Postgres as well, point `TEST_DATABASE_URL` at
any Postgres you can create databases in. Each test makes and drops its own.

## Ground rules

- Permissions are decided on the server. A hidden button is never the only
  protection: add a server test that proves the request is refused.
- The rules about who may do what live in one place, `can()` in
  `packages/shared`, and the lookup of someone's role lives in
  `server/src/access.ts`. Use them instead of writing a new check.
- Anything the server writes into a page itself (the demo's starter pages, the
  bot's lines) must be valid for the real editor, which deletes what it does not
  know. `docs/editor-schema.md` lists the rules and the server tests check them.
- Keep changes focused, follow the existing TypeScript and CSS patterns, and
  update the README when setup or user-facing behavior changes. Include a short
  explanation of the change and how you tested it in the pull request.

For bugs, include steps to reproduce and the expected behavior. For feature
ideas, describe the problem the feature would solve before proposing an
implementation.

Please report security issues privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
