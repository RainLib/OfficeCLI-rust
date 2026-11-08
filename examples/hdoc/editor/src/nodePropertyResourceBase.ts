import {stableExtension} from './extensionRegistry.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'

/** Updating attachments cannot invalidate an unrelated local property form.
 * Schema/data/fallback changes still require an explicit comparison/reload. */
export function resourceOnlyPropertyBase<P extends ResourceNodePayload>(base:P,current:P):P|null{
 if(stableExtension(base)===stableExtension(current))return null
 if(stableExtension({...base,resources:[]})!==stableExtension({...current,resources:[]}))return null
 return current
}
