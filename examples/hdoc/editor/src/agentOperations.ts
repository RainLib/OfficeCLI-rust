export type OperationTarget = {
  nodeId?: string | null; blockId?: string | null; chunkSequence?: number | null
  sheetId?: string | null; row?: number | null; column?: number | null; label?: string | null
}
export type AgentOperation = {
  operationId: string; agentId: string; name: string; status: string; revision: number
  collaborationEpoch: number; updatedAtEpochMs: number; totalTargets: number; targets: OperationTarget[]
}
export type OperationPhase = 'pending' | 'active' | 'done' | 'stopped'
export type OperationView = AgentOperation & { replaying: boolean; replayIndex: number; phases: OperationPhase[] }

/** Replay uses an observed commit, never a guessed model plan. Timing is visual
 * only: all targets in an applied batch have already committed atomically. */
export function operationView(operation: AgentOperation, now: number, observedAt: number, reducedMotion: boolean): OperationView {
  const length = operation.targets.length
  const stepMs = Math.max(220, Math.min(650, 9000 / Math.max(1, length)))
  const replayIndex = reducedMotion ? length : Math.max(0, Math.floor((now - observedAt) / stepMs))
  const replaying = operation.status === 'applied' && replayIndex < length
  const phases = operation.targets.map((_, index): OperationPhase => {
    if (operation.status === 'pending') return 'pending'
    if (operation.status === 'editing') return 'active'
    if (operation.status !== 'applied') return 'stopped'
    if (!replaying || index < replayIndex) return 'done'
    return index === replayIndex ? 'active' : 'pending'
  })
  return { ...operation, replaying, replayIndex, phases }
}
