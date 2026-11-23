import { randomBytes } from 'node:crypto'
import { expect, test as base, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'

export const PASSWORD = 'correct horse battery staple'
export type Person = {
  name: string
  email: string
  page: Page
  context: BrowserContext
}

export type App = {
  signUp: (name: string) => Promise<Person>
  join: (link: string, name: string) => Promise<Person>
  visitor: () => Promise<Person>
  anotherTab: (person: Person) => Promise<Page>
}

const unique = (label: string) => `${label.toLowerCase().replace(/[^a-z0-9]/g, '')}.${randomBytes(4).toString('hex')}@example.test`

async function fillAccountForm(page: Page, name: string, email: string) {
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
}

export const test = base.extend<{ app: App }>({
  app: async ({ browser }, use) => {
    const contexts: BrowserContext[] = []
    const fresh = async (): Promise<{ context: BrowserContext; page: Page }> => {
      const context = await (browser as Browser).newContext()
      contexts.push(context)
      context.on('page', (page) => page.on('dialog', (dialog) => void dialog.accept()))
      const page = await context.newPage()
      return { context, page }
    }
    await use({
      async signUp(name) {
        const { context, page } = await fresh()
        const email = unique(name)
        await page.goto('/')
        await page.getByRole('button', { name: 'Create an account' }).click()
        await fillAccountForm(page, name, email)
        await expect(page.locator('.doc')).toContainText('Welcome to Conflux')
        return { name, email, page, context }
      },
      async join(link, name) {
        const { context, page } = await fresh()
        const email = unique(name)
        await page.goto(link)
        await fillAccountForm(page, name, email)
        await page.getByRole('button', { name: 'Join workspace' }).click()
        await expect(page.getByRole('navigation', { name: 'Pages' })).toBeVisible()
        return { name, email, page, context }
      },
      async visitor() {
        const { context, page } = await fresh()
        await page.goto('/')
        return { name: 'Visitor', email: '', page, context }
      },
      async anotherTab(person) {
        const page = await person.context.newPage()
        await page.goto('/')
        return page
      },
    })
    await Promise.all(contexts.map((context) => context.close()))
  },
})

export { expect }

export const workspaceIdOf = (page: Page) => /#\/w\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? ''
export const pageIdOf = (page: Page) => /\/p\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? ''
export const editor = (page: Page) => page.locator('.doc')
export const pageText = (page: Page) =>
  editor(page).evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.collaboration-carets__caret').forEach((caret) => caret.remove())
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
  })

export const membersButton = (page: Page) => page.getByRole('button', { name: /^Members/ })
export const pageList = (page: Page) => page.getByRole('navigation', { name: 'Pages' })

export async function openMembers(page: Page, tab?: 'People' | 'Invite links' | 'Settings'): Promise<Locator> {
  await membersButton(page).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  if (tab) await dialog.getByRole('tab', { name: tab }).click()
  return dialog
}

export async function closeDialog(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

export async function createInviteLink(owner: Person, role: 'editor' | 'viewer', uses = 10): Promise<string> {
  const dialog = await openMembers(owner.page, 'Invite links')
  await dialog.getByLabel('Role', { exact: true }).selectOption(role)
  await dialog.getByLabel('Can be used', { exact: true }).selectOption(String(uses))
  await dialog.getByRole('button', { name: 'Create link' }).click()
  const link = await dialog.getByLabel('Invite link', { exact: true }).inputValue()
  await closeDialog(owner.page)
  return link
}

export async function typeAtEnd(page: Page, text: string) {
  await editor(page).click({ position: { x: 30, y: 12 } })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.type(text)
}

export const accountMenu = (page: Page) => page.getByRole('button', { name: /^Account:/ })
export async function signOut(page: Page) {
  await accountMenu(page).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
}

export async function call(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const response = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = text
      }
      return { status: response.status, body: parsed }
    },
    { method, url, body },
  )
}

export async function statusOf(page: Page, method: string, url: string, body?: unknown): Promise<number> {
  return (await call(page, method, url, body)).status
}

export type Me = {
  user: { id: string; email: string; displayName: string }
  workspaces: Array<{ id: string; name: string; role: 'owner' | 'editor' | 'viewer' }>
}

export async function whoAmI(page: Page): Promise<Me> {
  const { status, body } = await call(page, 'GET', '/api/auth/me')
  if (status !== 200) throw new Error(`/api/auth/me answered ${status}`)
  return body as Me
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

export const savedCopies = (page: Page) =>
  page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name ?? '').filter((name) => name.startsWith('conflux:')))

export const liveStatus = (page: Page) => page.locator('.sidebar .status')
export const hereNow = (page: Page, count: number) => page.getByRole('group', { name: `${count} here now` })
export async function timeUntil(check: () => Promise<unknown>): Promise<number> {
  const started = Date.now()
  await check()
  return Date.now() - started
}
