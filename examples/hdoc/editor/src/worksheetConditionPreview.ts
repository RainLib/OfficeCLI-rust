import {
  AddConditionalRuleMutation, CFNumberOperator, CFRuleType, CFSubRuleType,
  DeleteConditionalRuleMutation, type IConditionFormattingRule, type INumberHighlightCell,
} from '@univerjs/presets/preset-sheets-conditional-formatting'
import type { HcdUniverAdapter } from '../../xlsx-univer-viewer/src/adapter.ts'
import type { WorksheetCondition } from '../../xlsx-univer-viewer/src/hcd.ts'

const applied = new WeakMap<HcdUniverAdapter, Map<string, string>>()

function visualRule({ id, config }: WorksheetCondition): IConditionFormattingRule {
  const { range, fill, color, values } = config
  const style = { ...(fill && { bg: { rgb: fill } }), ...(color && { cl: { rgb: color } }) }
  const operation = CFNumberOperator[config.operator]
  const highlight = { type: CFRuleType.highlightCell as const, subType: CFSubRuleType.number as const, style }
  const rule: INumberHighlightCell = operation === CFNumberOperator.between || operation === CFNumberOperator.notBetween
    ? { ...highlight, operator: operation, value: [Number(values[0]), Number(values[1])] }
    : { ...highlight, operator: operation, value: Number(values[0]) }
  return {
    cfId: id,
    ranges: [{ startRow: range.startRow - 1, endRow: range.endRow - 1,
      startColumn: range.startColumn - 1, endColumn: range.endColumn - 1 }],
    stopIfTrue: config.stopIfTrue ?? false,
    rule,
  }
}

export function syncWorksheetConditions(adapter: HcdUniverAdapter, sheetId: string, rules: WorksheetCondition[]) {
  const sheet = adapter.workbook.getSheetBySheetId(sheetId)
  if (!sheet) return
  let snapshots = applied.get(adapter)
  if (!snapshots) { snapshots = new Map(); applied.set(adapter, snapshots) }
  const signature = JSON.stringify(rules)
  if (snapshots.get(sheetId) === signature) return
  const scope = { unitId: adapter.workbook.getId(), subUnitId: sheetId }
  adapter.updatePresentation(() => {
    for (const rule of sheet.getConditionalFormattingRules()) {
      adapter.univerAPI.syncExecuteCommand(DeleteConditionalRuleMutation.id, { ...scope, cfId: rule.cfId })
    }
    // Univer inserts the newest rule first; apply the native order in reverse.
    for (const rule of [...rules].reverse()) {
      adapter.univerAPI.syncExecuteCommand(AddConditionalRuleMutation.id, { ...scope, rule: visualRule(rule) })
    }
  })
  snapshots.set(sheetId, signature)
}
