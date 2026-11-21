/** Per-document, in-memory history. Reopening a document starts a fresh stack. */
export const EDIT_HISTORY_LIMIT = 20
export const keepHistory = <T,>(items: T[]): T[] => items.slice(-EDIT_HISTORY_LIMIT)

export type TableHistoryStep = {
  blockId: string; afterBlockId: string | null;
  beforeRevision: number; beforeHash: string | null;
  afterRevision: number; afterHash: string | null;
}
export type TableHistoryRequest = { historyDirection: 'undo' | 'redo' }
