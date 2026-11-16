export type TextRun = { nodeId: string; nodeHash: string; text: string }

/** Keep source runs and their formatting. Count scalar values, as text.splice
 * does, and place inserted text in the run adjoining the unchanged prefix. */
export function editTextRuns(runs: TextRun[], value: string) {
  const before = [...runs.map(run => run.text).join('')], after = [...value]
  let prefix = 0, suffix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  const end = before.length - suffix, inserted = after.slice(prefix, after.length - suffix).join('')
  let offset = 0, placed = false
  return runs.map(run => {
    const characters = [...run.text], next = offset + characters.length
    let text = characters.slice(0, Math.max(0, Math.min(characters.length, prefix - offset))).join('')
    if (!placed && prefix <= next) { text += inserted; placed = true }
    text += characters.slice(Math.max(0, Math.min(characters.length, end - offset))).join('')
    offset = next
    return { ...run, text }
  })
}

export function textRunOperations(runs: TextRun[], value: string) {
  return editTextRuns(runs, value).flatMap((run, index) => run.text === runs[index].text ? [] : [{
    op: 'text.splice', nodeId: run.nodeId, start: 0,
    deleteCount: [...runs[index].text].length, insertText: run.text,
    precondition: { nodeHash: run.nodeHash },
  }])
}
