# Conflux

**Collaboration in sync.**

I built Conflux as a real-time collaborative workspace where people can work on
the same page and see each other's edits and cursors as they happen. It is an
early-stage portfolio project, and this version is intended to run locally.

## What it can do

- Create, rename, and delete pages in a shared workspace.
- Edit pages together with rich text, live cursors, and collaborator indicators.
- Keep edits in the browser while offline and merge them after reconnecting.
- Save workspace data in SQLite so it is available after the server restarts.
- Switch between light and dark themes; use the app on smaller screens.

## Run it locally

You need [Node.js](https://nodejs.org/) 22.13 or newer and a modern browser.
SQLite is included through Node.js; there is no separate database to install.

```sh
npm ci
npm run dev
```

Open <http://localhost:5173> when Vite is ready. The sync server runs on port
`1234`. Choose a display name to start using the workspace. Press `Ctrl+C` in
the terminal to stop the app.

To try collaboration on one computer, open the app in another browser window
and use a different display name, for example:

```text
http://localhost:5173/?as=Friend
```

For access from another device on your local network, run:

```powershell
$env:CONFLUX_ALLOWED_ORIGINS="http://localhost:5173,http://192.168.1.23:5173"
npm run dev:lan
```

Replace `192.168.1.23` with the host computer's local IP address. Only do this
on a network you trust. Conflux has no accounts or permissions, so anyone who
can connect can read and edit the workspace.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the web app and sync server locally. |
| `npm run dev:lan` | Make the web app available to devices on your local network. |
| `npm test` | Run the server tests. |
| `npm run typecheck` | Type-check the server and web app. |
| `npm run build` | Build the web app. |
| `npm run reset` | Delete the server's saved data. Stop Conflux first. |

## How it works

The web app uses React and Tiptap for editing. Yjs merges concurrent edits,
and Hocuspocus relays updates over WebSockets. The server stores collaborative
documents in SQLite. The browser also keeps a local copy for offline editing.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `1234` | Sync server port. |
| `VITE_COLLAB_URL` | `ws://<page host>:1234` | WebSocket URL used by the web app. |
| `CONFLUX_DB` | `server/data/conflux.db` | SQLite database file location. |
| `CONFLUX_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated list of allowed web-app origins. |

Origin checks limit which browser origins can open a connection; they are not
authentication or access control. Do not expose this version to the public
internet or use it for sensitive information. See [SECURITY.md](SECURITY.md)
for reporting security issues.

## Current limitations

- There are no user accounts, private workspaces, or permissions.
- Everyone connected to the sync server can access and edit all documents.
- Deleting a page removes it from the workspace list, but its document data
  remains in the database.
- The project is not deployed; the intended setup is local development.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for development and contribution guidelines.

## License

Conflux is available under the [MIT License](LICENSE).

## Author

Designed, developed, and maintained with ♥ by Saurabh Chauhan