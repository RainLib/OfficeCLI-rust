import {readExtensionNode} from './extensionNode.ts'
import {validateNodeExports} from './extensionPortable.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
export const inlineContainerNodeName='hcdExtensionInlineContainer'
export type InlineContainerPayload=Omit<ExtensionNodePayload,'schemaVersion'|'display'|'contentModel'>&{schemaVersion:'hcd.extension/3';display:'inline';contentModel:'inline'}
/** Reuse the existing bounded envelope/data/resource parser without widening
 * its public accepted models. Inline export constraints are checked again:
 * adapting the structural model must not inherit block-only export freedom. */
export function readInlineContainerPayload(input:unknown):InlineContainerPayload{
 const value=input as InlineContainerPayload
 if(!value||value.schemaVersion!=='hcd.extension/3'||value.display!=='inline'||value.contentModel!=='inline'||typeof value.fallback?.text!=='string'||/[\r\n\t]/u.test(value.fallback.text)||new TextEncoder().encode(JSON.stringify(value)).length>65536)throw new Error('unsupportedInlineContainer')
 const parsed=readExtensionNode({...value,schemaVersion:'hcd.extension/2',display:'block',contentModel:'blocks'})
 if(parsed.exports)validateNodeExports(parsed.exports,parsed.resources??[],true,true)
 return{...parsed,schemaVersion:'hcd.extension/3',display:'inline',contentModel:'inline'}
}
