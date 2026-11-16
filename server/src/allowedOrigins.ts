const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

export function parseAllowedOrigins(value?: string): ReadonlySet<string> {
  const entries = value === undefined ? DEFAULT_ORIGINS : value.split(',').map((origin) => origin.trim())
  const origins = entries.filter(Boolean).map(normalizeOrigin)
  if (origins.length === 0) throw new Error('CONFLUX_ALLOWED_ORIGINS must contain at least one origin')
  return new Set(origins)
}

export function isAllowedOrigin(origin: string | null, allowedOrigins: ReadonlySet<string>): boolean {
  if (!origin) return false
  try {
    return normalizeOrigin(origin) === origin && allowedOrigins.has(origin)
  } 
  catch {
    return false
  }
}

function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) 
  {
    throw new Error(`Invalid origin: ${value}`)
  }
  return url.origin
}
