export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const UUID_RE = new RegExp(`^${UUID_PATTERN}$`)
const DOC_NAME_RE = new RegExp(`^(page|workspace)\\.(${UUID_PATTERN})$`)
export type DocRef = { kind: 'page' | 'workspace'; id: string }
const DEMO_DOC_RE = new RegExp(`^demo\\.(${UUID_PATTERN})$`)
export const pageDocName = (pageId: string) => `page.${pageId}`
export const demoDocName = (pageId: string) => `demo.${pageId}`
export const workspaceDocName = (workspaceId: string) => `workspace.${workspaceId}`
export function parseDocName(name: string): DocRef | null {
  const match = DOC_NAME_RE.exec(name)
  return match ? { kind: match[1] as DocRef['kind'], id: match[2] } : null
}

export function parseDemoDocName(name: string): string | null {
  const match = DEMO_DOC_RE.exec(name)
  return match ? match[1] : null
}

export const PAGE_TEXT_FIELD = 'content'
