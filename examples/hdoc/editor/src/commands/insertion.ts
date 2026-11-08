import type {BlockTarget} from './blocks.ts'
/** Internal UI target, never a schema/HTML payload. */
export type SlashTarget={from:number;to:number;text:string;anchor:string|null}
export type ContentTarget=SlashTarget|BlockTarget
export type InsertionStage={target:ContentTarget;stage:(commit:()=>boolean)=>void}
