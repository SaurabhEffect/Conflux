export const DEMO_BOT = { name: 'Conflux Bot', color: '#1f2937' } as const
export const DEMO_BOT_MENTION = '@bot'
export const DEMO_BOT_COMMANDS = ['help', 'count', 'todo', 'hello'] as const
export type DemoBotCommand = (typeof DEMO_BOT_COMMANDS)[number]
export const DEMO_BOT_REPLY_DELAY_MS = 1200
