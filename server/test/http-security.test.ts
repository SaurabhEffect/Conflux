import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Client, ORIGIN, PASSWORD, startTestServer, type TestServer } from './helpers'

describe('requests from other websites', () => {
  let server: TestServer
  before(async () => {
    server = await startTestServer()
  })
  after(async () => {
    await server.close()
  })

  const EVIL = { Origin: 'http://evil.example' }

  it('refuses writes that say they come from another site, signed in or not', async () => {
    const victim = new Client(server)
    const account = await victim.signup('Victim')
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/workspaces', { name: 'Planted by evil.example' }],
      ['PATCH', '/api/auth/me', { displayName: 'Hacked' }],
      ['POST', '/api/auth/logout', undefined],
      ['POST', `/api/workspaces/${account.workspace.id}/pages`, { title: 'Planted' }],
      ['DELETE', `/api/workspaces/${account.workspace.id}`, undefined],
      ['POST', '/api/auth/login', { email: account.email, password: account.password }],
      ['POST', '/api/auth/signup', { email: 'evil@example.com', password: PASSWORD, displayName: 'Evil' }],
      ['POST', '/api/invites/preview', { token: 'A'.repeat(43) }],
    ]
    for (const [method, url, body] of attempts) {
      const reply = await victim.request(method, url, body, EVIL)
      assert.equal(reply.status, 403, `${method} ${url}`)
      assert.equal(reply.body.error.code, 'bad_origin')
    }
    // Nothing changed behind the scenes.
    const state = await victim.get('/api/auth/me')
    assert.equal(state.body.user.displayName, 'Victim')
    assert.equal(state.body.workspaces.length, 1)
    assert.equal((await victim.get(`/api/workspaces/${account.workspace.id}/pages`)).body.pages.length, 1)
  })

  it('refuses foreign writes however the address is spelled (the router reads %61 as "a")', async () => {
    const victim = new Client(server)
    const account = await victim.signup('Spelling')
    // These all reach the same handlers as /api/auth/logout and friends.
    const spellings = ['/%61pi/auth/logout', '/a%70i/auth/logout', '/ap%69/auth/logout', '/%61%70%69/auth/logout']
    for (const url of spellings) {
      const reply = await victim.request('POST', url, undefined, EVIL)
      assert.equal(reply.status, 403, url)
      assert.equal(reply.body.error.code, 'bad_origin', url)
      const marked = await victim.request('POST', url, undefined, { 'Sec-Fetch-Site': 'cross-site' })
      assert.equal(marked.status, 403, `${url} (cross-site)`)
    }
    const patch = await victim.request('PATCH', '/%61pi/auth/me', { displayName: 'Hacked' }, EVIL)
    assert.equal(patch.status, 403)
    const del = await victim.request('DELETE', `/%61pi/workspaces/${account.workspace.id}`, undefined, EVIL)
    assert.equal(del.status, 403)
    // Still signed in, nothing changed.
    const state = await victim.get('/api/auth/me')
    assert.equal(state.status, 200)
    assert.equal(state.body.user.displayName, 'Spelling')
    assert.equal(state.body.workspaces.length, 1)
  })

  it('refuses requests the browser marks cross-site, even if the Origin header is missing', async () => {
    const client = new Client(server)
    await client.signup('Marked')
    const reply = await client.post('/api/workspaces', { name: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })
    assert.equal(reply.status, 403)
  })

  it('refuses the opaque "null" origin (sandboxed pages, redirects)', async () => {
    const client = new Client(server)
    await client.signup('Opaque')
    assert.equal((await client.post('/api/workspaces', { name: 'x' }, { Origin: 'null' })).status, 403)
  })

  it('refuses look-alike origins', async () => {
    const client = new Client(server)
    await client.signup('Lookalike')
    for (const origin of [`${ORIGIN}.evil.example`, 'http://localhost:5173@evil.example', 'http://localhost:5174', 'https://localhost:5173', `${ORIGIN}/`, 'http://LOCALHOST:5173']) {
      const reply = await client.post('/api/workspaces', { name: 'x' }, { Origin: origin })
      assert.equal(reply.status, 403, origin)
    }
  })

  it('accepts the real origin, same-origin fetches, and requests with no Origin (scripts, tests)', async () => {
    const client = new Client(server)
    await client.signup('Fine')
    assert.equal((await client.post('/api/workspaces', { name: 'a' }, { Origin: ORIGIN })).status, 201)
    assert.equal((await client.post('/api/workspaces', { name: 'b' }, { 'Sec-Fetch-Site': 'same-origin' })).status, 201)
    assert.equal((await client.post('/api/workspaces', { name: 'c' })).status, 201)
  })

  it('never sends CORS permission headers, so other sites cannot read answers', async () => {
    const client = new Client(server)
    await client.signup('NoCors')
    for (const reply of [await client.get('/api/auth/me', EVIL), await client.request('OPTIONS', '/api/auth/login', undefined, EVIL), await client.post('/api/auth/login', { email: 'a@b.co', password: 'x' }, EVIL)]) {
      assert.equal(reply.headers.get('access-control-allow-origin'), null)
      assert.equal(reply.headers.get('access-control-allow-credentials'), null)
    }
  })
})

describe('request bodies', () => {
  let server: TestServer
  before(async () => {
    server = await startTestServer()
  })
  after(async () => {
    await server.close()
  })

  const login = JSON.stringify({ email: 'a@example.com', password: 'whatever it is' })

  it('accepts JSON only: text/plain and form posts get 415 (the types a hostile page can send without asking)', async () => {
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/xml']) {
      const reply = await new Client(server).post('/api/auth/login', login, { 'Content-Type': type })
      assert.equal(reply.status, 415, type)
      assert.equal(reply.body.error.code, 'unsupported_media_type')
    }
  })

  it('answers 400 for broken JSON, and does not echo the input or parser details', async () => {
    for (const body of ['{"email":', '{', 'not json', '{"a":1}}']) {
      const reply = await new Client(server).post('/api/auth/login', body)
      assert.equal(reply.status, 400, body)
      assert.equal(reply.body.error.code, 'bad_request')
      assert.ok(!/position|Unexpected|JSON/.test(reply.body.error.message), reply.body.error.message)
    }
  })

  it('answers 413 for a body over 64 KiB', async () => {
    const reply = await new Client(server).post('/api/auth/login', { email: 'a@example.com', password: 'x'.repeat(70_000) })
    assert.equal(reply.status, 413)
    assert.equal(reply.body.error.code, 'too_large')
  })

  it('answers 400 (not 500) for a body that is JSON but the wrong shape', async () => {
    for (const body of ['null', '[]', '"text"', '42', '{"email":{"$ne":null},"password":"x"}', '{"email":"a@example.com","password":["x"]}']) {
      const reply = await new Client(server).post('/api/auth/login', body)
      assert.equal(reply.status, 400, body)
    }
  })

  it('treats a missing body on a POST that needs one as a plain 400', async () => {
    const reply = await new Client(server).request('POST', '/api/auth/login', undefined, { 'Content-Type': 'application/json' })
    assert.ok([400, 415].includes(reply.status), String(reply.status))
  })
})

describe('response headers and error shapes', () => {
  let server: TestServer
  before(async () => {
    server = await startTestServer()
  })
  after(async () => {
    await server.close()
  })

  it('locks down API responses', async () => {
    const reply = await new Client(server).get('/api/health')
    assert.equal(reply.headers.get('cache-control'), 'no-store')
    assert.equal(reply.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(reply.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(reply.headers.get('x-powered-by'), null)
    assert.equal(reply.headers.get('cross-origin-resource-policy'), 'same-origin')
    const csp = reply.headers.get('content-security-policy') ?? ''
    for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(part), `${part} in ${csp}`)
    assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline/.test(csp), 'no inline or eval scripts')
  })

  it('sends the same headers however the API address is spelled', async () => {
    const client = new Client(server)
    await client.signup('Spelled')
    for (const url of ['/%61pi/auth/me', '/%61pi/health']) {
      const reply = await client.get(url)
      assert.equal(reply.status, 200, url)
      assert.equal(reply.headers.get('cache-control'), 'no-store', url)
    }
  })

  it('does not cache private answers', async () => {
    const client = new Client(server)
    await client.signup('Private')
    for (const url of ['/api/auth/me', '/api/health']) assert.equal((await client.get(url)).headers.get('cache-control'), 'no-store')
  })

  it('all errors look the same: { error: { code, message } }', async () => {
    const client = new Client(server)
    const replies = [
      await client.get('/api/auth/me'),
      await client.get('/api/nothing-here'),
      await client.post('/api/auth/login', { email: 'x' }),
      await client.post('/api/auth/login', '{', { 'Content-Type': 'application/json' }),
    ]
    for (const reply of replies) {
      assert.ok(reply.status >= 400 && reply.status < 500)
      assert.equal(typeof reply.body.error.code, 'string')
      assert.equal(typeof reply.body.error.message, 'string')
      assert.ok(!/node_modules|\.ts:|at \w+ \(/.test(JSON.stringify(reply.body)), 'no stack traces')
    }
  })

  it('shows the connection URL only to the WebSocket server, not as a page', async () => {
    const reply = await new Client(server).get('/collab')
    assert.equal(reply.status, 404)
  })
})

describe('behind a proxy and under load', () => {
  it('ignores X-Forwarded-For unless a proxy is trusted, so the limit cannot be dodged by lying', async () => {
    const server = await startTestServer({ patch: (config) => ({ ...config, limits: { ...config.limits, global: { max: 5, windowMs: 60_000 } } }) })
    try {
      const client = new Client(server)
      const statuses: number[] = []
      for (let i = 0; i < 8; i++) statuses.push((await client.get('/api/health', { 'X-Forwarded-For': `10.0.0.${i}` })).status)
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429])
    } finally {
      await server.close()
    }
  })

  it('uses the address the proxy reports when one proxy is trusted', async () => {
    const server = await startTestServer({
      env: { CONFLUX_TRUST_PROXY: '1' },
      patch: (config) => ({ ...config, limits: { ...config.limits, global: { max: 2, windowMs: 60_000 } } }),
    })
    try {
      const client = new Client(server)
      const call = (ip: string) => client.get('/api/health', { 'X-Forwarded-For': ip })
      assert.equal((await call('1.1.1.1')).status, 200)
      assert.equal((await call('1.1.1.1')).status, 200)
      assert.equal((await call('1.1.1.1')).status, 429, 'same visitor is limited')
      assert.equal((await call('2.2.2.2')).status, 200, 'a different visitor is not')
      // A visitor cannot pick their own address by sending a long list: only the entry our proxy added counts.
      assert.equal((await call('9.9.9.9, 1.1.1.1')).status, 429)
    } finally {
      await server.close()
    }
  })

  it('answers 429 with Retry-After when too many requests arrive', async () => {
    const server = await startTestServer({ patch: (config) => ({ ...config, limits: { ...config.limits, global: { max: 3, windowMs: 60_000 } } }) })
    try {
      const client = new Client(server)
      for (let i = 0; i < 3; i++) assert.equal((await client.get('/api/health')).status, 200)
      const reply = await client.get('/api/health')
      assert.equal(reply.status, 429)
      assert.equal(reply.body.error.code, 'rate_limited')
      assert.match(reply.headers.get('retry-after') ?? '', /^\d+$/)
    } finally {
      await server.close()
    }
  })
})

describe('request limits', () => {
  it('counts oddly spelled API addresses too, so the limit cannot be dodged', async () => {
    const server = await startTestServer({ patch: (config) => ({ ...config, limits: { ...config.limits, global: { max: 3, windowMs: 60_000 } } }) })
    try {
      const client = new Client(server)
      assert.equal((await client.get('/api/health')).status, 200)
      assert.equal((await client.get('/%61pi/health')).status, 200)
      assert.equal((await client.get('/a%70i/health')).status, 200)
      const reply = await client.get('/%61pi/health')
      assert.equal(reply.status, 429)
      assert.equal((await client.get('/api/health')).status, 429)
    } finally {
      await server.close()
    }
  })
})

describe('health and failures', () => {
  it('reports healthy, then unhealthy when the database goes away, without leaking details', async () => {
    const server = await startTestServer()
    try {
      const client = new Client(server)
      const ok = await client.get('/health')
      assert.equal(ok.status, 200)
      assert.equal(ok.body.ok, true)
      assert.match(ok.body.version, /^\d+\.\d+\.\d+/)
      assert.equal((await client.get('/api/health')).status, 200)

      const account = await client.signup('Before')
      await server.breakDatabase()
      const down = await client.get('/health')
      assert.equal(down.status, 503)
      assert.equal(down.body.error.code, 'unhealthy')

      const broken = await client.get('/api/auth/me')
      assert.equal(broken.status, 500)
      assert.equal(broken.body.error.code, 'internal')
      assert.ok(!/pglite|closed|select|sessions|relation/i.test(JSON.stringify(broken.body)), JSON.stringify(broken.body))
      assert.ok(account.user.id)
    } finally {
      await server.close()
    }
  })
})

describe('serving the web app', () => {
  let server: TestServer
  let dir: string
  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conflux-web-'))
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Conflux</title><div id="root"></div>')
    writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log("app")')
    writeFileSync(path.join(dir, '.secret'), 'TOPSECRET')
    server = await startTestServer({ patch: (config) => ({ ...config, webDist: dir }) })
  })
  after(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves the page with the security headers and never caches it', async () => {
    const reply = await new Client(server).get('/')
    assert.equal(reply.status, 200)
    assert.match(String(reply.body), /id="root"/)
    assert.equal(reply.headers.get('cache-control'), 'no-cache')
    assert.ok((reply.headers.get('content-security-policy') ?? '').includes("default-src 'self'"))
    assert.match(reply.headers.get('content-type') ?? '', /text\/html/)
  })

  it('caches built files forever (their names change when they change)', async () => {
    const reply = await new Client(server).get('/assets/app-abc123.js')
    assert.equal(reply.status, 200)
    assert.equal(reply.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  })

  it('serves the app for in-app links like /#/w/... and unknown paths, so a refresh works', async () => {
    const reply = await new Client(server).get('/some/deep/link')
    assert.equal(reply.status, 200)
    assert.match(String(reply.body), /id="root"/)
  })

  it('keeps unknown API paths as JSON 404s, not the app', async () => {
    const reply = await new Client(server).get('/api/nope')
    assert.equal(reply.status, 404)
    assert.equal(reply.body.error.code, 'not_found')
  })

  it('does not hand out hidden files or files outside the folder', async () => {
    for (const url of ['/.secret', '/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/assets/../../package.json', '/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd']) {
      const reply = await new Client(server).get(url)
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      assert.ok(!text.includes('TOPSECRET'), url)
      assert.ok(!text.includes('@conflux/server') && !text.includes('root:x:'), url)
    }
  })

  it('does not serve files for POST or other methods', async () => {
    const reply = await new Client(server).post('/', {})
    assert.equal(reply.status, 404)
  })
})
