export type ExportOptions = { revision: number; sourceAvailable: boolean; sourceEditsSupported: boolean; reasonCode?: string | null; semanticReasonCode?:string|null; semanticFormats?:string[];semanticWordFields?:string|null }
export type ScopedExportOptions = {value:ExportOptions;refreshKey:number}

/** Do not expose a prior preflight after the source changes at the same revision. */
export function currentExportOptions(options:ScopedExportOptions|null,revision:number|null,refreshKey:number):ExportOptions|null {
  return options?.refreshKey===refreshKey&&options.value.revision===revision?options.value:null
}

export function readExportOptions(value: unknown, revision: number): ExportOptions {
  const options = value as Partial<ExportOptions> | null
  if (!options || options.semanticWordFields!==undefined&&options.semanticWordFields!==null&&(typeof options.semanticWordFields!=='string'||!/^[-A-Za-z0-9]{1,64}$/.test(options.semanticWordFields))|| options.revision !== revision || typeof options.sourceAvailable !== 'boolean' || typeof options.sourceEditsSupported !== 'boolean'||options.semanticFormats!==undefined&&(!Array.isArray(options.semanticFormats)||options.semanticFormats.some(value=>typeof value!=='string'))) {
    throw new Error('Invalid export options response')
  }
  return options as ExportOptions
}

export function docxSourceAllowed(options: ExportOptions): boolean {
  return options.sourceAvailable && options.sourceEditsSupported
}

/** Only the exact, revision-scoped server declaration enables the new hint. */
export function wordNumericFieldsPreserved(options:ExportOptions|null):boolean{return options?.semanticWordFields==='numeric-v1'}
