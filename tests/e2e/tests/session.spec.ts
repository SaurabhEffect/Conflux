import { request as playwrightRequest } from '@playwright/test'
import { call, editor, expect, pageIdOf, signOut, test, whoAmI } from './helpers'

test.describe('sessions', () => {
  test('the session cookie is httpOnly, and nothing that grants access sits where scripts can read it', async ({ app }) => {
    const ana = await app.signUp('Ana')
    const cookies = await ana.context.cookies()
    const session = cookies.find((cookie) => cookie.name.endsWith('conflux_session'))
    expect(session, 'a session cookie exists').toBeDefined()
    expect(session?.httpOnly).toBe(true)
    expect(session?.sameSite).toBe('Lax')
    expect(session?.path).toBe('/')

    expect(await ana.page.evaluate(() => document.cookie)).not.toContain('conflux_session')
    const stored = await ana.page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
    expect(stored).not.toContain(session?.value ?? 'no-value')
  })

  test('signing out in one tab signs the other tabs of that browser out as well', async ({ app }) => {
    const ana = await app.signUp('Ana')
    const second = await app.anotherTab(ana)
    await expect(editor(second)).toContainText('Welcome to Conflux')

    const started = Date.now()
    await signOut(ana.page)
    await expect(ana.page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await expect(second.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 6_000 })
    await expect(second.getByRole('status').filter({ hasText: 'Your session ended' })).toBeVisible()
    test.info().annotations.push({ type: 'other tab noticed the sign-out', description: `${Date.now() - started} ms` })
  })

  test('a copied session cookie stops working the moment its owner signs out', async ({ app, baseURL }) => {
    const ana = await app.signUp('Ana')
    const cookie = (await ana.context.cookies()).find((item) => item.name.endsWith('conflux_session'))
    expect(cookie).toBeDefined()

    const thief = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { Cookie: `${cookie?.name}=${cookie?.value}` } })
    try {
      expect((await thief.get('/api/auth/me')).status()).toBe(200)
      await signOut(ana.page)
      await expect(ana.page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
      expect((await thief.get('/api/auth/me')).status()).toBe(401)
    } finally {
      await thief.dispose()
    }
  })

  test('sync tokens are short-lived and made for exactly one document', async ({ app }) => {
    const ana = await app.signUp('Ana')
    const doc = `page.${pageIdOf(ana.page)}`

    const issued = await call(ana.page, 'POST', '/api/sync-token', { doc })
    expect(issued.status).toBe(200)
    const claims = JSON.parse(Buffer.from(String(issued.body.token).split('.')[1], 'base64url').toString('utf8'))
    expect(claims.doc).toBe(doc)
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60)
    expect(Date.parse(issued.body.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000)
    expect((await call(ana.page, 'POST', '/api/sync-token', { doc: 'not-a-document' })).status).toBe(404)
    expect((await call(ana.page, 'POST', '/api/sync-token', { doc: 'page.00000000-0000-4000-8000-000000000000' })).status).toBe(404)
    expect((await call(ana.page, 'POST', '/api/sync-token', { doc: 'x'.repeat(101) })).status).toBe(400)
    expect((await call(ana.page, 'POST', '/api/sync-token', { doc, extra: 'field' })).status).toBe(400)
  })

  test('the app and the API come with a strict content security policy and no caching of private data', async ({ request }) => {
    const index = await request.get('/')
    const policy = index.headers()['content-security-policy'] ?? ''
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(index.headers()['x-content-type-options']).toBe('nosniff')
    expect(index.headers()['referrer-policy']).toBe('no-referrer')

    const api = await request.get('/api/auth/me')
    expect(api.status()).toBe(401)
    expect(api.headers()['cache-control']).toBe('no-store')
  })

  test('a request that says it comes from another website is refused, even with the right cookie', async ({ app }) => {
    const ana = await app.signUp('Ana')
    const foreignOrigin = await ana.context.request.post('/api/workspaces', { headers: { Origin: 'https://evil.example' }, data: { name: 'Evil' } })
    expect(foreignOrigin.status()).toBe(403)
    const crossSite = await ana.context.request.post('/api/workspaces', { headers: { 'Sec-Fetch-Site': 'cross-site' }, data: { name: 'Evil' } })
    expect(crossSite.status()).toBe(403)
    const plain = await ana.context.request.post('/api/workspaces', { headers: { 'Content-Type': 'text/plain' }, data: '{"name":"Evil"}' })
    expect(plain.status()).toBe(415)
    expect((await whoAmI(ana.page)).workspaces.map((workspace) => workspace.name)).not.toContain('Evil')
  })
})
