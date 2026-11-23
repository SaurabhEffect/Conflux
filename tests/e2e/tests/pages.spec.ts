import { call, createInviteLink, editor, expect, pageList, signIn, test, typeAtEnd, workspaceIdOf, type App, type Person } from './helpers'

async function pair(app: App, role: 'editor' | 'viewer', name: string): Promise<{ ana: Person; guest: Person }> {
  const ana = await app.signUp('Ana')
  const guest = await app.join(await createInviteLink(ana, role), name)
  await expect(editor(guest.page)).toContainText('Welcome to Conflux')
  return { ana, guest }
}

async function newPageTitled(person: Person, title: string) {
  await person.page.getByRole('button', { name: 'New page' }).click()
  await expect(person.page.getByLabel('Page title')).toBeFocused()
  await person.page.getByLabel('Page title').fill(title)
  await expect(editor(person.page)).toBeVisible()
}

test.describe('pages', () => {
  test('a new page shows up for everyone straight away, with its title and its text', async ({ app }) => {
    const { ana, guest: ben } = await pair(app, 'editor', 'Ben')
    await newPageTitled(ana, 'Roadmap')
    await typeAtEnd(ana.page, 'First milestone: ship it.')
    const link = pageList(ben.page).getByRole('link', { name: 'Roadmap' })
    await expect(link).toBeVisible()
    await link.click()
    await expect(ben.page.getByLabel('Page title')).toHaveValue('Roadmap')
    await expect(editor(ben.page)).toContainText('First milestone: ship it.')
  })

  test('renaming a page updates everyone, and the new name survives a reload', async ({ app }) => {
    const { ana, guest: ben } = await pair(app, 'editor', 'Ben')
    await newPageTitled(ana, 'Draft')
    await expect(pageList(ben.page).getByRole('link', { name: 'Draft' })).toBeVisible()
    await ana.page.getByLabel('Page title').fill('Final')
    await expect(pageList(ben.page).getByRole('link', { name: 'Final' })).toBeVisible()
    await expect(pageList(ben.page).getByRole('link', { name: 'Draft' })).toHaveCount(0)
    await ana.page.reload()
    await expect(ana.page.getByLabel('Page title')).toHaveValue('Final')
  })

  test('an editor can rename a page that somebody else made', async ({ app }) => {
    const { ana, guest: ben } = await pair(app, 'editor', 'Ben')
    await newPageTitled(ana, 'Ana’s page')
    await pageList(ben.page).getByRole('link', { name: 'Ana’s page' }).click()
    await ben.page.getByLabel('Page title').fill('Ben fixed the title')
    await expect(pageList(ana.page).getByRole('link', { name: 'Ben fixed the title' })).toBeVisible()
  })
  test('deleting a page removes it for everyone, and anyone looking at it is told', async ({ app }) => {
    const { ana, guest: ben } = await pair(app, 'editor', 'Ben')
    await newPageTitled(ana, 'Scratch')
    const scratch = pageList(ben.page).getByRole('link', { name: 'Scratch' })
    await expect(scratch).toBeVisible()
    await scratch.click()
    await expect(ben.page.getByLabel('Page title')).toHaveValue('Scratch')
    await ana.page.getByRole('button', { name: 'Delete page' }).click() // the "are you sure?" box is accepted by the test setup
    await expect(pageList(ana.page).getByRole('link', { name: 'Scratch' })).toHaveCount(0)
    await expect(ben.page.getByRole('heading', { name: 'This page is gone' })).toBeVisible()
    await expect(pageList(ben.page).getByRole('link', { name: 'Scratch' })).toHaveCount(0)
    await ben.page.getByRole('button', { name: 'Back to my pages' }).click()
    await expect(editor(ben.page)).toContainText('Welcome to Conflux')
  })

  test('a viewer sees pages come and go, and can open them read-only', async ({ app }) => {
    const { ana, guest: vic } = await pair(app, 'viewer', 'Vic')
    await newPageTitled(ana, 'Notes')
    await typeAtEnd(ana.page, 'Meeting at noon.')
    const notes = pageList(vic.page).getByRole('link', { name: 'Notes' })
    await expect(notes).toBeVisible()
    await notes.click()
    await expect(editor(vic.page)).toContainText('Meeting at noon.')
    await expect(editor(vic.page)).toHaveAttribute('contenteditable', 'false')
    await ana.page.getByRole('button', { name: 'Delete page' }).click()
    await expect(pageList(vic.page).getByRole('link', { name: 'Notes' })).toHaveCount(0)
  })

  test('what you write is saved on the server, not only in your own browser', async ({ app }) => {
    const ana = await app.signUp('Ana')
    await typeAtEnd(ana.page, ' Saved for later.')
    const second = await app.visitor()
    await signIn(second.page, ana.email)
    await expect(editor(second.page)).toContainText('Saved for later.')
    await second.context.close()
    await ana.context.close()
    const third = await app.visitor()
    await signIn(third.page, ana.email)
    await expect(editor(third.page)).toContainText('Saved for later.')
  })

  test('a title that is too long is cut off by the page, and refused by the server if the page is skipped', async ({ app }) => {
    const ana = await app.signUp('Ana')
    await newPageTitled(ana, 'x'.repeat(300))
    expect((await ana.page.getByLabel('Page title').inputValue()).length).toBeLessThanOrEqual(120)
    const tooLong = await call(ana.page, 'POST', `/api/workspaces/${workspaceIdOf(ana.page)}/pages`, { title: 'x'.repeat(300) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error.code).toBe('invalid_input')
  })
})
