import { PAGE_TEXT_FIELD } from '@conflux/shared'

type Id = { client: number; clock: number }
export type CursorPosition = { type: Id | null; tname: string | null; item: Id | null; assoc: number }
export type Cursor = { anchor: CursorPosition; head: CursorPosition }
export type CleanPresence = { user: { name: string; color: string }; cursor?: Cursor | null }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function cleanId(value: unknown): Id | null | undefined {
  if (value === null || value === undefined) return null
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'client' && key !== 'clock')) return undefined
  const { client, clock } = value
  if (typeof client !== 'number' || !Number.isSafeInteger(client) || client < 0) return undefined
  if (typeof clock !== 'number' || !Number.isSafeInteger(clock) || clock < 0) return undefined
  return { client, clock }
}

function cleanPosition(value: unknown): CursorPosition | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !['type', 'tname', 'item', 'assoc'].includes(key))) return null
  const type = cleanId(value.type)
  const item = cleanId(value.item)
  if (type === undefined || item === undefined) return null
  const tname = value.tname ?? null
  if (tname !== null && tname !== PAGE_TEXT_FIELD) return null
  const assoc = value.assoc ?? 0
  if (typeof assoc !== 'number' || !Number.isSafeInteger(assoc) || Math.abs(assoc) > 1) return null
  if (type === null && tname === null && item === null) return null
  return { type, tname, item, assoc }
}

export function cleanCursor(value: unknown): Cursor | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'anchor' && key !== 'head')) return undefined
  const anchor = cleanPosition(value.anchor)
  const head = cleanPosition(value.head)
  return anchor && head ? { anchor, head } : undefined
}

export function cleanPresence(state: unknown, user: { name: string; color: string }): CleanPresence {
  const input = isRecord(state) ? state : {}
  const clean: CleanPresence = { user: { name: user.name, color: user.color } }
  const cursor = cleanCursor(input.cursor)
  if (cursor !== undefined) clean.cursor = cursor
  return clean
}
