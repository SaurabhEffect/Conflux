import { z } from 'zod'
import { UUID_RE } from './docNames'
import { LIMITS } from './limits'

const HIDDEN_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/u

function cleanText(max: number, label: string) {
  return z
    .string()
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(1, `${label} is required`)
        .max(max, `${label} can be at most ${max} characters`)
        .refine((value) => !HIDDEN_CHARACTERS.test(value), `${label} contains characters that are not allowed`),
    )
}

export const uuidSchema = z.string().regex(UUID_RE, 'Not a valid id')
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(LIMITS.emailMax, 'Email is too long'))
export const displayNameSchema = cleanText(LIMITS.displayNameMax, 'Name')
export const workspaceNameSchema = cleanText(LIMITS.workspaceNameMax, 'Workspace name')
export const pageTitleSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .max(LIMITS.pageTitleMax, `Title can be at most ${LIMITS.pageTitleMax} characters`)
      .refine((value) => !HIDDEN_CHARACTERS.test(value), 'Title contains characters that are not allowed'),
  )

export const passwordSchema = z
  .string()
  .min(LIMITS.passwordMin, `Password must be at least ${LIMITS.passwordMin} characters`)
  .max(LIMITS.passwordMax, `Password can be at most ${LIMITS.passwordMax} characters`)

const roleForInvite = z.enum(['editor', 'viewer'])
export const signupBody = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
})

export const loginBody = z.strictObject({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(LIMITS.passwordMax),
})

export const updateMeBody = z.strictObject({ displayName: displayNameSchema })
export const createWorkspaceBody = z.strictObject({ name: workspaceNameSchema })
export const updateWorkspaceBody = z.strictObject({ name: workspaceNameSchema })
export const updateMemberBody = z.strictObject({ role: z.enum(['owner', 'editor', 'viewer']) })
export const createInviteBody = z.strictObject({
  role: roleForInvite,
  expiresInHours: z.number().int().min(1).max(LIMITS.inviteMaxHours).default(LIMITS.inviteDefaultHours),
  maxUses: z.number().int().min(1).max(LIMITS.inviteMaxUses).default(LIMITS.inviteDefaultUses),
})

export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid invite link')
export const inviteTokenBody = z.strictObject({ token: inviteTokenSchema })
export const createPageBody = z.strictObject({ title: pageTitleSchema.default('') })
export const updatePageBody = z.strictObject({ title: pageTitleSchema })
export const syncTokenBody = z.strictObject({ doc: z.string().max(100) })
export type SignupBody = z.infer<typeof signupBody>
export type LoginBody = z.infer<typeof loginBody>
export type CreateInviteBody = z.input<typeof createInviteBody>
