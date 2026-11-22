/** Cursor and avatar colours. Each account gets one when it is created. */
export const CURSOR_COLORS = [
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
] as const

export function cursorColorFor(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return CURSOR_COLORS[hash % CURSOR_COLORS.length]
}
