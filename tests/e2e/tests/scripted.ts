import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { expect } from '@playwright/test'

function socketFor(origin: string) {
  return class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers: { Origin: origin } })
      this.on('error', () => undefined)
    }
  }
}

export async function scriptedPerson(baseURL: string, inviteToken: string, docName: string) {
  const origin = new URL(baseURL).origin
  let cookie = ''
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(baseURL + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const set = response.headers.getSetCookie()[0]
    if (set) cookie = set.split(';')[0]
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  const email = `script.${Math.random().toString(16).slice(2)}@example.test`
  expect((await api('POST', '/api/auth/signup', { email, password: 'correct horse battery staple', displayName: 'Script' })).status).toBe(201)
  expect((await api('POST', '/api/invites/accept', { token: inviteToken })).status).toBe(200)

  const doc = new Y.Doc()
  const socket = new HocuspocusProviderWebsocket({ url: `${baseURL.replace(/^http/, 'ws')}/collab`, WebSocketPolyfill: socketFor(origin) as never })
  const provider = new HocuspocusProvider({
    name: docName,
    document: doc,
    websocketProvider: socket,
    token: async () => (await api('POST', '/api/sync-token', { doc: docName })).body.token,
  })
  provider.attach()
  await new Promise<void>((resolve) => provider.on('synced', () => resolve()))
  return {
    doc,
    provider,
    text: doc.getXmlFragment('content'),
    close() {
      provider.destroy()
      socket.destroy()
    },
  }
}
