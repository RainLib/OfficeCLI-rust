import type {PropertyEditGroup,PropertyPayload} from './nodePropertyEdits.ts'
import {useI18n} from './i18n.tsx'
export function NodeConflictPanel<P extends PropertyPayload>({groups,onSelect,onClose}:{groups:PropertyEditGroup<P>[];onSelect:(id:string)=>void;onClose:()=>void}){
 const {t}=useI18n()
 return <section className="word-selection-properties"><div className="panel-head"><h2>{t('nodeConflicts')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={onClose}>×</button></div>{groups.length>0&&<p>{t('nodeConflictHint')}</p>}{groups.length?groups.map(group=><div className="inspector-property-group" key={group.root.instanceId}><p>{group.value.fallback.text}</p><p>{t(Object.keys(group.conflicts).length?'nodeConflictCount':'nodeMaterializationPending',{count:Object.keys(group.conflicts).length})}</p><button type="button" onClick={()=>onSelect(group.root.instanceId)}>{t('nodeReviewProperties')}</button></div>):<p role="status">{t('nodeNoConflicts')}</p>}</section>
}
