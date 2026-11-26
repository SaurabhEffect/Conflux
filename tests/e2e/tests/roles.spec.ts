import {
  type App,
  call,
  closeDialog,
  createInviteLink,
  editor,
  expect,
  hereNow,
  liveStatus,
  membersButton,
  openMembers,
  pageIdOf,
  pageText,
  savedCopies,
  signIn,
  statusOf,
  test,
  typeAtEnd,
  whoAmI,
  workspaceIdOf,
  type Person,
} from './helpers'

const NOWHERE = '00000000-0000-4000-8000-000000000000'
const NOWHERE_TOO = '00000000-0000-4000-8000-000000000001'

async function workspaceWith(app: App, role: 'editor' | 'viewer', name: string): Promise<{ ana: Person; guest: Person }> {
  const ana = await app.signUp('Ana')
  const guest = await app.join(await createInviteLink(ana, role), name)
  await expect(editor(guest.page)).toContainText('Welcome to Conflux')
  return { ana, guest }
}

test.describe('editors', () => {
  test('an owner and an editor type at the same time and each sees the other', async ({ app }) => {
    const { ana, guest: ben } = await workspaceWith(app, 'editor', 'Ben')
    await expect(hereNow(ana.page, 2)).toBeVisible()

    await typeAtEnd(ana.page, ' Ana was here.')
    await expect(editor(ben.page)).toContainText('Ana was here.')

    await typeAtEnd(ben.page, ' Ben too.')
    await expect(editor(ana.page)).toContainText('Ben too.')
  })

  test('two people typing at once end up with exactly the same page', async ({ app }) => {
    const { ana, guest: ben } = await workspaceWith(app, 'editor', 'Ben')

    const count = (text: string, letter: string) => text.split(letter).length - 1
    const start = await pageText(ana.page)

    await Promise.all([typeAtEnd(ana.page, ' AAAAAAAAAA'), typeAtEnd(ben.page, ' BBBBBBBBBB')])
    await expect
      .poll(async () => {
        const text = await pageText(ana.page)
        return [count(text, 'A') - count(start, 'A'), count(text, 'B') - count(start, 'B')]
      })
      .toEqual([10, 10])
    await expect.poll(async () => (await pageText(ana.page)) === (await pageText(ben.page))).toBe(true)
  })

  test('an editor can write, but cannot manage people or the workspace', async ({ app }) => {
    const { ana, guest: ben } = await workspaceWith(app, 'editor', 'Ben')
    const workspaceId = workspaceIdOf(ana.page)
    const anaId = (await whoAmI(ana.page)).user.id
    const dialog = await openMembers(ben.page)
    await expect(dialog.getByRole('tab')).toHaveCount(0)
    await expect(dialog.getByRole('combobox')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /^Remove / })).toHaveCount(0)
    await closeDialog(ben.page)
    const base = `/api/workspaces/${workspaceId}`
    expect(await statusOf(ben.page, 'GET', `${base}/invites`)).toBe(403)
    expect(await statusOf(ben.page, 'POST', `${base}/invites`, { role: 'editor', expiresInHours: 24, maxUses: 1 })).toBe(403)
    expect(await statusOf(ben.page, 'PATCH', `${base}/members/${anaId}`, { role: 'viewer' })).toBe(403)
    expect(await statusOf(ben.page, 'DELETE', `${base}/members/${anaId}`)).toBe(403)
    expect(await statusOf(ben.page, 'PATCH', base, { name: 'Mine now' })).toBe(403)
    expect(await statusOf(ben.page, 'DELETE', base)).toBe(403)
  })
})

test.describe('viewers', () => {
  test('a viewer can read and watch, but the page is read-only', async ({ app }) => {
    const { ana, guest: vic } = await workspaceWith(app, 'viewer', 'Vic')
    await expect(vic.page.getByRole('note')).toContainText('You can read this page, but not change it')
    await expect(editor(vic.page)).toHaveAttribute('contenteditable', 'false')
    await expect(vic.page.locator('.toolbar')).toHaveCount(0)
    await expect(vic.page.getByLabel('Page title')).toHaveAttribute('readonly', '')
    await expect(vic.page.getByRole('button', { name: 'New page' })).toHaveCount(0)
    await expect(vic.page.getByRole('button', { name: /^Delete/ })).toHaveCount(0)
    await typeAtEnd(ana.page, ' Watch this.')
    await expect(editor(vic.page)).toContainText('Watch this.')
    const dialog = await openMembers(vic.page)
    await expect(dialog.getByRole('tab')).toHaveCount(0)
    await expect(dialog.getByRole('combobox')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /^Remove / })).toHaveCount(0)
    await expect(dialog.getByRole('listitem').filter({ hasText: 'Ana' })).toContainText('Owner')
  })

  test('a viewer who unlocks the editor by hand still changes nothing for anyone', async ({ app }) => {
    const { ana, guest: vic } = await workspaceWith(app, 'viewer', 'Vic')
    await vic.page.evaluate(() => document.querySelector('.doc')?.setAttribute('contenteditable', 'true'))
    await editor(vic.page).click({ position: { x: 30, y: 12 } })
    await vic.page.keyboard.press('Control+End')
    await vic.page.keyboard.type(' VIC-SNUCK-IN')
    await typeAtEnd(ana.page, ' ANA-MARKER')
    await expect(editor(vic.page)).toContainText('ANA-MARKER')
    await expect(editor(ana.page)).not.toContainText('VIC-SNUCK-IN')
    const fresh = await app.visitor()
    await signIn(fresh.page, ana.email)
    await expect(editor(fresh.page)).toContainText('ANA-MARKER')
    await expect(editor(fresh.page)).not.toContainText('VIC-SNUCK-IN')
  })

  test('the server refuses a viewer who skips the buttons and calls the API', async ({ app }) => {
    const { ana, guest: vic } = await workspaceWith(app, 'viewer', 'Vic')
    const workspaceId = workspaceIdOf(ana.page)
    const pageId = pageIdOf(ana.page)
    const vicId = (await whoAmI(vic.page)).user.id
    const anaId = (await whoAmI(ana.page)).user.id
    const base = `/api/workspaces/${workspaceId}`

    const attempts: Array<[string, string, string, unknown?]> = [
      ['create a page', 'POST', `${base}/pages`, { title: 'Sneaky' }],
      ['rename a page', 'PATCH', `/api/pages/${pageId}`, { title: 'Hacked' }],
      ['delete a page', 'DELETE', `/api/pages/${pageId}`],
      ['read the invite links', 'GET', `${base}/invites`],
      ['make an invite link', 'POST', `${base}/invites`, { role: 'editor', expiresInHours: 24, maxUses: 1 }],
      ['promote themselves', 'PATCH', `${base}/members/${vicId}`, { role: 'owner' }],
      ['remove the owner', 'DELETE', `${base}/members/${anaId}`],
      ['rename the workspace', 'PATCH', base, { name: 'Mine now' }],
      ['delete the workspace', 'DELETE', base],
    ]
    for (const [what, method, url, body] of attempts) {
      expect(await statusOf(vic.page, method, url, body), `a viewer tries to ${what}`).toBe(403)
    }

    const pages = await call(vic.page, 'GET', `${base}/pages`)
    expect(pages.status).toBe(200)
    expect(pages.body.pages).toHaveLength(1)
    expect(pages.body.pages[0].title).not.toBe('Hacked')
    expect((await whoAmI(vic.page)).workspaces.find((workspace) => workspace.id === workspaceId)?.role).toBe('viewer')
  })
})

test.describe('outsiders', () => {
  test('someone who is not in a workspace cannot even tell that it exists', async ({ app }) => {
    const ana = await app.signUp('Ana')
    const workspaceId = workspaceIdOf(ana.page)
    const pageId = pageIdOf(ana.page)
    const zed = await app.signUp('Zed')

    await zed.page.goto(`/#/w/${workspaceId}/p/${pageId}`)
    await expect(zed.page.getByRole('heading', { name: 'Workspace not found' })).toBeVisible()
    await expect(editor(zed.page)).toHaveCount(0)

    const attempts: Array<[string, string, (workspace: string, page: string) => string, unknown?]> = [
      ['list pages', 'GET', (w) => `/api/workspaces/${w}/pages`],
      ['create a page', 'POST', (w) => `/api/workspaces/${w}/pages`, { title: 'Sneaky' }],
      ['list members', 'GET', (w) => `/api/workspaces/${w}/members`],
      ['list invites', 'GET', (w) => `/api/workspaces/${w}/invites`],
      ['make an invite', 'POST', (w) => `/api/workspaces/${w}/invites`, { role: 'viewer', expiresInHours: 24, maxUses: 1 }],
      ['rename the workspace', 'PATCH', (w) => `/api/workspaces/${w}`, { name: 'Mine now' }],
      ['delete the workspace', 'DELETE', (w) => `/api/workspaces/${w}`],
      ['rename a page', 'PATCH', (_w, p) => `/api/pages/${p}`, { title: 'Hacked' }],
      ['delete a page', 'DELETE', (_w, p) => `/api/pages/${p}`],
    ]
    for (const [what, method, url, body] of attempts) {
      const real = await call(zed.page, method, url(workspaceId, pageId), body)
      const imaginary = await call(zed.page, method, url(NOWHERE, NOWHERE_TOO), body)
      expect(real.status, `${what}: real ids`).toBe(404)
      expect(imaginary.status, `${what}: made-up ids`).toBe(404)
      expect(real.body, `${what}: same words either way`).toEqual(imaginary.body)
    }

    for (const doc of [`page.${pageId}`, `workspace.${workspaceId}`]) {
      expect((await call(zed.page, 'POST', '/api/sync-token', { doc })).status, doc).toBe(404)
    }
    await expect(editor(ana.page)).toContainText('Welcome to Conflux')
  })

  test('a second workspace is separate: its own pages, and only its own people', async ({ app }) => {
    const { ana, guest: ben } = await workspaceWith(app, 'editor', 'Ben')
    const firstId = workspaceIdOf(ana.page)
    await ana.page.getByRole('button', { name: /^Workspace:/ }).click()
    await ana.page.getByRole('menuitem', { name: /New workspace/ }).click()
    await ana.page.getByRole('dialog').getByLabel('Workspace name').fill('Side project')
    await ana.page.getByRole('button', { name: 'Create workspace' }).click()
    await expect(ana.page.getByRole('heading', { name: 'This workspace has no pages yet' })).toBeVisible()
    const secondId = workspaceIdOf(ana.page)
    expect(secondId).not.toBe(firstId)
    await ben.page.getByRole('button', { name: /^Workspace:/ }).click()
    await expect(ben.page.getByRole('menu', { name: 'Your workspaces' })).not.toContainText('Side project')
    expect(await statusOf(ben.page, 'GET', `/api/workspaces/${secondId}/pages`)).toBe(404)
    expect(await statusOf(ben.page, 'GET', `/api/workspaces/${secondId}/members`)).toBe(404)
  })
})

test.describe('changes while people are on the page', () => {
  test("changing someone's role takes effect on their open page, without a reload", async ({ app }) => {
    const { ana, guest: ben } = await workspaceWith(app, 'editor', 'Ben')
    await expect(editor(ben.page)).toHaveAttribute('contenteditable', 'true')
    await expect(ben.page.locator('.toolbar')).toBeVisible()
    const dialog = await openMembers(ana.page, 'People')
    const demoted = Date.now()
    await dialog.getByLabel('Role of Ben').selectOption('viewer')
    await expect(ben.page.getByRole('note')).toContainText('You can read this page', { timeout: 5_000 })
    test.info().annotations.push({ type: 'demotion reached the open page', description: `${Date.now() - demoted} ms (the limit is 5000)` })
    await expect(editor(ben.page)).toHaveAttribute('contenteditable', 'false')
    await expect(ben.page.locator('.toolbar')).toHaveCount(0)
    await expect(ben.page.getByRole('button', { name: 'New page' })).toHaveCount(0)
    await expect(membersButton(ben.page)).toContainText('Viewer')
    await dialog.getByLabel('Role of Ben').selectOption('editor')
    await expect(ben.page.getByRole('note')).toHaveCount(0, { timeout: 5_000 })
    await expect(editor(ben.page)).toHaveAttribute('contenteditable', 'true')
    await typeAtEnd(ben.page, ' Ben again.')
    await expect(editor(ana.page)).toContainText('Ben again.')
  })

  test('removing a member takes their live access away within 5 seconds', async ({ app }) => {
    const { ana, guest: ben } = await workspaceWith(app, 'editor', 'Ben')
    await expect(hereNow(ben.page, 2)).toBeVisible() // Ben is connected to the page, live
    await expect(liveStatus(ben.page)).toContainText('Live')
    const workspaceId = workspaceIdOf(ben.page)
    const pageId = pageIdOf(ben.page)
    const dialog = await openMembers(ana.page, 'People')
    const started = Date.now()
    await dialog.getByRole('button', { name: 'Remove Ben' }).click()
    await expect(ben.page.getByRole('heading', { name: /^You no longer have access to/ })).toBeVisible({ timeout: 5_000 })
    const took = Date.now() - started
    test.info().annotations.push({ type: 'removal reached the open page', description: `${took} ms (the limit is 5000)` })
    expect(took).toBeLessThan(5_000)
    expect(await statusOf(ben.page, 'GET', `/api/workspaces/${workspaceId}/pages`)).toBe(404)
    expect((await call(ben.page, 'POST', '/api/sync-token', { doc: `page.${pageId}` })).status).toBe(404)
    await expect.poll(async () => (await savedCopies(ben.page)).filter((name) => name.includes(pageId))).toEqual([])
    await ben.page.reload()
    await expect(ben.page.getByRole('heading', { name: 'Workspace not found' })).toBeVisible()
    await expect(dialog.getByRole('listitem').filter({ hasText: 'Ben' })).toHaveCount(0)
    await closeDialog(ana.page)
    await typeAtEnd(ana.page, ' Still here.')
    await expect(editor(ana.page)).toContainText('Still here.')
  })

  test('a viewer loses access within 5 seconds as well', async ({ app }) => {
    const { ana, guest: vic } = await workspaceWith(app, 'viewer', 'Vic')
    await expect(hereNow(vic.page, 2)).toBeVisible()
    const dialog = await openMembers(ana.page, 'People')
    const started = Date.now()
    await dialog.getByRole('button', { name: 'Remove Vic' }).click()
    await expect(vic.page.getByRole('heading', { name: /^You no longer have access to/ })).toBeVisible({ timeout: 5_000 })
    const took = Date.now() - started
    test.info().annotations.push({ type: 'viewer removal reached the open page', description: `${took} ms (the limit is 5000)` })
    expect(took).toBeLessThan(5_000)
  })

  test('deleting the workspace sends everyone out within 5 seconds', async ({ app }) => {
    const { ana, guest: ben } = await workspaceWith(app, 'editor', 'Ben')
    await expect(hereNow(ben.page, 2)).toBeVisible()
    const dialog = await openMembers(ana.page, 'Settings')
    const name = await dialog.getByLabel('Workspace name', { exact: true }).inputValue()
    await dialog.getByLabel('Type the workspace name to confirm').fill(name)
    const started = Date.now()
    await dialog.getByRole('button', { name: 'Delete workspace' }).click()
    await expect(ben.page.getByRole('heading', { name: `You no longer have access to ${name}` })).toBeVisible({ timeout: 5_000 })
    const took = Date.now() - started
    test.info().annotations.push({ type: 'workspace deletion reached the open page', description: `${took} ms (the limit is 5000)` })
    expect(took).toBeLessThan(5_000)
    await expect(ana.page.getByRole('heading', { name: 'You are not in any workspace' })).toBeVisible()
  })

  test('removing someone who is not looking at the page works too, and they come back to a clear message', async ({ app }) => {
    const { ana, guest: ben } = await workspaceWith(app, 'editor', 'Ben')
    const workspaceId = workspaceIdOf(ben.page)
    const pageId = pageIdOf(ben.page)
    await expect.poll(async () => (await savedCopies(ben.page)).filter((name) => name.includes(pageId))).not.toEqual([])
    await ben.page.goto('about:blank')
    const dialog = await openMembers(ana.page, 'People')
    await dialog.getByRole('button', { name: 'Remove Ben' }).click()
    await expect(dialog.getByRole('listitem').filter({ hasText: 'Ben' })).toHaveCount(0)
    await ben.page.goto(`/#/w/${workspaceId}`)
    await expect(ben.page.getByRole('heading', { name: 'Workspace not found' })).toBeVisible()
    await expect.poll(async () => (await savedCopies(ben.page)).filter((name) => name.includes(pageId))).toEqual([])
  })
})

test.describe('invite links', () => {
  test('a link that can be used once works once, and a revoked link stops working', async ({ app }) => {
    const ana = await app.signUp('Ana')
    const once = await createInviteLink(ana, 'editor', 1)
    await app.join(once, 'Ben')
    const late = await app.visitor()
    await late.page.goto(once)
    await expect(late.page.getByRole('heading', { name: 'This invite cannot be used' })).toBeVisible()
    const link = await createInviteLink(ana, 'viewer')
    const preview = await app.visitor()
    await preview.page.goto(link)
    await expect(preview.page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
    await expect(preview.page.getByText('as viewer')).toBeVisible()
    const dialog = await openMembers(ana.page, 'Invite links')
    await dialog.getByRole('listitem').filter({ hasText: 'Viewer' }).getByRole('button', { name: 'Revoke' }).click()
    await expect(dialog.getByText('No active links.')).toBeVisible()
    const revoked = await app.visitor()
    await revoked.page.goto(link)
    await expect(revoked.page.getByRole('heading', { name: 'This invite cannot be used' })).toBeVisible()
  })

  test('an invite link made for viewers cannot be turned into editor access', async ({ app }) => {
    const ana = await app.signUp('Ana')
    const link = await createInviteLink(ana, 'viewer')
    const token = link.split('/join/')[1]
    const vic = await app.join(link, 'Vic')
    const workspaceId = workspaceIdOf(vic.page)
    const me = await whoAmI(vic.page)
    expect(me.workspaces.find((workspace) => workspace.id === workspaceId)?.role).toBe('viewer')
    const again = await call(vic.page, 'POST', '/api/invites/accept', { token, role: 'owner' })
    expect([200, 400]).toContain(again.status)
    expect((await whoAmI(vic.page)).workspaces.find((workspace) => workspace.id === workspaceId)?.role).toBe('viewer')
  })
})

test.describe('the last owner', () => {
  test('cannot leave or step down until someone else is an owner', async ({ app }) => {
    const { ana, guest: ben } = await workspaceWith(app, 'editor', 'Ben')
    const workspaceId = workspaceIdOf(ana.page)
    const anaId = (await whoAmI(ana.page)).user.id
    const dialog = await openMembers(ana.page, 'People')
    await expect(dialog.getByRole('button', { name: 'Leave workspace' })).toBeDisabled()
    await expect(dialog.getByLabel('Role of Ana')).toBeDisabled()
    expect(await statusOf(ana.page, 'DELETE', `/api/workspaces/${workspaceId}/members/${anaId}`)).toBe(409)
    expect(await statusOf(ana.page, 'PATCH', `/api/workspaces/${workspaceId}/members/${anaId}`, { role: 'editor' })).toBe(409)
    await dialog.getByLabel('Role of Ben').selectOption('owner')
    await expect(membersButton(ben.page)).toContainText('Owner', { timeout: 5_000 })
    await dialog.getByRole('button', { name: 'Leave workspace' }).click()
    await expect(ana.page.getByRole('heading', { name: 'You are not in any workspace' })).toBeVisible()
    const bens = await openMembers(ben.page, 'People')
    await expect(bens.getByRole('listitem').filter({ hasText: 'Ana' })).toHaveCount(0)
    await expect(bens.getByRole('listitem').filter({ hasText: 'Ben' })).toContainText('Owner')
  })
})
