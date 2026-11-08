import type {CommandLabel} from './commands/types.js'
export type CustomMarkStyle={bold?:true;italic?:true;underline?:true;strike?:true;textColor?:string;backgroundColor?:string}
/** Immutable text-format value. Text, positions and source IDs stay in the document. */
export type CustomMarkPayload={schemaVersion:'hcd.mark/1';type:string;version:number;data:Record<string,unknown>;fallback:{label:string;style:CustomMarkStyle}}
export type CustomMarkDefinition={type:string;version:number;label:CommandLabel;icon?:string;defaultData:Record<string,unknown>;validate:(data:Readonly<Record<string,unknown>>)=>boolean;fallback:(data:Readonly<Record<string,unknown>>)=>CustomMarkPayload['fallback']}
