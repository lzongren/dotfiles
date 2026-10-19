const KEY='devbox-return-prototype-v5';
export function loadLocal(){try{const x=JSON.parse(localStorage.getItem(KEY));if(!x?.model?.groups?.retry||!x?.flow)return null;if(x.flow.choice==='ask'){x.flow={...x.flow,choice:'fix',inquiryDraft:x.flow.draft,inquiryOpen:true,draft:'',status:'idle'};}if(['sending','awaiting'].includes(x.flow.status))x.flow={...x.flow,status:'failed'};return x;}catch{return null;}}
export function saveLocal(value){try{localStorage.setItem(KEY,JSON.stringify(value));return true;}catch{return false;}}
