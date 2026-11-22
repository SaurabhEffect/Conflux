import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dataFolder = fileURLToPath(new URL('../server/data', import.meta.url))

try {
  rmSync(dataFolder, { recursive: true, force: true })
} catch (error) {
  console.error(`
  Could not delete ${dataFolder}
  (${error.code ?? error.message})
  Is Conflux still running? Press Ctrl+C in the window where you started it,
  then run  npm run reset  again.
`)
  process.exit(1)
}

console.log(`
  Deleted ${dataFolder}
  All accounts, workspaces and pages on the server are gone.

  Your BROWSER may still hold saved copies of pages from the old accounts (that
  is what makes offline editing work). They are filed under the old account, so
  a new account never sees them, but they stay until you clear them. Signing
  out of an account removes that browser's copies, or you can clear this site's
  data:
    Chrome / Edge:  press F12, open the Application tab, choose "Storage",
                    then click "Clear site data".
  Because the old sign-in no longer exists, the app will ask you to sign in
  again. Create a new account to start fresh.
`)
