import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from './schema'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type Database = {
  db: Db
  kind: 'pglite' | 'postgres'
  description: string
  close: () => Promise<void>
}

export type DatabaseOptions = {
  url?: string | null
  dataDir: string
  onError?: (error: Error) => void
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
export async function openDatabase(options: DatabaseOptions): Promise<Database> {
  return options.url ? openPostgres(options.url, options.onError) : openEmbedded(options.dataDir)
}

async function openEmbedded(dataDir: string): Promise<Database> {
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ])
  const inMemory = dataDir.startsWith('memory:')
  if (!inMemory) mkdirSync(dataDir, { recursive: true })
  const client = new PGlite(inMemory ? undefined : dataDir)
  await client.waitReady
  const db = drizzle(client, { schema }) as unknown as Db
  await migrate(db as never, { migrationsFolder })
  return {
    db,
    kind: 'pglite',
    description: inMemory ? 'embedded Postgres (PGlite), in memory' : `embedded Postgres (PGlite) in ${dataDir}`,
    close: () => client.close(),
  }
}

async function openPostgres(url: string, onError?: (error: Error) => void): Promise<Database> {
  const [{ default: pg }, { drizzle }, { migrate }] = await Promise.all([
    import('pg'),
    import('drizzle-orm/node-postgres'),
    import('drizzle-orm/node-postgres/migrator'),
  ])
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  })
  pool.on('error', (error) => onError?.(error))
  const db = drizzle(pool, { schema }) as unknown as Db
  await migrate(db as never, { migrationsFolder })
  const target = new URL(url)
  return {
    db,
    kind: 'postgres',
    description: `Postgres at ${target.hostname}:${target.port || '5432'}${target.pathname}`,
    close: () => pool.end(),
  }
}

export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`)
}

export function pgErrorCode(error: unknown): string | undefined {
  const inner = (error as { cause?: { code?: unknown } } | null)?.cause
  const code = inner?.code ?? (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === '23505'
