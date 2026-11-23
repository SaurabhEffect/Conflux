import { PASSWORD, accountMenu, call, editor, expect, savedCopies, signIn, signOut, test } from './helpers'

test.describe('accounts', () => {
  test('signing up lands on a welcome page, and a reload keeps you signed in', async ({ app }) => {
    const ana = await app.signUp('Ana')
    await expect(editor(ana.page)).toContainText('Try it in a minute')
    await ana.page.reload()
    await expect(editor(ana.page)).toContainText('Welcome to Conflux')
    await expect(accountMenu(ana.page)).toContainText('Ana')
  })

  test('signing out wipes the saved copies, and signing in brings everything back', async ({ app }) => {
    const ben = await app.signUp('Ben')
    await expect.poll(() => savedCopies(ben.page)).not.toEqual([])

    await signOut(ben.page)
    await expect(ben.page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await expect.poll(() => savedCopies(ben.page)).toEqual([])

    await signIn(ben.page, ben.email)
    await expect(editor(ben.page)).toContainText('Welcome to Conflux')
  })

  test('a wrong password is refused with a clear message, and the right one still works', async ({ app }) => {
    const cleo = await app.signUp('Cleo')
    const other = await app.visitor()
    await signIn(other.page, cleo.email, 'definitely not the password')
    await expect(other.page.getByRole('alert')).toHaveText('Wrong email or password')
    await signIn(other.page, 'nobody.at.all@example.test')
    await expect(other.page.getByRole('alert')).toHaveText('Wrong email or password')
    await signIn(other.page, cleo.email)
    await expect(editor(other.page)).toContainText('Welcome to Conflux')
  })

  test('an email that is already registered cannot be registered again', async ({ app }) => {
    const dev = await app.signUp('Dev')
    const other = await app.visitor()
    await other.page.getByRole('button', { name: 'Create an account' }).click()
    await other.page.getByLabel('Your name').fill('Impostor')
    await other.page.getByLabel('Email').fill(dev.email.toUpperCase())
    await other.page.getByLabel('Password').fill(PASSWORD)
    await other.page.getByRole('button', { name: 'Create account' }).click()
    await expect(other.page.getByRole('alert')).toContainText('already exists')
  })

  test('a short password is stopped by the form, and by the server if the form is skipped', async ({ app }) => {
    const other = await app.visitor()
    const sent: string[] = []
    other.page.on('request', (request) => {
      if (request.url().includes('/api/auth/signup')) sent.push(request.url())
    })

    await other.page.getByRole('button', { name: 'Create an account' }).click()
    await other.page.getByLabel('Your name').fill('Shorty')
    await other.page.getByLabel('Email').fill('shorty@example.test')
    await other.page.getByLabel('Password').fill('tiny')
    await other.page.getByRole('button', { name: 'Create account' }).click()
    await expect(other.page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
    expect(await other.page.getByLabel('Password').evaluate((input: HTMLInputElement) => input.validationMessage)).not.toBe('')
    expect(sent).toEqual([])

    const direct = await call(other.page, 'POST', '/api/auth/signup', { email: 'shorty@example.test', password: 'tiny', displayName: 'Shorty' })
    expect(direct.status).toBe(400)
    expect(direct.body.error.code).toBe('invalid_input')
  })

  test('opening a link while signed out asks you to sign in first, then takes you there', async ({ app }) => {
    const eve = await app.signUp('Eve')
    const address = eve.page.url()
    const other = await app.visitor()
    await other.page.goto(address)
    await expect(other.page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await signIn(other.page, eve.email)
    await expect(editor(other.page)).toContainText('Welcome to Conflux')
    expect(other.page.url()).toBe(address)
  })
})
