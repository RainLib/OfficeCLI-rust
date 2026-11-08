import {useI18n} from './i18n.tsx'
import type {InlineReference} from './inlineReference.ts'
import type {ReferenceResolution} from './referenceIndex.ts'
/** Saved content and the directory's current profile are deliberately separate.
 * Resolving a name never writes a label back into the document. */
export function ReferenceProfile({reference,resolution,status}:{reference:InlineReference;resolution?:ReferenceResolution;status:'loading'|'ready'|'unavailable'}){
 const {t}=useI18n()
 const state=status==='unavailable'?'referenceOffline':status==='loading'?'referenceResolving':resolution?.status==='active'?'referenceActive':resolution?.status==='inactive'?'referenceInactive':resolution?.status==='unsupported'?'referenceUnsupported':'referenceRestricted'
 return <div className="hcd-reference-profile"><strong>{`@${reference.snapshot.label}`}</strong><small>{t('referenceSavedName')}</small><p className={`hcd-reference-state ${resolution?.status??status}`} role="status">{t(state)}</p>{status==='ready'&&resolution?.status==='active'&&<>{resolution.label!==reference.snapshot.label&&<p>{t('referenceCurrentName',{name:resolution.label!})}</p>}{resolution.detail&&<p>{resolution.detail}</p>}{!resolution.canMention&&<small>{t('referenceCannotMention')}</small>}</>}</div>
}
