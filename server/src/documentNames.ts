/**
 * Every document the app talks about has one of two names:
 *
 *   "workspace"      the shared list of pages (titles, order)
 *   "page:<id>"      the text of one page
 *
 * The server refuses to open anything else, so a stranger can't fill your
 * database with random documents just by connecting and making up names.
 */
const VALID_NAME = /^(workspace|page:[a-z0-9]{8,40})$/
export function isValidDocumentName(name: string): boolean {
  return VALID_NAME.test(name)
}
