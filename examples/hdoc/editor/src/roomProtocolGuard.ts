import {inlineContainerEditFields,inlineContainerEditIndex} from './inlineContainerEdits.ts'
import {extensionEditIndex} from './extensionEdits.ts'
import {inlineDeletionField} from './inlineDeletionReview.ts'
import {validateDeletionReceipts} from './deletionReview.ts'
import * as Y from 'yjs'
import {legacyProtocol,structuralProtocol,wordRegionalProtocol,wordLayoutProtocol,inlineProtocol,type CollaborationProtocol} from './collaborationProtocol.ts'
import {wordRegionStoreField} from './wordRegionStore.ts'
import {semanticBlockFields} from './semanticBlockStore.ts'
import {textFlowFields} from './semanticTextFlow.ts'
import {customMarkAttribute,readCustomMarks} from './customMarks.ts'
import {inlineContainerFields} from './semanticInlineContainers.ts'
/** Incremental shadow validation rejects a legacy payload BEFORE it reaches a
 * structural room. A full 8 MiB document is not copied on every keystroke. */
export class RoomProtocolGuard{
 private shadow:Y.Doc
 private closed=false
 constructor(private document:Y.Doc,private protocol:CollaborationProtocol,private validate?:(shadow:Y.Doc,changed?:ReadonlySet<Y.XmlText>)=>void){
  this.shadow=this.copy();try{this.check()}catch(error){this.shadow.destroy();throw error}
  document.on('update',this.mirror);document.on('destroy',this.destroy)
 }
 private copy(){const shadow=new Y.Doc({gc:false});Y.applyUpdate(shadow,Y.encodeStateAsUpdate(this.document));return shadow}
 private check(changed?:ReadonlySet<Y.XmlText>){
  // These carriers are an internal kernel, not part of wire7. Do not retain
  // invisible future bodies in a room whose reader/saver cannot preserve them.
  if(this.protocol===inlineProtocol){
   if(this.shadow.getMap(semanticBlockFields.metadata).get('inlineContainers')!==1||this.shadow.getMap('hcdSchema').get('inlineContainers')!==1)throw new Error('room-inline-container-model-required')
   inlineContainerEditIndex(this.shadow)
  }else{
   if(this.shadow.getMap(semanticBlockFields.metadata).get('inlineContainers')!==undefined||[...Object.values(inlineContainerFields),...Object.values(inlineContainerEditFields)].some(field=>this.shadow.getMap(field).size>0))throw new Error('room-inline-container-model-unsupported')
   if([...this.shadow.getMap(inlineDeletionField).values()].some(value=>!!value&&typeof value==='object'&&'version' in value&&value.version===2))throw new Error('room-inline-container-model-unsupported')
  }
  extensionEditIndex(this.shadow)
  validateDeletionReceipts(this.shadow)
  const structural=this.shadow.getMap(semanticBlockFields.metadata).get('version'),flow=this.shadow.getMap(textFlowFields.metadata).get('version')
  const older=['hcd-semantic-blocks/1/meta','hcd-semantic-blocks/2/meta'].some(name=>this.shadow.getMap(name).get('version')!==undefined)
  const regional=this.shadow.getMap(wordRegionStoreField).size>0
  const word=this.protocol===wordRegionalProtocol||this.protocol===wordLayoutProtocol
  if(older||(this.protocol===structuralProtocol||word||this.protocol===inlineProtocol)&&(structural!==3||flow!==1||this.shadow.getXmlFragment('default').length>0)||this.protocol===legacyProtocol&&(structural!==undefined||flow!==undefined)||regional!==word)throw new Error('room-body-protocol-mismatch')
  this.validate?.(this.shadow,changed)
 }
 private mirror=(update:Uint8Array)=>{if(!this.closed)Y.applyUpdate(this.shadow,update)}
 accept(update:Uint8Array){
  if(this.closed)throw new Error('room-protocol-guard-closed')
  const changed=new Set<Y.XmlText>(),observe=(transaction:Y.Transaction)=>{for(const type of transaction.changed.keys())if(type instanceof Y.XmlText)changed.add(type)}
  this.shadow.on('afterTransaction',observe)
  try{
   for(const struct of Y.decodeUpdate(update).structs)if(struct instanceof Y.Item&&struct.content instanceof Y.ContentFormat){const {key,value}=struct.content;if(key==='hcdCustomMark')throw new Error('unsupportedCustomMarkEncoding');if(key.startsWith('hcdCustomMark:')&&value!==null)customMarkAttribute(key,value)}
   Y.applyUpdate(this.shadow,update)
   for(const text of changed)for(const delta of text.toDelta()){if(this.protocol!==inlineProtocol&&delta.insert&&typeof delta.insert==='object'&&Object.hasOwn(delta.insert,'hcdInlineContainer'))throw new Error('room-inline-container-model-unsupported');const values=Object.entries(delta.attributes??{}).filter(([key])=>key.startsWith('hcdCustomMark:')).map(([key,value])=>customMarkAttribute(key,value).attrs.value);readCustomMarks(values);if(values.length&&(this.protocol!==structuralProtocol&&this.protocol!==wordRegionalProtocol&&this.protocol!==wordLayoutProtocol&&this.protocol!==inlineProtocol||typeof delta.insert!=='string'))throw new Error('unsupportedCustomMarkContent')}
   this.check(changed)
  }
  catch(error){this.shadow.destroy();this.shadow=this.copy();throw error}
  finally{this.shadow.off('afterTransaction',observe)}
 }
 destroy=()=>{if(this.closed)return;this.closed=true;this.document.off('update',this.mirror);this.document.off('destroy',this.destroy);this.shadow.destroy()}
}
