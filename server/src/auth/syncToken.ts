import { SignJWT, jwtVerify } from 'jose'
const ISSUER = 'conflux'
const AUDIENCE = 'conflux-sync'
export type SyncClaims = { userId: string; sessionId: string; doc: string }
export async function signSyncToken(secret: Uint8Array, claims: SyncClaims, ttlSeconds: number) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
  const token = await new SignJWT({ sid: claims.sessionId, doc: claims.doc })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret)
  return { token, expiresAt }
}

export async function verifySyncToken(secret: Uint8Array, token: string): Promise<SyncClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'], requiredClaims: ['exp', 'iat', 'sub'] })
  const { sub, sid, doc } = payload
  if (typeof sub !== 'string' || typeof sid !== 'string' || typeof doc !== 'string') throw new Error('malformed sync token')
  return { userId: sub, sessionId: sid, doc }
}
