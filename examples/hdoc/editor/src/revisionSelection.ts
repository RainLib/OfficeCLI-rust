/** Model-neutral contract for the shared revision review surface. Each entry
 * (semantic flow, regional word, fixed layout, workbook) folds its own
 * historical model into these rows before mounting the UI, so the components
 * never read a live editor model or a format-specific Projection. */
export type RevisionChangeRow={kind:'same'|'added'|'removed'|'modified';moved:boolean;formatChanged:boolean;objectChanged:boolean;oldIndex?:number;newIndex?:number;beforeText:string;afterText:string}
export type RevisionSelection={target:number;comparedWith:number;author?:string;createdAt?:number;changes:RevisionChangeRow[]}
export const revisionRowChanged=(row:RevisionChangeRow):boolean=>row.kind!=='same'||row.moved
export const revisionChangedRows=(selection:RevisionSelection):RevisionChangeRow[]=>selection.changes.filter(revisionRowChanged)
/** Count without rebuilding the filtered array: dialogs only need the number. */
export const revisionChangedCount=(selection:RevisionSelection):number=>selection.changes.reduce((count,row)=>revisionRowChanged(row)?count+1:count,0)
