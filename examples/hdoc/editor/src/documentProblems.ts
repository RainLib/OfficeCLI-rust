import {ApiError} from './api.ts'
import type {EditorLocale} from './i18n.tsx'

export const documentProblemCodes=['HCD-DOC-1000','HCD-DOC-1001','HCD-DOC-1003','HCD-DOC-1004','HCD-DOC-1009','HCD-DOC-1010','HCD-DOC-1026','HCD-DOC-2001','HCD-DOC-2002','HCD-DOC-2003','HCD-DOC-2004','HCD-DOC-3001','HCD-DOC-3002','HCD-DOC-4001','HCD-DOC-4002','HCD-DOC-4003','HCD-DOC-9000','HCD-DOC-9999'] as const
export type DocumentProblemCode=typeof documentProblemCodes[number]
export type DocumentProblemStage='open'|'content'|'collaboration'|'recovery'|'render'
export type DocumentProblem={code:DocumentProblemCode;stage:DocumentProblemStage;httpStatus?:number}
export class EditorDocumentError extends Error{
 constructor(readonly problem:DocumentProblem){super(problem.code);this.name='EditorDocumentError'}
 get code(){return this.problem.code}
}
export function documentProblem(code:DocumentProblemCode,stage:DocumentProblemStage='open',httpStatus?:number):DocumentProblem{return{code,stage,...(typeof httpStatus==='number'&&Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?{httpStatus}:{})}}
/** Never display/copy an arbitrary backend response, URL, stack or token. */
export function classifyDocumentProblem(cause:unknown,stage:DocumentProblemStage='open'):DocumentProblem{
 if(cause instanceof EditorDocumentError)return cause.problem
 if(stage==='render')return documentProblem('HCD-DOC-9000',stage)
 const status=cause instanceof ApiError?cause.status:cause instanceof Error?(cause as Error&{status?:number}).status:undefined
 const statuses:Record<number,DocumentProblemCode>={400:'HCD-DOC-1000',401:'HCD-DOC-1001',403:'HCD-DOC-1003',404:'HCD-DOC-1004',408:'HCD-DOC-2003',409:'HCD-DOC-1009',410:'HCD-DOC-1004',415:'HCD-DOC-3002',422:'HCD-DOC-3001',426:'HCD-DOC-1026',429:'HCD-DOC-2004',504:'HCD-DOC-2003'}
 if(status!==undefined&&statuses[status])return documentProblem(statuses[status],stage,status)
 if(status!==undefined&&status>=500)return documentProblem('HCD-DOC-2002',stage,status)
 const key=cause instanceof Error?(cause as Error&{key?:string}).key:undefined
 if(key==='localDraftUnavailable')return documentProblem('HCD-DOC-4001',stage)
 if(key==='localDraftProtocolUnavailable')return documentProblem('HCD-DOC-4002',stage)
 if(key==='localDraftAuthorityChanged')return documentProblem('HCD-DOC-1009',stage)
 if(stage==='recovery'&&cause instanceof Error&&['blank batch superseded','blank recovery requires review'].includes(cause.message))return documentProblem('HCD-DOC-1009',stage)
 if(key==='localDraftAccessDenied')return documentProblem('HCD-DOC-1003',stage)
 if(key==='protocolUnavailable'||key==='protocolPending'||key==='protocolWaiting')return documentProblem('HCD-DOC-2002',stage)
 if(key==='localDraftServerUnavailable'){const original=(cause as Error&{cause?:unknown}).cause;return original?classifyDocumentProblem(original,stage):documentProblem('HCD-DOC-2002',stage)}
 if(cause instanceof Error&&['unsupportedInlineContainerModel','unsupportedNodeContent','unsupportedInlineContent','unsupportedInlineMarks','unsupported-collaboration-session','room-body-protocol-mismatch'].includes(cause.message))return documentProblem('HCD-DOC-1026',stage)
 if(cause instanceof Error&&cause.name==='TimeoutError')return documentProblem('HCD-DOC-2003',stage)
 if(cause instanceof SyntaxError)return documentProblem('HCD-DOC-3001',stage)
 if(cause instanceof TypeError)return documentProblem('HCD-DOC-2001',stage)
 return documentProblem('HCD-DOC-9999',stage,status)
}
type Copy={title:string;description:string}
const cn:Record<DocumentProblemCode,Copy>={
 'HCD-DOC-1000':{title:'打开文档的信息不完整',description:'文档入口或打开参数不正确。请从原应用重新进入，或检查文档链接。'},
 'HCD-DOC-1001':{title:'需要重新验证访问身份',description:'访问凭证不可用或已失效。请从原应用重新打开文档，获取有效的访问凭证。'},
 'HCD-DOC-1003':{title:'暂时无法访问此文档',description:'当前账号没有所需权限，或访问权限已发生变化。请联系文档所有者确认权限后再试。'},
 'HCD-DOC-1004':{title:'未找到可访问的文档',description:'文档或对应内容可能已移动、删除，或链接已失效。请检查文档入口后再试。'},
 'HCD-DOC-1009':{title:'文档状态已更新',description:'文档版本或协作状态发生了变化。请重新检查最新状态；可用的本机草稿仍通过恢复流程处理。'},
 'HCD-DOC-1010':{title:'本机草稿已变化',description:'另一个窗口更新了这份草稿，或草稿已不可用。请重新检查比较内容后再恢复；原副本不会自动删除。'},
 'HCD-DOC-1026':{title:'需要兼容的编辑器版本',description:'当前编辑器无法处理此文档的部分内容或协作模型。请更新编辑器后重新打开，或联系应用管理员。'},
 'HCD-DOC-2001':{title:'暂时无法连接文档服务',description:'未能完成网络请求。请检查网络连接，或稍后重新尝试。'},
 'HCD-DOC-2002':{title:'文档服务暂时不可用',description:'服务未能完成本次请求。请稍后重试；持续出现时可提供错误信息以便排查。'},
 'HCD-DOC-2003':{title:'打开文档超时',description:'请求未在预期时间内完成。请检查网络连接后重试，或稍后重新打开文档。'},
 'HCD-DOC-2004':{title:'请求过于频繁',description:'服务暂时限制了请求频率。请稍等片刻后再试，避免连续重复打开。'},
 'HCD-DOC-3001':{title:'暂时无法解析文档内容',description:'返回的文档信息不完整或不符合预期。请先重试；仍无法打开时，请联系文档所有者或应用管理员。'},
 'HCD-DOC-3002':{title:'暂不支持此文档格式',description:'此编辑器暂时无法打开这种格式。请使用兼容的应用，或将文档转换为支持的格式后再试。'},
 'HCD-DOC-4001':{title:'本机草稿存储不可用',description:'浏览器未能读取或写入本机草稿。请检查存储空间和浏览器设置后重试；可用的备份仍可单独处理。'},
 'HCD-DOC-4002':{title:'本机草稿需要兼容版本',description:'草稿采用的内容或协作模型与当前编辑器不匹配。请使用兼容版本恢复，不要清除浏览器数据。'},
 'HCD-DOC-4003':{title:'无法确认本机草稿的归属',description:'当前访问身份缺少稳定的人员标识。请从原应用重新进入；若选择继续，将无法使用本机自动备份。'},
 'HCD-DOC-9000':{title:'文档暂时无法显示',description:'编辑器遇到了显示异常。可以重新尝试打开；重新进入时会检查可用的本机草稿。'},
 'HCD-DOC-9999':{title:'文档暂时无法打开',description:'本次打开未能完成。请重试；如果问题持续，可复制错误信息交给应用管理员排查。'},
}
const en:Record<DocumentProblemCode,Copy>={
 'HCD-DOC-1000':{title:'Document link needs attention',description:'The document entry or opening parameters are incomplete. Reopen it from the original app or check the link.'},
 'HCD-DOC-1001':{title:'Verify your access again',description:'The access credential is unavailable or no longer valid. Reopen the document from the original app to obtain valid access.'},
 'HCD-DOC-1003':{title:'This document cannot be accessed',description:'Your account does not have the required access, or its permissions have changed. Ask the document owner to check your access.'},
 'HCD-DOC-1004':{title:'No accessible document was found',description:'The document or requested content may have moved, been deleted, or have an outdated link. Check the original entry and try again.'},
 'HCD-DOC-1009':{title:'The document state has changed',description:'The document version or collaboration state has changed. Check the latest state; available device drafts still use the recovery flow.'},
 'HCD-DOC-1010':{title:'The device draft has changed',description:'Another window updated this draft, or the draft is no longer available. Review the comparison again before restoring; the original copy is not automatically deleted.'},
 'HCD-DOC-1026':{title:'A compatible editor is needed',description:'This editor cannot process part of the document or its collaboration model. Update the editor and reopen it, or contact your app administrator.'},
 'HCD-DOC-2001':{title:'Cannot connect to the document service',description:'The network request could not be completed. Check your connection or try again later.'},
 'HCD-DOC-2002':{title:'The document service is unavailable',description:'The service could not complete this request. Try again later; share the error information if the problem continues.'},
 'HCD-DOC-2003':{title:'Opening the document timed out',description:'The request did not finish in time. Check your connection and retry, or reopen the document later.'},
 'HCD-DOC-2004':{title:'Too many requests',description:'The service is temporarily limiting requests. Wait a moment before trying again.'},
 'HCD-DOC-3001':{title:'Document content could not be read',description:'The returned document information is incomplete or unexpected. Retry first; if it persists, contact the document owner or app administrator.'},
 'HCD-DOC-3002':{title:'This document format is not supported',description:'This editor cannot open this format. Use a compatible app or convert the document to a supported format.'},
 'HCD-DOC-4001':{title:'Device draft storage is unavailable',description:'The browser could not read or write device drafts. Check available storage and browser settings, then retry; available backups can be handled separately.'},
 'HCD-DOC-4002':{title:'The device draft needs a compatible editor',description:'The draft content or collaboration model does not match this editor. Recover it with a compatible version; do not clear browser data.'},
 'HCD-DOC-4003':{title:'Device draft identity is unavailable',description:'Your access identity has no stable user identifier. Reopen from the original app; continuing without device backup disables automatic local recovery.'},
 'HCD-DOC-9000':{title:'The document could not be displayed',description:'The editor encountered a display problem. Try opening it again; available device drafts are checked when you re-enter.'},
 'HCD-DOC-9999':{title:'The document could not be opened',description:'Opening did not complete. Retry; if it continues, copy the error information for your app administrator.'},
}
const tw:Record<DocumentProblemCode,Copy>={
 'HCD-DOC-1000':{title:'開啟文件的資訊不完整',description:'文件入口或開啟參數不正確。請從原應用程式重新進入，或檢查文件連結。'},
 'HCD-DOC-1001':{title:'需要重新驗證存取身分',description:'存取憑證無法使用或已失效。請從原應用程式重新開啟文件，取得有效憑證。'},
 'HCD-DOC-1003':{title:'暫時無法存取此文件',description:'目前帳號沒有所需權限，或存取權限已變更。請聯絡文件擁有者確認權限後再試。'},
 'HCD-DOC-1004':{title:'找不到可存取的文件',description:'文件或對應內容可能已移動、刪除，或連結已失效。請檢查文件入口後再試。'},
 'HCD-DOC-1009':{title:'文件狀態已更新',description:'文件版本或協作狀態已變更。請重新檢查最新狀態；可用的本機草稿仍透過復原流程處理。'},
 'HCD-DOC-1010':{title:'本機草稿已變更',description:'另一個視窗更新了這份草稿，或草稿已無法使用。請重新檢查比較內容後再復原；原副本不會自動刪除。'},
 'HCD-DOC-1026':{title:'需要相容的編輯器版本',description:'目前編輯器無法處理此文件的部分內容或協作模型。請更新編輯器後重新開啟，或聯絡應用程式管理員。'},
 'HCD-DOC-2001':{title:'暫時無法連線至文件服務',description:'無法完成網路請求。請檢查網路連線，或稍後再試。'},
 'HCD-DOC-2002':{title:'文件服務暫時無法使用',description:'服務未能完成本次請求。請稍後重試；若問題持續，可提供錯誤資訊以便排查。'},
 'HCD-DOC-2003':{title:'開啟文件逾時',description:'請求未在預期時間內完成。請檢查網路連線後重試，或稍後重新開啟文件。'},
 'HCD-DOC-2004':{title:'請求過於頻繁',description:'服務暫時限制了請求頻率。請稍候再試，避免連續重複開啟。'},
 'HCD-DOC-3001':{title:'暫時無法解析文件內容',description:'回傳的文件資訊不完整或不符預期。請先重試；若仍無法開啟，請聯絡文件擁有者或應用程式管理員。'},
 'HCD-DOC-3002':{title:'暫不支援此文件格式',description:'此編輯器暫時無法開啟這種格式。請使用相容的應用程式，或轉換為支援的格式後再試。'},
 'HCD-DOC-4001':{title:'本機草稿儲存無法使用',description:'瀏覽器未能讀取或寫入本機草稿。請檢查儲存空間和瀏覽器設定後重試；可用的備份仍可另行處理。'},
 'HCD-DOC-4002':{title:'本機草稿需要相容版本',description:'草稿採用的內容或協作模型與目前編輯器不符。請使用相容版本復原，不要清除瀏覽器資料。'},
 'HCD-DOC-4003':{title:'無法確認本機草稿的歸屬',description:'目前存取身分缺少穩定的人員識別。請從原應用程式重新進入；若選擇繼續，將無法使用本機自動備份。'},
 'HCD-DOC-9000':{title:'文件暫時無法顯示',description:'編輯器遇到顯示異常。可以重新嘗試開啟；重新進入時會檢查可用的本機草稿。'},
 'HCD-DOC-9999':{title:'文件暫時無法開啟',description:'本次開啟未能完成。請重試；若問題持續，可複製錯誤資訊交給應用程式管理員排查。'},
}
const ui={
 cn:{document:'文档',opening:'正在打开文档',openingHint:'正在检查访问权限并读取文档内容…',retry:'重新尝试',close:'返回原应用',copy:'复制错误信息',copied:'已复制',copyFailed:'复制失败，请手动选择错误码。',details:'问题详情',code:'错误码',stage:'发生阶段',http:'服务响应',stages:{open:'打开文档',content:'读取内容',collaboration:'协作连接',recovery:'本机草稿恢复',render:'显示文档'}},
 en:{document:'Document',opening:'Opening document',openingHint:'Checking access and reading document content…',retry:'Try again',close:'Return to app',copy:'Copy error information',copied:'Copied',copyFailed:'Copy failed. Select the error code manually.',details:'Problem details',code:'Error code',stage:'Stage',http:'Service response',stages:{open:'Open document',content:'Read content',collaboration:'Collaboration',recovery:'Device draft recovery',render:'Display document'}},
 tw:{document:'文件',opening:'正在開啟文件',openingHint:'正在檢查存取權限並讀取文件內容…',retry:'重新嘗試',close:'返回原應用程式',copy:'複製錯誤資訊',copied:'已複製',copyFailed:'複製失敗，請手動選取錯誤碼。',details:'問題詳情',code:'錯誤碼',stage:'發生階段',http:'服務回應',stages:{open:'開啟文件',content:'讀取內容',collaboration:'協作連線',recovery:'本機草稿復原',render:'顯示文件'}},
}
export function documentProblemCopy(problem:DocumentProblem,locale:EditorLocale){const language=locale==='zh-CN'?'cn':locale.startsWith('zh-')?'tw':'en';return{...ui[language],...(language==='cn'?cn:language==='tw'?tw:en)[problem.code]}}
export function documentProblemDiagnostic(problem:DocumentProblem,locale:EditorLocale){const copy=documentProblemCopy(problem,locale);return[`${copy.code}: ${problem.code}`,copy.title,`${copy.stage}: ${copy.stages[problem.stage]}`,...(problem.httpStatus?[`HTTP: ${problem.httpStatus}`]:[])].join('\n')}
