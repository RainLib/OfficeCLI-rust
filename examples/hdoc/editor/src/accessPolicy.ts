import { ApiError } from './api.ts'

export type AccessSnapshot = { scope?: string; access?: string }

/** Server policy wins over a previously issued write token. A revoked or
 * expired session stops writing and leaves local drafts untouched. */
export function accessDenied(error:unknown):boolean{return error instanceof ApiError&&(error.status===401||error.status===403)}

export function writeAllowed(access: AccessSnapshot | null, error?: unknown): boolean {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false
  return access?.scope === 'write' && access.access !== 'revoked'
}
