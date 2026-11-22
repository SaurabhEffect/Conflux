/** Size limits. The server enforces them; the web app uses them for form hints. */
export const LIMITS = {
  emailMax: 254,
  passwordMin: 10,
  passwordMax: 128,
  displayNameMax: 32,
  workspaceNameMax: 60,
  pageTitleMax: 120,
  maxOwnedWorkspaces: 10,
  maxPagesPerWorkspace: 500,
  maxMembersPerWorkspace: 25,
  maxActiveInvites: 20,
  inviteDefaultHours: 24 * 7,
  inviteMaxHours: 24 * 30,
  inviteDefaultUses: 10,
  inviteMaxUses: 50,
} as const
