import { defineConfig } from 'drizzle-kit'

// `npm run db:generate` reads the tables in src/db/schema.ts and writes a SQL
// migration into ./drizzle. The server applies those files when it starts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
