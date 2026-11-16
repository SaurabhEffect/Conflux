/** page id -> starter content for a brand-new page that THIS tab just created. */
export const pendingSeeds = new Map<string, string>()

/** Pages this tab just created, so the title box can grab the cursor. */
export const justCreated = new Set<string>()
