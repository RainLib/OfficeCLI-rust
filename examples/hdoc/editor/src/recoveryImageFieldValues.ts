import type {SharedImageDraft} from './collaborativeImages.ts'
import type {PositionedImage,ImageField} from './imageDrafts.ts'

/** Show the three inputs used by the saved-version comparison. */
export function recoveryImageFieldValues(draft:SharedImageDraft,saved:PositionedImage,field:ImageField){
 if(field==='assetHash')return {base:draft.base.assetHash??null,draft:draft.assetHash??draft.base.assetHash??null,saved:saved.assetHash??null}
 return {base:draft.base.geometry[field],draft:draft.geometry[field],saved:saved.geometry[field]}
}
