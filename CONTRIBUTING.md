# Contributing

Thanks for helping improve Conflux. Issues and pull requests are welcome.

## Set up locally

1. Install Node.js 22.13 or newer.
2. Clone the repository and run `npm ci` from its root.
3. Start the app with `npm run dev`.

## Before opening a pull request

Run the checks from the repository root:

```sh
npm run typecheck
npm test
npm run build
```

Keep changes focused, follow the existing TypeScript and CSS patterns, and update the README when setup or user-facing behavior changes. Include a short explanation of the change and how you tested it in the pull request.

For bugs, include steps to reproduce and the expected behavior. For feature ideas, describe the problem the feature would solve before proposing an implementation.

Please report security issues privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
