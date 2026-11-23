const PREFIX = 'conflux:'
export const localStoreName = (userId: string, workspaceId: string, docName: string) => `${PREFIX}${userId}:${workspaceId}:${docName}`
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = request.onerror = request.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function deleteWhere(shouldDelete: (name: string) => boolean): Promise<void> {
  try {
    const databases = (await indexedDB.databases?.()) ?? []
    await Promise.all(databases.flatMap((db) => (db.name?.startsWith(PREFIX) && shouldDelete(db.name) ? [deleteDatabase(db.name)] : [])))
  } catch {
    // No IndexedDB (or no way to list it): nothing we can do, and nothing was stored.
  }
}

export function wipeLocalCopies(): Promise<void> {
  return deleteWhere(() => true)
}

export function forgetWorkspaceCopies(userId: string, workspaceId: string): Promise<void> {
  const own = `${PREFIX}${userId}:${workspaceId}:`
  return deleteWhere((name) => name.startsWith(own))
}

export function forgetOrphanedCopies(userId: string, workspaceIds: readonly string[]): Promise<void> {
  const own = `${PREFIX}${userId}:`
  const keep = new Set(workspaceIds)
  return deleteWhere((name) => name.startsWith(own) && !keep.has(name.slice(own.length).split(':', 1)[0]))
}
