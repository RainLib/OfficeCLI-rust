import {typography,type TextTypography} from './typography.ts'
/** Canonical source metadata is separate from an extension's business data. */
export const sourceDefaultNames=['hcdSourceId','hcdSourceTypography','hcdSourceSizeExplicit'] as const
export type SemanticSourceDefaults={hcdSourceId:string|null;hcdSourceTypography:TextTypography|null;hcdSourceSizeExplicit:boolean}
export const emptySourceDefaults:SemanticSourceDefaults=Object.freeze({hcdSourceId:null,hcdSourceTypography:null,hcdSourceSizeExplicit:false})
export function semanticSourceDefaults(attrs:Record<string,unknown>):SemanticSourceDefaults{
 const id=attrs.hcdSourceId??null,font=typography(attrs.hcdSourceTypography),explicit=attrs.hcdSourceSizeExplicit??false
 if(id!==null&&(typeof id!=='string'||!/^n_[a-f0-9]{32}$/.test(id))||typeof explicit!=='boolean'||explicit&&(!font?.sizePt||font.sizePt<1||font.sizePt>1638||(font.sizePt*2)%1!==0))throw new Error('invalidInlineSourceDefaults')
 return{hcdSourceId:id as string|null,hcdSourceTypography:font,hcdSourceSizeExplicit:explicit}
}
