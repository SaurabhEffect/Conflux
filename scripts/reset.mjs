// `npm run reset` deletes everything Conflux saved on the server (all pages).
// Use it when you want a completely empty workspace again.
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dataFolder = fileURLToPath(new URL('../server/data', import.meta.url))

try {
  rmSync(dataFolder, { recursive: true, force: true })
} 
catch (error) {
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
  The server's copy of your pages is gone.

  One more step: your BROWSER also keeps a private copy of each page (that is
  what makes offline editing work). If you open the app in the same browser,
  the old pages would be sent back to the server. To really start fresh,
  either use a new private window, or clear this site's data:
    Chrome / Edge:  press F12, open the Application tab, choose "Storage",
                    then click "Clear site data".
`)
