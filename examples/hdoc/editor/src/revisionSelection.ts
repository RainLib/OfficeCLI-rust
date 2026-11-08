/** Model-neutral contract for the shared revision review surface. Each entry
 * (semantic flow, regional word, fixed layout, workbook) folds its own
 * historical model into these rows before mounting the UI, so the components
 * never read a live editor model or a format-specific Projection. */
export type RevisionChangeRow={kind:'same'|'added'|'removed'|'modified';moved:boolean;formatChanged:boolean;objectChanged:boolean;oldIndex?:number;newIndex?:number;beforeText:string;afterText:string}
export type RevisionSelection={target:number;comparedWith:number;author?:string;createdAt?:number;changes:RevisionChangeRow[]}
export const revisionChangedRows=(selection:RevisionSelection):RevisionChangeRow[]=>selection.changes.filter(row=>row.kind!=='same'||row.moved)
