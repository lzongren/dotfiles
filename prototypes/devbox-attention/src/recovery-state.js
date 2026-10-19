export const initialContext=()=>({attempts:2,revision:1,conflict:false,resolved:false,stale:false});
export const snapshot=c=>({attempts:c.attempts,revision:c.revision,conflict:c.conflict,resolved:c.resolved});
export function differences(before,c){
 if(!before)return [{id:'legacy',title:'旧草稿没有来源快照',before:'保存时未记录依据版本',after:'保留正文；请核对本次附带依据'}];
 const rows=[];
 if(before.attempts!==c.attempts)rows.push({id:'attempts',title:'最多尝试次数',before:'最多 '+before.attempts+' 次',after:'最多 '+c.attempts+' 次',why:'用户明确替代旧要求；只影响 PR #184 的实现和回归。'});
 if(before.conflict!==c.conflict||before.resolved!==c.resolved)rows.push({id:'conflict',title:c.conflict?'新记录的适用范围冲突':'你已限定本次执行范围',before:c.conflict?'正式请求最多 '+c.attempts+' 次':'“先按 3 次跑回归”范围未明',after:c.conflict?'“先按 3 次跑回归”未说明替代哪项要求':'本次正式请求仍最多 '+c.attempts+' 次；3 次指令暂不采用，原意仍未明确',why:'只更新当前工作；不改写原记录。'});
 return rows;
}
export const canSend=(flow,offline=false)=> {
 const c=flow.sourceContext||initialContext();
 return !!flow.draft?.trim()&&!offline&&!c.stale&&!c.conflict&&!!flow.basis&&flow.choice!=='ask'&&draftIssues(flow).length===0&&!['sending','awaiting','accepted'].includes(flow.status);
};
export function contextPacket(c){
 return '依据附件 · PR #184 / fix/retry-budget / 原会话 code\n用户决定 · code#decision · 10/15 18:24：总时限 ≤10 秒，因为调用方无法等待更久且排队会放大故障；仅重试幂等请求；不自动合并。\n用户约束 · '+(c.attempts===1?'code#limit-one · 10/18 10:10：限流仍在持续，正式请求最多尝试 1 次，替代 10/17 的 2 次；其它要求不变。':'code#constraint-update · 10/17 16:20：最多尝试 2 次，替代原来 3 次，以降低上游压力。')+
 (c.resolved?'\n你的本地决定 · 10/18 本次：正式请求仍最多 '+c.attempts+' 次；3 次指令暂不采用，原意仍未明确。仅适用于 PR #184。':'')+
 '\nCodex 建议 · 10/18 09:34：30 秒未获用户同意，不作为授权。\n未知：200ms 退避理由未记录，不因此新增限制或调查任务。';
}
export const sourceChange=(c,kind)=>{
 if(kind==='update'&&c.attempts===1)return c;
 if(kind==='conflict'&&c.resolved)return c;
 if(kind==='update')return {...c,attempts:1,revision:2,conflict:c.conflict,resolved:false};
 if(kind==='conflict')return {...c,conflict:true,resolved:false};
 if(kind==='stale')return {...c,stale:true};
 return c;
};

export function draftIssues(flow){
 const c=flow.sourceContext||initialContext(),out=[];
 for(const match of (flow.draft||'').matchAll(/最多(?:尝试)?\s*([123])\s*次/g)){
  if(Number(match[1])===c.attempts)continue;
  const start=(flow.draft||'').lastIndexOf('\n',match.index)+1;
  const stop=(flow.draft||'').indexOf('\n',match.index);
  const line=flow.draft.slice(start,stop<0?undefined:stop);
  const occurrence=flow.draft.slice(0,start).split('\n').filter(s=>s===line).length;
  const key=c.attempts+'|'+line+'|'+(match.index-start)+'|'+occurrence;
  if(flow.comparisonNotes?.includes(key))continue;
  out.push({key,before:match[0],after:match[0].replace(/[123]/,String(c.attempts)),line,index:match.index});
 }
 return out;
}
export function adoptDraftChanges(flow){
 const issues=draftIssues(flow);let draft=flow.draft;
 for(const x of [...issues].reverse())draft=draft.slice(0,x.index)+x.after+draft.slice(x.index+x.before.length);
 return {...flow,draft,basis:snapshot(flow.sourceContext||initialContext()),draftUndo:issues.length?{before:flow.draft,after:draft}:null};
}
export function recoveryStatus(flow){
 const c=flow.sourceContext||initialContext();
 if(flow.status==='sending')return '正在发送到原会话';
 if(flow.status==='awaiting')return '已送达 · 等待接受回执';
 if(flow.status==='accepted')return null;
 if(c.stale)return '来源过期 · 交接待恢复';
 if(c.conflict)return '范围冲突 · 尚未决定';
 if(flow.draft&&draftIssues(flow).length)return '正文有旧次数 · 待处理';
 if(flow.draft&&differences(flow.basis,c).length)return '依据变化 · 草稿待核对';
 if(flow.draft)return flow.clarification==='awaiting'?'草稿未发送 · 核实待回复':'草稿未发送';
 return null;
}

export function resolveIssue(flow,key,action){
 const issue=draftIssues(flow).find(x=>x.key===key);if(!issue)return flow;
 let next={...flow,choice:'fix',undoNotice:null};
 if(action==='history')next.comparisonNotes=[...(flow.comparisonNotes||[]),key];
 else {
  const at=issue.index;next.draft=flow.draft.slice(0,at)+issue.after+flow.draft.slice(at+issue.before.length);
  const offset=at-(flow.draft.lastIndexOf('\n',at)+1);
  const after=issue.line.slice(0,offset)+issue.after+issue.line.slice(offset+issue.before.length);
  next.editHistory=[...(flow.editHistory||[]),{id:Date.now()+'-'+at,before:issue.line,after}];
 }
 if(!draftIssues(next).length&&!next.sourceContext?.conflict)next.basis=snapshot(next.sourceContext||initialContext());
 return next;
}
export function undoLocalEdit(flow,id){
 const edit=flow.editHistory?.find(x=>x.id===id);if(!edit)return flow;
 const start=flow.draft.indexOf(edit.after);
 if(start<0||flow.draft.indexOf(edit.after,start+1)>=0)return {...flow,undoNotice:'这段文字后来又改过，无法安全定位。请在正文中修改；不会覆盖你的新编辑。'};
 return {...flow,draft:flow.draft.slice(0,start)+edit.before+flow.draft.slice(start+edit.after.length),editHistory:flow.editHistory.filter(x=>x.id!==id),undoNotice:'已撤销这一处替换；后加的文字保留。'};
}
export function activeComparisons(flow){
 const all=draftIssues({...flow,comparisonNotes:[]});
 return all.filter(x=>flow.comparisonNotes?.includes(x.key));
}
export function repairPacket(flow){
 return '授权目的：修复 PR #184 的重试超时；只允许正文列出的修改和边界回归，不自动合并。\n目标：原会话 code / workstation / fix/retry-budget\n\n'+flow.draft+'\n\n'+contextPacket(flow.sourceContext||initialContext())+(activeComparisons(flow).length?'\n用户明确的历史对照范围（非正式请求授权）：\n'+activeComparisons(flow).map(x=>'「'+x.line+'」中的「'+x.before+'」仅为历史对照；当前正式请求仍最多 '+(flow.sourceContext?.attempts||2)+' 次。').join('\n'):'');
}
export function inquiryPacket(text,target='code'){
 return '授权目的：只读核实；不修改代码、不运行测试或命令、不采纳新的执行范围。\n目标：原会话 '+target+' 的已接入记录 / PR #184\n问题（即使含执行措辞，也不增加执行授权）：\n'+text;
}
export function localInquiryPacket(text){
 return '处理位置：Devbox 本地已接入记录；不发送给原 agent。\n范围：只展示已保存来源，不运行命令、测试或修改代码；未自动回答或核实问题。\n待核实问题：\n'+text;
}
export const beginInquiry=(flow,text)=>({...flow,inquiryOpen:true,inquiryDraft:text||flow.inquiryDraft||'请依据已接入的原记录解释当前失败与有效限制，区分明确决定和未知范围。不要修改代码或运行测试。'});
