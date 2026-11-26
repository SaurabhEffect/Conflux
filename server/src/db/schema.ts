import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (value) => value,
  fromDriver: (value) => new Uint8Array(value),
})

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const workspaceRole = pgEnum('workspace_role', ['owner', 'editor', 'viewer'])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    cursorColor: text('cursor_color').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
)

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
})

export const memberships = pgTable(
  'memberships',
  {
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('memberships_user_idx').on(t.userId)],
)

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    usesLeft: integer('uses_left').notNull(),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [
    index('invites_workspace_idx').on(t.workspaceId),
    check('invites_role_not_owner', sql`${t.role} <> 'owner'`),
    check('invites_uses_left_nonnegative', sql`${t.usesLeft} >= 0`),
  ],
)

export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => pages.id, { onDelete: 'set null' }),
    title: text('title').notNull().default(''),
    position: integer('position').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [index('pages_workspace_idx').on(t.workspaceId, t.deletedAt)],
)

export const pageDocs = pgTable('page_docs', {
  pageId: uuid('page_id').primaryKey().references(() => pages.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
})

export const sandboxes = pgTable(
  'sandboxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketHash: text('ticket_hash').notNull().unique(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastActiveAt: timestamptz('last_active_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => [index('sandboxes_expires_idx').on(t.expiresAt), index('sandboxes_active_idx').on(t.lastActiveAt)],
)

export const sandboxParticipants = pgTable(
  'sandbox_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sandboxId: uuid('sandbox_id').notNull().references(() => sandboxes.id, { onDelete: 'cascade' }),
    /** SHA-256 of the visitor's cookie. */
    tokenHash: text('token_hash').notNull().unique(),
    displayName: text('display_name').notNull(),
    cursorColor: text('cursor_color').notNull(),
    isHost: boolean('is_host').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('sandbox_participants_sandbox_idx').on(t.sandboxId),
    uniqueIndex('sandbox_one_host_idx').on(t.sandboxId).where(sql`${t.isHost}`),
  ],
)

export const sandboxPages = pgTable(
  'sandbox_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sandboxId: uuid('sandbox_id').notNull().references(() => sandboxes.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [index('sandbox_pages_sandbox_idx').on(t.sandboxId)],
)

export const sandboxDocs = pgTable('sandbox_docs', {
  pageId: uuid('page_id').primaryKey().references(() => sandboxPages.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
})
