/**
 * Every live document has one of two names:
 *
 *   page.<uuid>        the text of one page
 *   workspace.<uuid>   a tiny channel per workspace. It stores nothing; the
 *                      server uses it to tell open browsers "the page list
 *                      changed", so the sidebar updates for everyone.
 *
 * The server refuses to open anything else. Only lower-case canonical UUIDs are
 * accepted, so one page can never be opened under two different names.
 */
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const UUID_RE = new RegExp(`^${UUID_PATTERN}$`)
const DOC_NAME_RE = new RegExp(`^(page|workspace)\\.(${UUID_PATTERN})$`)
export type DocRef = { kind: 'page' | 'workspace'; id: string }
export const pageDocName = (pageId: string) => `page.${pageId}`
export const workspaceDocName = (workspaceId: string) => `workspace.${workspaceId}`
export function parseDocName(name: string): DocRef | null {
  const match = DOC_NAME_RE.exec(name)
  return match ? { kind: match[1] as DocRef['kind'], id: match[2] } : null
}

export const PAGE_TEXT_FIELD = 'content'
