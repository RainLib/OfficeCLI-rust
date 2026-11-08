(()=>{
 const ready=async()=>{
  const body=document.body,plan=JSON.parse(document.getElementById('hcd-word-export-plan').textContent);
  if(plan.schemaVersion!=='hcd-word-html/1')throw Error('Unsupported Word HTML plan');
  await Promise.all([document.fonts?.ready||Promise.resolve(),...Array.from(document.images,img=>img.complete?Promise.resolve():new Promise(resolve=>{img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true})}))]);
  const sourceNodes=Array.from(body.children).filter(node=>node.tagName==='SECTION'&&node.hasAttribute('data-hcd-chunk-id'));
  const catalog=new Set([...plan.layout.sections,...plan.layout.stories].map(region=>region.id)),sources=new Map();
  for(const node of sourceNodes){const id=node.dataset.hcdFlowRegion;if(id){if(!catalog.has(id))throw Error('Unknown Word HTML region');if(!sources.has(id))sources.set(id,[]);sources.get(id).push(node)}}
  const original=new Map(sourceNodes.map(node=>[node,Array.from(node.childNodes)]));
  const root=document.createElement('div');root.className='hcd-word-pages';
  const storage=document.createElement('div');storage.className='hcd-word-sources';storage.hidden=true;
  let total=0,logical=0;
  const identity=['id','data-hcd-id','data-hcd-node-hash','data-hcd-chunk-id','data-hcd-extension','data-hcd-reference','data-hcd-flow-region','data-hcd-word-field-start','data-hcd-word-field-end','data-hcd-word-field-definition','data-hcd-word-field-path','contenteditable','draggable'];
  const clean=(node)=>{if(node.nodeType!==1)return node;for(const el of [node,...node.querySelectorAll('*')])for(const key of identity)el.removeAttribute(key);return node};
  const story=(id)=>{const fragment=document.createDocumentFragment();for(const source of sources.get(id)||[]){const copy=clean(source.cloneNode(true));fragment.append(copy)}return fragment};
  const select=(cases,first,number)=>cases[first?(number%2===0?'firstEven':'firstOdd'):(number%2===0?'even':'odd')];
  const height=(ids,width)=>{let maximum=0;for(const id of new Set(ids.filter(Boolean))){const measure=document.createElement('div');measure.className='hcd-word-export-measure';measure.style.width=width+'px';measure.append(story(id));body.append(measure);maximum=Math.max(maximum,measure.scrollHeight,measure.getBoundingClientRect().height);measure.remove()}return maximum};
  try{
   body.classList.add('hcd-word-export');body.append(root);
   for(let sectionIndex=0;sectionIndex<plan.sections.length;sectionIndex++){
    const section=plan.sections[sectionIndex],width=Math.max(48,section.width-section.left-section.right);
    const headerHeight=height(Object.values(section.header),width),footerHeight=height(Object.values(section.footer),width);
    const top=Math.max(section.top,section.headerDistance+headerHeight),bottom=Math.max(section.bottom,section.footerDistance+footerHeight),paperHeight=Math.max(section.height,top+bottom+48),available=paperHeight-top-bottom;
    if(section.numberStart!==null)logical=section.numberStart-1;
    let page,index=0,count=0;
    const create=()=>{
     if(++total>20000)throw Error('Word HTML page limit');logical++;index++;count=0;
     const element=document.createElement('section');element.className='hcd-word-page';element.dataset.hcdWordSection=section.id;element.dataset.hcdWordPage=String(index);element.dataset.hcdWordLogicalPage=String(logical);element.style.width=section.width+'px';element.style.height=paperHeight+'px';
     if(paperHeight>section.height+.5)element.dataset.hcdWordOverflow='margins';
     const header=document.createElement('header'),footer=document.createElement('footer'),main=document.createElement('main');header.className='hcd-word-page-header';footer.className='hcd-word-page-footer';main.className='hcd-word-page-body';
     for(const marginal of [header,footer]){marginal.style.left=section.left+'px';marginal.style.right=section.right+'px'}header.style.top=section.headerDistance+'px';footer.style.bottom=section.footerDistance+'px';
     const headerId=select(section.header,index===1,logical),footerId=select(section.footer,index===1,logical);if(headerId){header.dataset.hcdWordStory=headerId;header.append(story(headerId))}if(footerId){footer.dataset.hcdWordStory=footerId;footer.append(story(footerId))}
     main.style.left=section.left+'px';main.style.top=top+'px';main.style.width=width+'px';main.style.height=available+'px';element.append(header,main,footer);root.append(element);page={element,main,oversized:false};
    };
    create();
    const add=(node,source)=>{
     if(node.nodeType===3&&!node.textContent.trim())return;
     if(page.oversized)create();
     const wrapper=clean(source.cloneNode(false));wrapper.removeAttribute('hidden');wrapper.append(node);page.main.append(wrapper);count++;
     if(page.main.scrollHeight>available+.5&&count>1){wrapper.remove();create();page.main.append(wrapper);count=1}
     if(page.main.scrollHeight>available+.5){const expanded=page.main.scrollHeight;page.main.style.height=expanded+'px';page.element.style.height=(top+expanded+bottom)+'px';page.element.dataset.hcdWordOverflow='block';page.oversized=true}
    };
    for(const source of sources.get(section.id)||[])for(const node of original.get(source))add(node,source);
    // Additional canonical notes remain readable instead of disappearing when
    // a format has immutable regions outside the main section/story catalog.
    if(sectionIndex===plan.sections.length-1)for(const source of sourceNodes.filter(node=>!node.dataset.hcdFlowRegion))for(const node of original.get(source))add(node,source);
   }
   for(const source of sourceNodes)storage.append(source);body.prepend(storage);body.dataset.hcdWordPageCount=String(total);body.classList.add('hcd-word-export-ready');
  }catch(error){
   for(const source of sourceNodes)for(const node of original.get(source)||[])source.append(node);
   for(const source of sourceNodes)body.insertBefore(source,root);
   root.remove();storage.remove();body.classList.remove('hcd-word-export','hcd-word-export-ready');body.dataset.hcdWordExportError='pagination-unavailable';
   const notice=document.createElement('p');notice.textContent='Browser pagination is unavailable; complete source regions remain below.';body.prepend(notice);
  }
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>void ready(),{once:true});else void ready();
})();
