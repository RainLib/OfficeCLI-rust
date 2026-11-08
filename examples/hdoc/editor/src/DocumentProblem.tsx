import {Component,useId,useState,type ErrorInfo,type ReactNode} from 'react'
import {LocaleSelect,useI18n} from './i18n.tsx'
import {classifyDocumentProblem,documentProblemCopy,documentProblemDiagnostic,EditorDocumentError,type DocumentProblem} from './documentProblems.ts'

function DocumentSymbol({loading=false}:{loading?:boolean}){return <div className={`hcd-problem-symbol ${loading?'loading':''}`} aria-hidden="true"><svg viewBox="0 0 64 72" fill="none"><path d="M12 3h27l13 13v49a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z" fill="white" stroke="currentColor" strokeWidth="2"/><path d="M38 3v14h14M18 28h23M18 36h17M18 44h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="48" cy="53" r="13" fill="#edf3ff" stroke="currentColor" strokeWidth="2"/><path d="M48 46v8m0 5h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg></div>}
function ProblemHeader({documentId,onClose}:{documentId?:string;onClose?:()=>void}){const{locale}=useI18n(),copy=documentProblemCopy({code:'HCD-DOC-9999',stage:'open'},locale);return <header className="hcd-problem-header"><div className="hcd-problem-document"><span aria-hidden="true">D</span><strong>{documentId?.slice(0,128)||copy.document}</strong></div><div><LocaleSelect/>{onClose&&<button type="button" aria-label={copy.close} title={copy.close} onClick={onClose}>×</button>}</div></header>}
export function DocumentLoading({documentId,onClose}:{documentId?:string;onClose?:()=>void}){const{locale}=useI18n(),copy=documentProblemCopy({code:'HCD-DOC-9999',stage:'open'},locale);return <section className="hcd-document-problem" aria-busy="true"><ProblemHeader documentId={documentId} onClose={onClose}/><div className="hcd-problem-center"><div className="hcd-problem-loading" role="status"><DocumentSymbol loading/><h1>{copy.opening}</h1><p>{copy.openingHint}</p></div></div></section>}

export function DocumentProblemView({problem,documentId,onRetry,onClose,secondary,children,compact=false,busy=false}:{problem:DocumentProblem;documentId?:string;onRetry?:()=>void;onClose?:()=>void;secondary?:{label:string;run:()=>void};children?:ReactNode;compact?:boolean;busy?:boolean}){
 const{locale}=useI18n(),copy=documentProblemCopy(problem,locale),titleId=useId(),[copyState,setCopyState]=useState<{diagnostic:string;status:'done'|'failed'}|null>(null)
 const diagnostic=documentProblemDiagnostic(problem,locale)
 const copied=copyState?.diagnostic===diagnostic?copyState.status:'idle'
 const copyError=async()=>{try{await navigator.clipboard.writeText(diagnostic);setCopyState({diagnostic,status:'done'})}catch{setCopyState({diagnostic,status:'failed'})}}
 const card=<section className="hcd-problem-card" aria-labelledby={titleId}>
  <div className="hcd-problem-main"><DocumentSymbol/><div><span className="hcd-problem-code">{problem.code}</span>{compact?<h2 id={titleId}>{copy.title}</h2>:<h1 id={titleId}>{copy.title}</h1>}<p>{copy.description}</p>
   {children&&<div className="hcd-problem-extra">{children}</div>}<div className="hcd-problem-actions">{onRetry&&<button type="button" className="primary" disabled={busy} onClick={onRetry}>{copy.retry}</button>}{onClose&&<button type="button" disabled={busy} onClick={onClose}>{copy.close}</button>}{secondary&&<button type="button" disabled={busy} onClick={secondary.run}>{secondary.label}</button>}</div>
  </div></div>
  <details className="hcd-problem-details"><summary>{copy.details}</summary><dl><dt>{copy.code}</dt><dd>{problem.code}</dd><dt>{copy.stage}</dt><dd>{copy.stages[problem.stage]}</dd>{problem.httpStatus&&<><dt>{copy.http}</dt><dd>HTTP {problem.httpStatus}</dd></>}</dl><div className="hcd-problem-diagnostic"><button type="button" onClick={()=>void copyError()}>{copied==='done'?copy.copied:copy.copy}</button><span role="status">{copied==='failed'?copy.copyFailed:copied==='done'?copy.copied:''}</span></div></details>
 </section>
 return compact?<div className="hcd-document-problem compact" role="alert">{card}</div>:<section className="hcd-document-problem"><ProblemHeader documentId={documentId} onClose={onClose}/><div className="hcd-problem-center" role="alert">{card}</div></section>
}

type BoundaryProps={children:ReactNode;documentId?:string;onClose?:()=>void;onError?:(error:Error)=>void}
/** Rendering failures use a fallback without clearing disk drafts or issuing
 * an automatic reload. Retry remounts through the ordinary recovery path. */
export class DocumentErrorBoundary extends Component<BoundaryProps,{problem:DocumentProblem|null;generation:number}>{
 state:{problem:DocumentProblem|null;generation:number}={problem:null,generation:0}
 static getDerivedStateFromError(error:unknown){return{problem:classifyDocumentProblem(error,'render')}}
 componentDidCatch(_error:Error,_info:ErrorInfo){if(this.state.problem)try{this.props.onError?.(new EditorDocumentError(this.state.problem))}catch{/* Host reporting cannot replace the recovery screen. */}}
 render(){return this.state.problem?<DocumentProblemView problem={this.state.problem} documentId={this.props.documentId} onClose={this.props.onClose} onRetry={()=>this.setState(state=>({problem:null,generation:state.generation+1}))}/>:<div className="hcd-document-boundary" key={this.state.generation}>{this.props.children}</div>}
}
