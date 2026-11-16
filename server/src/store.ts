import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Saves each document as ONE row in a SQLite file.
 *
 *   name        "workspace" or "page:abc123..."
 *   state       the whole Yjs document, encoded as bytes (a BLOB)
 *   updated_at  when we last saved it (milliseconds since 1970)
 *
 * SQLite is just a file on your disk (server/data/conflux.db), so there is
 * nothing to install and no database server to run. `node:sqlite` is built
 * into Node 22.13+, so there is no extra package either.
 *
 * Later you can replace this one file with Postgres and nothing else in the
 * app has to change. That is why it is kept small and separate.
 */
export class DocumentStore {
  private db: DatabaseSync
  private selectOne
  private upsert
  private countAll
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS documents (
        name       TEXT PRIMARY KEY,
        state      BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    this.selectOne = this.db.prepare('SELECT state FROM documents WHERE name = ?')
    this.countAll = this.db.prepare('SELECT COUNT(*) AS n FROM documents')
    this.upsert = this.db.prepare(`
      INSERT INTO documents (name, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
    `)
  }

  /** The saved bytes of a document, or null if we have never seen it. */
  load(name: string): Uint8Array | null {
    const row = this.selectOne.get(name) as { state: Uint8Array } | undefined
    return row ? row.state : null
  }

  /** Save (or overwrite) the bytes of a document. */
  save(name: string, state: Uint8Array): void {
    this.upsert.run(name, state, Date.now())
  }

  /** How many documents are stored. */
  count(): number {
    const row = this.countAll.get() as { n: number | bigint }
    return Number(row.n)
  }

  close(): void {
    this.db.close()
  }
}
