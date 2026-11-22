import { isIPv6 } from 'node:net'
export function addressKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped) return mapped[1]
  const withoutZone = address.split('%')[0]
  if (!isIPv6(withoutZone)) return address
  const groups = expandIPv6(withoutZone)
  if (!groups) return address
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`
}

function expandIPv6(text: string): number[] | null {
  let rest = text
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(rest)
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number)
    if ([a, b, c, d].some((part) => part > 255)) return null
    rest = `${rest.slice(0, tail.index)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`
  }
  const halves = rest.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const filler = halves.length === 2 ? 8 - left.length - right.length : 0
  if (filler < 0 || left.length + right.length + filler !== 8) return null
  const groups = [...left, ...Array<string>(filler).fill('0'), ...right].map((group) => parseInt(group, 16))
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null
}
