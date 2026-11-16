const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
export function newId(length = 16): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('')
}
