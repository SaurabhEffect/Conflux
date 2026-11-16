const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
export const COLLAB_URL: string =
  import.meta.env.VITE_COLLAB_URL ?? `${protocol}://${window.location.hostname}:1234`
