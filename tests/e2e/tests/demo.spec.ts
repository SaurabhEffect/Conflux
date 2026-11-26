import type { Page } from '@playwright/test'
import { call, closeDialog, editor, expect, hereNow, pageList, pageText, test, whoAmI, type App, type Person } from './helpers'
const DEMO_CAPACITY = 6

const TICKET = /#\/demo\/([A-Za-z0-9_-]{43})/
const ticketOf = (page: Page) => TICKET.exec(page.url())?.[1] ?? ''
const BOT_GREETING_END = 'press Enter, and I will answer.'
const BOT_HELP_ANSWER = 'I understand: @bot help, @bot count, @bot todo, @bot hello.'

async function startDemo(app: App): Promise<Person> {
  const person = await app.visitor()
  await person.page.getByRole('button', { name: 'Try the live demo, no account' }).click()
  await expect(person.page).toHaveURL(TICKET)
  await expect(pageList(person.page)).toBeVisible()
  await expect(person.page.locator('.demo-tag')).toHaveText('Guest demo')
  return person
}

async function inviteLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Invite someone' }).click()
  const link = await page.getByRole('dialog').getByLabel('Demo link').inputValue()
  await closeDialog(page)
  return link
}

async function openLink(app: App, link: string): Promise<Person> {
  const person = await app.visitor()
  await person.page.goto(link)
  return person
}

const greeted = (page: Page) => expect(editor(page)).toContainText(BOT_GREETING_END, { timeout: 20_000 })
async function caretToEnd(page: Page) {
  await editor(page).click({ position: { x: 30, y: 12 } })
  await expect(async () => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    const atEnd = await editor(page).evaluate((doc) => {
      const anchor = window.getSelection()?.anchorNode
      return Boolean(anchor && doc.lastElementChild?.contains(anchor))
    })
    expect(atEnd, 'the caret is in the last block').toBe(true)
  }).toPass({ timeout: 8000 })
}

async function writeLine(page: Page, text: string) {
  await caretToEnd(page)
  await page.keyboard.press('Enter')
  await page.keyboard.type(text)
}

const myName = async (page: Page) => (await page.locator('.demo-note strong').first().textContent()) ?? ''

test.describe('starting a demo', () => {
  test('someone with no account starts one from the sign-in page and finds starter pages and a bot', async ({ app }) => {
    const visitor = await app.visitor()
    const { page } = visitor
    const addresses: string[] = []
    page.on('request', (request) => addresses.push(request.url()))
    page.on('websocket', (socket) => addresses.push(socket.url()))

    await expect(page.getByText(/A throw-away workspace with a bot/)).toBeVisible()
    await page.getByRole('button', { name: 'Try the live demo, no account' }).click()
    await expect(page).toHaveURL(TICKET)
    const ticket = ticketOf(page)

    await expect(pageList(page).getByRole('link')).toHaveText(['Welcome to the demo', 'Team notes', 'Ideas board'])
    await expect(page.getByLabel('Page title')).toHaveValue('Welcome to the demo')
    await expect(editor(page)).toContainText('Welcome to the Conflux demo')
    await expect(page.locator('.demo-note')).toContainText('This is a throw-away demo')
    await expect(page.getByRole('button', { name: 'End demo for everyone' })).toBeVisible()
    await greeted(page)
    await expect(editor(page)).toContainText('Hi, I am Conflux Bot')
    await expect(hereNow(page, 2)).toBeVisible()
    await expect(page.locator('.collaboration-carets__caret').filter({ hasText: 'Conflux Bot' })).toHaveCount(1)
    const cookie = (await visitor.context.cookies()).find((entry) => entry.name.includes('conflux_demo'))
    expect(cookie, 'the visitor got a demo cookie').toBeTruthy()
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('Lax')
    expect(await page.evaluate(() => document.cookie)).not.toContain('conflux_demo')

    expect(ticket).toHaveLength(43)
    expect(addresses.filter((address) => address.includes(ticket)), 'the secret was sent in an address').toEqual([])
  })

  test('another page of the demo opens, and the address keeps pointing at it', async ({ app }) => {
    const { page } = await startDemo(app)
    await pageList(page).getByRole('link', { name: 'Team notes' }).click()
    await expect(page.getByLabel('Page title')).toHaveValue('Team notes')
    await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}$/)
    await expect(editor(page)).toContainText('Sprint planning')
    await page.reload()
    await expect(page.getByLabel('Page title')).toHaveValue('Team notes')
  })

  test('a link that cannot be real says the demo is over, and offers a new one', async ({ app }) => {
    const visitor = await app.visitor()
    await visitor.page.goto('/#/demo/short')
    await expect(visitor.page.getByRole('heading', { name: 'This demo has ended' })).toBeVisible()
    await visitor.page.getByRole('button', { name: 'Start a new demo' }).click()
    await expect(visitor.page).toHaveURL(TICKET)
    await expect(pageList(visitor.page)).toBeVisible()
  })

  test('a well-formed link to no demo says the same, without revealing anything', async ({ app }) => {
    const visitor = await app.visitor()
    await visitor.page.goto(`/#/demo/${'A'.repeat(43)}`)
    await expect(visitor.page.getByRole('heading', { name: 'This demo has ended' })).toBeVisible()
    await expect(visitor.page.getByRole('button', { name: 'Back to Conflux' })).toBeVisible()
  })
})

test.describe('two people in one demo', () => {
  test('the invite link brings a second person in; they see each other, type together and share the bot', async ({ app }) => {
    const host = await startDemo(app)
    await greeted(host.page)
    const link = await inviteLink(host.page)
    expect(link).toMatch(TICKET)

    const guest = await openLink(app, link)
    await expect(pageList(guest.page)).toBeVisible()
    await expect(guest.page.getByRole('button', { name: 'Leave demo' })).toBeVisible()
    await expect(guest.page.getByRole('button', { name: 'End demo for everyone' })).toHaveCount(0)
    await expect(hereNow(host.page, 3)).toBeVisible()
    await expect(hereNow(guest.page, 3)).toBeVisible()
    const hostName = await myName(host.page)
    const guestName = await myName(guest.page)
    expect(hostName).not.toBe('')
    expect(guestName).not.toBe(hostName)
    await expect(guest.page.getByLabel('Page title')).toHaveValue('Welcome to the demo')
    await writeLine(host.page, 'Written by the host')
    await expect.poll(() => pageText(guest.page)).toContain('Written by the host')
    await expect(guest.page.locator('.doc .collaboration-carets__caret').filter({ hasText: hostName })).toHaveCount(1)
    await writeLine(guest.page, 'Written by the guest')
    await expect.poll(() => pageText(host.page)).toContain('Written by the guest')
    await expect(host.page.locator('.doc .collaboration-carets__caret').filter({ hasText: guestName })).toHaveCount(1)
    await writeLine(guest.page, '@bot hello')
    await guest.page.keyboard.press('Enter')
    await expect.poll(() => pageText(host.page), { timeout: 20_000 }).toContain('Hello! It is nice to write together.')
    await expect.poll(() => pageText(guest.page)).toContain('Hello! It is nice to write together.')
  })

  test('a person who leaves is gone from the list, and the demo goes on for the others', async ({ app }) => {
    const host = await startDemo(app)
    await greeted(host.page)
    const guest = await openLink(app, await inviteLink(host.page))
    await expect(hereNow(host.page, 3)).toBeVisible()
    await guest.page.getByRole('button', { name: 'Leave demo' }).click()
    await expect(guest.page.getByRole('button', { name: 'Create an account' })).toBeVisible()
    await expect(hereNow(host.page, 2)).toBeVisible()
    await writeLine(host.page, 'Still here')
    await expect.poll(() => pageText(host.page)).toContain('Still here')
    await expect(host.page.getByRole('button', { name: 'End demo for everyone' })).toBeVisible()
  })

  test('the seventh person is told the demo is full, and can start their own', async ({ app }) => {
    const host = await startDemo(app)
    const link = await inviteLink(host.page)
    const ticket = ticketOf(host.page)
    for (let index = 1; index < DEMO_CAPACITY; index += 1) {
      const person = await app.visitor()
      const joined = await call(person.page, 'POST', '/api/demo/join', { ticket })
      expect(joined.status, `person ${index + 1} joins`).toBe(200)
    }

    const late = await openLink(app, link)
    await expect(late.page.getByRole('heading', { name: 'This demo is full' })).toBeVisible()
    await late.page.getByRole('button', { name: 'Start my own demo' }).click()
    await expect.poll(() => ticketOf(late.page), { message: 'their own demo has its own link' }).not.toBe(ticket)
    await expect(late.page).toHaveURL(TICKET)
    await expect(pageList(late.page)).toBeVisible()
    await expect(host.page.getByRole('button', { name: 'End demo for everyone' })).toBeVisible()
  })
})

test.describe('the same visitor again', () => {
  test('a refresh keeps who you are and what you wrote', async ({ app }) => {
    const host = await startDemo(app)
    await greeted(host.page)
    const name = await myName(host.page)
    await writeLine(host.page, 'Written before the refresh')
    await expect.poll(() => pageText(host.page)).toContain('Written before the refresh')

    await host.page.reload()
    await expect(pageList(host.page)).toBeVisible()
    await expect(host.page.getByRole('button', { name: 'End demo for everyone' })).toBeVisible()
    expect(await myName(host.page)).toBe(name)
    await expect.poll(() => pageText(host.page)).toContain('Written before the refresh')
    await expect(hereNow(host.page, 2)).toBeVisible()
  })

  test('opening the invite link again in the same browser does not make a second person', async ({ app }) => {
    const host = await startDemo(app)
    await greeted(host.page)
    const name = await myName(host.page)
    const link = await inviteLink(host.page)
    const secondTab = await host.context.newPage()
    await secondTab.goto(link)
    await expect(pageList(secondTab)).toBeVisible()
    expect(await myName(secondTab)).toBe(name)
    await expect(secondTab.getByRole('button', { name: 'End demo for everyone' })).toBeVisible()
  })

  test('somebody who is signed in to an account can visit a demo and come back to their account', async ({ app }) => {
    const ana = await app.signUp('Ana')
    const host = await startDemo(app)
    const link = await inviteLink(host.page)

    await ana.page.goto(link)
    await expect(ana.page.locator('.demo-tag')).toHaveText('Guest demo')
    await ana.page.getByRole('button', { name: 'Leave demo' }).click()
    await expect(ana.page.locator('.doc')).toContainText('Welcome to Conflux')
    expect((await whoAmI(ana.page)).user.displayName).toBe('Ana')
  })
})

test.describe('the bot', () => {
  test('answers "@bot help" on the line under the question, and goes on to answer others', async ({ app }) => {
    const { page } = await startDemo(app)
    await greeted(page)
    await writeLine(page, '@bot help')
    await page.keyboard.press('Enter')
    const asked = page.locator('.doc p').filter({ hasText: /^@bot help$/ })
    await expect(asked.locator('xpath=following-sibling::p[1]')).toContainText(`🤖 ${BOT_HELP_ANSWER}`, { timeout: 20_000 })
    await writeLine(page, '@bot count')
    await page.keyboard.press('Enter')
    await expect(page.locator('.doc')).toContainText(/This page has \d+ blocks of text and \d+ words\./, { timeout: 20_000 })
  })

  test('answers above while you keep typing below: your words and your caret stay where they were', async ({ app }) => {
    const { page } = await startDemo(app)
    await greeted(page)
    await writeLine(page, '@bot help')
    await page.keyboard.press('Enter')
    const sentence = 'The quick brown fox jumps over the lazy dog while the bot is typing above'
    await page.keyboard.type(sentence, { delay: 70 })
    const asked = page.locator('.doc p').filter({ hasText: /^@bot help$/ })
    await expect(asked.locator('xpath=following-sibling::p[1]')).toContainText(`🤖 ${BOT_HELP_ANSWER}`, { timeout: 20_000 })
    await expect(page.locator('.doc p').filter({ hasText: sentence })).toHaveCount(1)
    expect(await pageText(page)).toContain(`${BOT_HELP_ANSWER}${sentence}`)
  })

  test('does not answer a line that is not a command, and does not repeat what was written', async ({ app }) => {
    const { page } = await startDemo(app)
    await greeted(page)
    await writeLine(page, 'please @bot help me')
    await page.keyboard.press('Enter')
    await page.keyboard.type('<b>@bot</b> help')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(3500)
    const text = await pageText(page)
    expect(text).not.toContain(BOT_HELP_ANSWER)
    expect(text.match(/🤖/g) ?? []).toHaveLength(1) // only the greeting
  })

  test('shows up as one person in the list, however many visitors are there', async ({ app }) => {
    const host = await startDemo(app)
    await greeted(host.page)
    await expect(hereNow(host.page, 2)).toBeVisible()
    const guest = await openLink(app, await inviteLink(host.page))
    await expect(hereNow(guest.page, 3)).toBeVisible()
    await expect(guest.page.locator('.collaboration-carets__caret').filter({ hasText: 'Conflux Bot' })).toHaveCount(1)
  })
})

test.describe('ending a demo', () => {
  test('the host ends it: everyone is told, the link stops working, and nothing is left to find', async ({ app }) => {
    const host = await startDemo(app)
    await greeted(host.page)
    const link = await inviteLink(host.page)
    const guest = await openLink(app, link)
    await expect(hereNow(guest.page, 3)).toBeVisible()
    await host.page.getByRole('button', { name: 'End demo for everyone' }).click()
    await expect(host.page.getByRole('heading', { name: 'Demo ended and deleted' })).toBeVisible()
    await expect(guest.page.getByRole('heading', { name: 'This demo has ended' })).toBeVisible({ timeout: 15_000 })
    const later = await openLink(app, link)
    await expect(later.page.getByRole('heading', { name: 'This demo has ended' })).toBeVisible()
    const answer = await call(later.page, 'POST', '/api/demo/join', { ticket: link.split('#/demo/')[1] })
    expect(answer.status).toBe(404)
    expect(answer.body.error.code).toBe('demo_ended')
  })

  test('after it ended, "Start a new demo" gives a fresh one with the starter pages again', async ({ app }) => {
    const host = await startDemo(app)
    await greeted(host.page)
    await writeLine(host.page, 'Only in the first demo')
    await expect.poll(() => pageText(host.page)).toContain('Only in the first demo')
    const first = ticketOf(host.page)

    await host.page.getByRole('button', { name: 'End demo for everyone' }).click()
    await expect(host.page.getByRole('heading', { name: 'Demo ended and deleted' })).toBeVisible()
    await host.page.getByRole('button', { name: 'Start a new demo' }).click()
    await expect.poll(() => ticketOf(host.page), { message: 'a new demo has a new link' }).not.toBe(first)
    await expect(host.page).toHaveURL(TICKET)
    await expect(pageList(host.page).getByRole('link')).toHaveText(['Welcome to the demo', 'Team notes', 'Ideas board'])
    await expect(editor(host.page)).toContainText('Welcome to the Conflux demo')
    expect(await pageText(host.page)).not.toContain('Only in the first demo')
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true })

  test('the demo is usable: the pages are in the menu, and the page fits the screen', async ({ app }) => {
    const { page } = await startDemo(app)
    await expect(page.getByRole('button', { name: 'Open pages' })).toBeVisible()
    await greeted(page)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'no sideways scrolling').toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: 'Open pages' }).click()
    await expect(page.getByRole('button', { name: 'Invite someone' })).toBeVisible()
    await page.getByRole('link', { name: 'Ideas board' }).click()
    await expect(page.getByLabel('Page title')).toHaveValue('Ideas board')
  })
})
