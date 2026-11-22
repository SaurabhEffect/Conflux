import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SignJWT } from 'jose'
import { ConfigError, loadConfig } from '../src/config'
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../src/auth/password'
import { signSyncToken, verifySyncToken } from '../src/auth/syncToken'
import { cleanCursor, cleanPresence } from '../src/sync/presence'
import { addressKey } from '../src/util/address'
import { Budget, RateLimiter } from '../src/util/limiter'

describe('configuration', () => {
  const load = (env: Record<string, string> = {}, argv: string[] = []) => loadConfig(env, argv)

  it('has safe defaults: this computer only, random secret, own origins allowed', () => {
    const config = load()
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 1234)
    assert.equal(config.production, false)
    assert.equal(config.cookieSecure, false)
    assert.equal(config.secretIsRandom, true)
    assert.equal(config.trustProxy, false)
    assert.deepEqual(
      [...config.allowedOrigins].sort(),
      ['http://127.0.0.1:1234', 'http://127.0.0.1:5173', 'http://localhost:1234', 'http://localhost:5173'].sort(),
    )
  })

  it('--lan listens on every network interface', () => {
    assert.equal(load({}, ['--lan']).host, '0.0.0.0')
    assert.equal(load({ CONFLUX_HOST: '10.0.0.5' }, ['--lan']).host, '10.0.0.5')
  })

  it('production turns on secure cookies unless told otherwise', () => {
    assert.equal(load({ NODE_ENV: 'production' }).cookieSecure, true)
    assert.equal(load({ NODE_ENV: 'production', CONFLUX_COOKIE_SECURE: 'false' }).cookieSecure, false)
  })

  it('follows PORT, and the own-origin defaults follow it', () => {
    const config = load({ PORT: '8080' })
    assert.equal(config.port, 8080)
    assert.ok(config.allowedOrigins.has('http://localhost:8080'))
  })

  it('replaces the origin list when CONFLUX_ALLOWED_ORIGINS is set', () => {
    const config = load({ CONFLUX_ALLOWED_ORIGINS: 'https://conflux.example.com, https://b.example.com' })
    assert.deepEqual([...config.allowedOrigins].sort(), ['https://b.example.com', 'https://conflux.example.com'])
  })

  it('refuses a short or missing-length secret', () => {
    assert.throws(() => load({ CONFLUX_SECRET: 'too short' }), ConfigError)
    assert.equal(load({ CONFLUX_SECRET: 'x'.repeat(32) }).secretIsRandom, false)
  })

  it('explains bad values instead of failing later', () => {
    assert.throws(() => load({ PORT: 'abc' }), /PORT must be a whole number/)
    assert.throws(() => load({ PORT: '70000' }), /PORT must be a whole number/)
    assert.throws(() => load({ CONFLUX_COOKIE_SECURE: 'maybe' }), /true or false/)
    assert.throws(() => load({ CONFLUX_TRUST_PROXY: 'lots' }), /CONFLUX_TRUST_PROXY/)
    assert.throws(() => load({ CONFLUX_RATE_LIMIT_SCALE: '0' }), /CONFLUX_RATE_LIMIT_SCALE/)
  })

  it('reads how many proxies to trust', () => {
    assert.equal(load({ CONFLUX_TRUST_PROXY: 'true' }).trustProxy, true)
    assert.equal(load({ CONFLUX_TRUST_PROXY: '2' }).trustProxy, 2)
    assert.equal(load({ CONFLUX_TRUST_PROXY: 'false' }).trustProxy, false)
  })

  it('multiplies the rate limits for tests and load tests only', () => {
    const normal = load()
    const scaled = load({ CONFLUX_RATE_LIMIT_SCALE: '10' })
    assert.equal(scaled.limits.login.max, normal.limits.login.max * 10)
    assert.equal(scaled.limits.login.windowMs, normal.limits.login.windowMs)
  })
})

describe('rate limiter', () => {
  it('lets max requests through per window and says how long to wait after that', () => {
    let now = 1_000_000
    const limiter = new RateLimiter({ max: 3, windowMs: 60_000 }, () => now)
    for (let i = 0; i < 3; i++) assert.equal(limiter.take('a').ok, true)
    const blocked = limiter.take('a')
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.equal(blocked.retryAfterSeconds, 60)
    now += 30_000
    const still = limiter.take('a')
    assert.equal(still.ok, false)
    if (!still.ok) assert.equal(still.retryAfterSeconds, 30)
  })

  it('starts a new window afterwards and counts keys separately', () => {
    let now = 0
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 }, () => now)
    assert.equal(limiter.take('a').ok, true)
    assert.equal(limiter.take('b').ok, true)
    assert.equal(limiter.take('a').ok, false)
    now += 1001
    assert.equal(limiter.take('a').ok, true)
  })

  it('counts a burst of simultaneous calls, because it counts before the work starts', () => {
    const limiter = new RateLimiter({ max: 5, windowMs: 60_000 })
    const results = Array.from({ length: 20 }, () => limiter.take('x').ok)
    assert.equal(results.filter(Boolean).length, 5)
  })

  it('stays bounded, and stays quick, when someone sprays many different keys', () => {
    let now = 0
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 }, () => now)
    const started = Date.now()
    for (let i = 0; i < 120_000; i++) {
      now += 0 // all in the same instant: nothing has expired yet
      limiter.take(`key-${i}`)
    }
    const size = (limiter as unknown as { entries: Map<string, unknown> }).entries.size
    assert.ok(size <= 50_000, `entries kept: ${size}`)
    // Each call used to scan every key once there were thousands (about a minute for this loop).
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
  })

  it('forgets keys whose window is over', () => {
    let now = 0
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 }, () => now)
    for (let i = 0; i < 100; i++) limiter.take(`key-${i}`)
    now += 61_000
    limiter.take('another')
    const size = (limiter as unknown as { entries: Map<string, unknown> }).entries.size
    assert.equal(size, 1)
  })

  it('still blocks a key that is over the limit after other keys were dropped', () => {
    const now = 0
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 }, () => now)
    assert.equal(limiter.take('steady').ok, true)
    assert.equal(limiter.take('steady').ok, false)
    for (let i = 0; i < 1000; i++) limiter.take(`other-${i}`)
    assert.equal(limiter.take('steady').ok, false)
  })
})

describe('address keys for the limits', () => {
  it('counts IPv4 addresses as they are, and unwraps IPv4 written the IPv6 way', () => {
    assert.equal(addressKey('203.0.113.7'), '203.0.113.7')
    assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7')
    assert.equal(addressKey('::FFFF:203.0.113.7'), '203.0.113.7')
  })

  it('counts IPv6 addresses by their /64 block, which one person can switch around in for free', () => {
    const key = addressKey('2001:db8:1:2::1')
    assert.equal(key, '2001:db8:1:2::/64')
    assert.equal(addressKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), key)
    assert.equal(addressKey('2001:0DB8:0001:0002:0000:0000:0000:0001'), key)
    assert.notEqual(addressKey('2001:db8:1:3::1'), key)
    assert.notEqual(addressKey('2001:db9:1:2::1'), key)
  })

  it('copes with the other ways an address can be written', () => {
    assert.equal(addressKey('::1'), '0:0:0:0::/64')
    assert.equal(addressKey('::'), '0:0:0:0::/64')
    assert.equal(addressKey('fe80::1%eth0'), 'fe80:0:0:0::/64')
    assert.equal(addressKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64')
    assert.equal(addressKey('2001:db8::'), '2001:db8:0:0::/64')
  })

  it('leaves anything that is not an address alone', () => {
    for (const value of ['', 'unknown', 'localhost', '1.2.3', '2001:db8::1::2']) assert.equal(addressKey(value), value)
  })
})

describe('hash budget', () => {
  it('allows a burst of two seconds worth, then one per 1/rate seconds', () => {
    let now = 0
    const budget = new Budget(10, () => now)
    let granted = 0
    while (budget.tryTake()) granted += 1
    assert.equal(granted, 20)
    now += 100
    assert.equal(budget.tryTake(), true)
    assert.equal(budget.tryTake(), false)
  })
})

describe('passwords', () => {
  it('hashes to a self-describing Argon2id string and verifies it', async () => {
    const hash = await hashPassword('correct horse battery staple')
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/)
    assert.equal(await verifyPassword(hash, 'correct horse battery staple'), true)
    assert.equal(await verifyPassword(hash, 'correct horse battery stapl'), false)
    assert.equal(await verifyPassword(hash, ''), false)
  })

  it('salts every hash differently', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'))
  })

  it('treats a damaged stored hash as a failed login, not a crash', async () => {
    for (const bad of ['', 'plaintext', '$argon2id$', '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012']) {
      assert.equal(await verifyPassword(bad, 'anything'), false, bad)
    }
  })

  it('does a full-cost check for accounts that do not exist', async () => {
    const started = Date.now()
    await verifyAgainstDummy('whatever')
    await verifyAgainstDummy('whatever')
    assert.ok(Date.now() - started >= 20, 'it really hashes')
  })

  it('handles unicode and very long passwords without changing them', async () => {
    const password = 'пароль-密码-🔐'.repeat(8)
    const hash = await hashPassword(password)
    assert.equal(await verifyPassword(hash, password), true)
    assert.equal(await verifyPassword(hash, password.normalize('NFD') + 'x'), false)
  })
})

describe('sync tokens', () => {
  const secret = new TextEncoder().encode('s'.repeat(40))
  const claims = { userId: 'u-1', sessionId: 's-1', doc: 'page.4f8f8d3e-2d0a-4d5c-9a43-0b8e3e1f6a10' }

  it('round-trips and expires in about a minute', async () => {
    const { token, expiresAt } = await signSyncToken(secret, claims, 60)
    assert.deepEqual(await verifySyncToken(secret, token), claims)
    const left = expiresAt.getTime() - Date.now()
    assert.ok(left > 55_000 && left <= 60_000)
  })

  it('carries no role: permissions are always looked up fresh', async () => {
    const { token } = await signSyncToken(secret, claims, 60)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    assert.deepEqual(Object.keys(payload).sort(), ['aud', 'doc', 'exp', 'iat', 'iss', 'sid', 'sub'])
  })

  it('rejects a token signed with another secret', async () => {
    const { token } = await signSyncToken(new TextEncoder().encode('o'.repeat(40)), claims, 60)
    await assert.rejects(verifySyncToken(secret, token))
  })

  it('rejects an expired token', async () => {
    const { token } = await signSyncToken(secret, claims, -5)
    await assert.rejects(verifySyncToken(secret, token))
  })

  it('rejects an edited payload', async () => {
    const { token } = await signSyncToken(secret, claims, 60)
    const [head, , sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', sid: 's-1', doc: claims.doc, iss: 'conflux', aud: 'conflux-sync', exp: 9_999_999_999 })).toString('base64url')
    await assert.rejects(verifySyncToken(secret, `${head}.${forged}.${sig}`))
  })

  // A token built by hand with every claim the real one has. The tests below take one thing away at a time.
  const handmade = (options: { iss?: string; aud?: string; alg?: string; sub?: string | null; sid?: string | null; exp?: string | null; iat?: boolean } = {}) => {
    const { iss = 'conflux', aud = 'conflux-sync', alg = 'HS256', sub = 'u-1', sid = 's-1', exp = '1m', iat = true } = options
    const jwt = new SignJWT({ ...(sid === null ? {} : { sid }), doc: claims.doc }).setProtectedHeader({ alg }).setIssuer(iss).setAudience(aud)
    if (sub !== null) jwt.setSubject(sub)
    if (exp !== null) jwt.setExpirationTime(exp)
    if (iat) jwt.setIssuedAt()
    return jwt.sign(secret)
  }

  it('accepts a hand-made token that has everything (so the refusals below are for the reason they name)', async () => {
    assert.equal((await verifySyncToken(secret, await handmade())).userId, 'u-1')
  })

  it('rejects unsigned ("alg: none") tokens and other algorithms', async () => {
    const none = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url')
    const unsigned = `${none({ alg: 'none', typ: 'JWT' })}.${none({ sub: 'u-1', sid: 's-1', doc: claims.doc, iss: 'conflux', aud: 'conflux-sync', iat: 1, exp: 9_999_999_999 })}.`
    await assert.rejects(verifySyncToken(secret, unsigned))
    await assert.rejects(verifySyncToken(secret, await handmade({ alg: 'HS512' })))
  })

  it('rejects tokens meant for something else', async () => {
    await assert.rejects(verifySyncToken(secret, await handmade({ iss: 'other' })))
    await assert.rejects(verifySyncToken(secret, await handmade({ aud: 'other' })))
  })

  it('rejects tokens that are missing a claim', async () => {
    await assert.rejects(verifySyncToken(secret, await handmade({ sid: null })), 'no session')
    await assert.rejects(verifySyncToken(secret, await handmade({ sub: null })), 'no person')
  })

  it('rejects a token that never expires, even though the signature is right', async () => {
    await assert.rejects(verifySyncToken(secret, await handmade({ exp: null })))
  })

  it('rejects a token that does not say when it was made', async () => {
    await assert.rejects(verifySyncToken(secret, await handmade({ iat: false })))
  })

  it('rejects garbage', async () => {
    for (const junk of ['', 'a.b.c', 'x'.repeat(5000), 'null', '{}']) await assert.rejects(verifySyncToken(secret, junk), junk.slice(0, 10))
  })
})

describe('presence cleaning', () => {
  const place = { type: null, tname: 'content', item: { client: 4242, clock: 7 }, assoc: 0 }
  const user = { name: 'Real Name', color: '#112233' }

  it('keeps a cursor written the way the editor writes it, and nothing else of what the browser sent', () => {
    const state = { user: { name: 'ADMIN', color: '#ff0000' }, cursor: { anchor: place, head: place }, lastSelection: { content: { anchor: place } }, script: '<img onerror=alert(1)>' }
    assert.deepEqual(cleanPresence(state, user), { user, cursor: { anchor: place, head: place } })
  })

  it('accepts every form of a position the editor produces', () => {
    const real = [
      { type: null, tname: 'content', item: null, assoc: 0 },
      { type: null, tname: 'content', item: { client: 1, clock: 0 }, assoc: -1 },
      { type: { client: 2 ** 32 - 1, clock: 9 }, tname: null, item: null, assoc: 0 },
      { type: { client: 3, clock: 4 }, tname: null, item: { client: 3, clock: 40 }, assoc: 0 },
      { item: { client: 5, clock: 6 } }, // as written by Y.relativePositionToJSON: members that are empty are left out
      { tname: 'content' },
    ]
    for (const position of real) assert.ok(cleanCursor({ anchor: position, head: position }), JSON.stringify(position))
  })

  it('turns a position into one fixed shape, so what other editors read never varies', () => {
    assert.deepEqual(cleanCursor({ anchor: { item: { client: 5, clock: 6 } }, head: { tname: 'content' } }), {
      anchor: { type: null, tname: null, item: { client: 5, clock: 6 }, assoc: 0 },
      head: { type: null, tname: 'content', item: null, assoc: 0 },
    })
  })

  it('clears a cursor on null and ignores everything that is not a cursor', () => {
    assert.equal(cleanCursor(null), null)
    for (const value of [undefined, 5, 'x', [], {}, { anchor: place }, { head: place }, { anchor: null, head: null }, { anchor: place, head: place, extra: 1 }]) {
      assert.equal(cleanCursor(value), undefined, JSON.stringify(value))
    }
    assert.deepEqual(cleanPresence({ cursor: 'junk' }, user), { user })
    assert.deepEqual(cleanPresence(null, user), { user })
    assert.deepEqual(cleanPresence('not even an object', user), { user })
  })

  it('refuses positions that would make another editor throw or invent text', () => {
    const bad: unknown[] = [
      { type: null, tname: null, item: null, assoc: 0 }, // points at nothing
      { tname: 'secrets' }, // would create an empty shared text of that name in everybody's page
      { tname: 5 },
      { item: { client: -1, clock: 0 } },
      { item: { client: 1.5, clock: 0 } },
      { item: { client: 1, clock: Number.MAX_SAFE_INTEGER + 1 } },
      { item: { client: '1', clock: 0 } },
      { item: { client: 1, clock: 0, extra: 1 } },
      { item: [1, 0] },
      { type: 'x' },
      { tname: 'content', assoc: 2 },
      { tname: 'content', assoc: 0.5 },
      { tname: 'content', assoc: '0' },
      { tname: 'content', extra: 1 },
      'x',
      5,
      null,
      [],
    ]
    for (const position of bad) assert.equal(cleanCursor({ anchor: position, head: place }), undefined, JSON.stringify(position))
  })
})
