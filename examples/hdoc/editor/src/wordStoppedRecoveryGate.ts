/** Existing signed requests must remain recoverable when another local queue
 * also has an unknown attempt. Only fresh content/structure changes are gated. */
export function canPrepareStoppedAction(kind:'save'|'layout'|'story'|'resume'|'cancel'|'rebase-stale'|'legacy',otherPending:boolean,otherSaving=false){return kind!=='legacy'&&(kind==='resume'||kind==='cancel'||!otherPending&&!otherSaving)}
