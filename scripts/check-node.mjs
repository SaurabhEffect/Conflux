// Runs automatically before `npm install` and `npm run dev`. Stops early, with a
// friendly message, if your Node.js is too old (the server uses features that
// only exist in Node 22.13 and newer).
const [major, minor] = process.versions.node.split('.').map(Number)
const ok = major > 22 || (major === 22 && minor >= 13)
if (!ok) {
  console.error(`
  Conflux needs Node.js 22.13 or newer. You have ${process.versions.node}.

    1. Go to https://nodejs.org and download the "LTS" version
    2. Install it (the default options are fine)
    3. Close this terminal, open a new one, and run:  node -v
    4. Then run the command again
`)
  process.exit(1)
}
