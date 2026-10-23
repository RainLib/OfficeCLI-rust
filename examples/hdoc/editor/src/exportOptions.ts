export type ExportOptions = { revision: number; sourceAvailable: boolean; sourceEditsSupported: boolean; reasonCode?: string | null }

export function readExportOptions(value: unknown, revision: number): ExportOptions {
  const options = value as Partial<ExportOptions> | null
  if (!options || options.revision !== revision || typeof options.sourceAvailable !== 'boolean' || typeof options.sourceEditsSupported !== 'boolean') {
    throw new Error('Invalid export options response')
  }
  return options as ExportOptions
}

export function docxSourceAllowed(options: ExportOptions): boolean {
  return options.sourceAvailable && options.sourceEditsSupported
}
