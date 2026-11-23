/** page id -> starter content for a page that THIS tab just created (the welcome page at sign-up). */
export const pendingSeeds = new Map<string, string>()

/** Pages this tab just created, so the title box can grab the cursor. */
export const justCreated = new Set<string>()
