export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message)
  }
}

export const unauthorized = () => new HttpError(401, 'unauthorized', 'Please sign in')
export const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that')
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message)
export const conflict = (code: string, message: string) => new HttpError(409, code, message)
export const tooManyRequests = (retryAfterSeconds: number, message = 'Too many attempts. Please wait a bit and try again.') =>
  new HttpError(429, 'rate_limited', message, { 'Retry-After': String(retryAfterSeconds) })
export const busy = () => new HttpError(503, 'busy', 'The server is busy. Try again in a moment.', { 'Retry-After': '2' })
