export type Identity = { name: string; color: string }

const STORAGE_KEY = 'conflux.name'
const MAX_NAME_LENGTH = 24
const COLORS = [
  '#3d6bf2', // blue
  '#d9482b', // vermilion
  '#0f8f84', // teal
  '#7c4ddb', // violet
  '#b45309', // amber
  '#c026a3', // magenta
  '#0b7fb5', // sky
  '#2e8b3e', // green
  '#d6336c', // pink
  '#5b6b8c', // slate
]
const ADJECTIVES = ['Quiet', 'Swift', 'Brave', 'Calm', 'Bright', 'Gentle', 'Lucky', 'Witty', 'Cosmic', 'Sunny']
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Lynx', 'Heron', 'Koala', 'Fox', 'Gecko', 'Orca', 'Finch']
function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

export function randomName(): string {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`
}

export function colorFor(name: string): string {
  let hash = 0
  for (const char of name.trim().toLowerCase()) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  }
  return COLORS[hash % COLORS.length]
}

function cleanName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH) || randomName()
}

function nameFromAddress(): string | null {
  const value = new URLSearchParams(window.location.search).get('as')
  return value && value.trim() ? cleanName(value) : null
}

function readStoredName(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  }
  catch {
    return null // private mode or blocked storage: we just ask again next time
  }
}

function storeName(name: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, name)
  }
  catch {
    // ignore, see above
  }
}

export function loadIdentity(): Identity | null {
  const name = nameFromAddress() ?? readStoredName()
  if (!name) return null
  const clean = cleanName(name)
  return { name: clean, color: colorFor(clean) }
}

export function chooseFirstName(raw: string): Identity {
  const name = cleanName(raw)
  storeName(name)
  return { name, color: colorFor(name) }
}

export function changeName(raw: string): void {
  const name = cleanName(raw)
  if (nameFromAddress()) {
    const url = new URL(window.location.href)
    url.searchParams.set('as', name)
    window.location.replace(url.toString())
    return
  }
  storeName(name)
  window.location.reload()
}

export function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase()
}
