import test from 'node:test';
import assert from 'node:assert/strict';
import {initialContext,snapshot,differences,canSend,sourceChange,contextPacket} from '../src/recovery-state.js';
const initial=()=>{const c=initialContext();return {sourceContext:c,basis:snapshot(c),draft:'请核对当前要求。保留自写补充。',status:'idle'};};
test('unchanged restored drafts need no acknowledgement',()=>{
 const f=JSON.parse(JSON.stringify(initial()));
 assert.deepEqual(differences(f.basis,f.sourceContext),[]);
 assert.equal(canSend(f),true);
});
test('source-only change is shown without an extra acknowledgement before explicit send',()=>{
 const f=initial();f.sourceContext=sourceChange(f.sourceContext,'update');
 assert.deepEqual(differences(f.basis,f.sourceContext).map(x=>x.id),['attempts']);
 assert.equal(canSend(f),true);
 assert.match(contextPacket(f.sourceContext),/最多尝试 1 次/);
 const draft=f.draft;f.basis=snapshot(f.sourceContext);
 assert.equal(canSend(f),true);assert.equal(f.draft,draft);
 assert.match(contextPacket(f.sourceContext),/最多尝试 1 次/);
});
test('ambiguity is unresolved even if a snapshot was acknowledged',()=>{
 const f=initial();f.sourceContext=sourceChange(f.sourceContext,'conflict');
 assert.equal(f.sourceContext.attempts,2);
 f.basis=snapshot(f.sourceContext);assert.equal(canSend(f),false);
 f.sourceContext={...f.sourceContext,conflict:false,resolved:true};
 assert.equal(canSend(f),true);
 f.basis=snapshot(f.sourceContext);assert.equal(canSend(f),true);
 f.sourceContext={...f.sourceContext,conflict:true,resolved:false};
 assert.equal(canSend(f),false);
});
test('staleness never changes decisions or destroys draft; blocks only handoff',()=>{
 const f=initial(),draft=f.draft;f.sourceContext=sourceChange(f.sourceContext,'stale');
 assert.equal(f.sourceContext.attempts,2);assert.equal(f.draft,draft);
 assert.equal(canSend(f),false);assert.deepEqual(differences(f.basis,f.sourceContext),[]);
 f.sourceContext.stale=false;assert.equal(canSend(f),true);
 assert.equal(canSend(f,true),false);
});
test('legacy unsnapshotted and duplicate handoffs cannot be silently sent',()=>{
 const f=initial();f.basis=null;assert.equal(canSend(f),false);
 f.basis=snapshot(f.sourceContext);
 for(const status of ['sending','awaiting','accepted'])assert.equal(canSend({...f,status}),false);
});
test('changed attachment cannot allow conflicting draft text through',async()=>{
 const {draftIssues,adoptDraftChanges}=await import('../src/recovery-state.js');
 let f=initial();f.draft+='\n请补充最多尝试 2 次的边界用例，不要只回复测试通过。';
 f.sourceContext=sourceChange(f.sourceContext,'update');
 f.basis=snapshot(f.sourceContext);
 assert.equal(canSend(f),false);assert.equal(draftIssues(f).length,1);
 const before=f.draft;f=adoptDraftChanges(f);
 assert.equal(canSend(f),true);
 assert.equal(f.draft,before.replace('最多尝试 2 次','最多尝试 1 次'));
 assert.equal(f.draftUndo.before,before);
});
test('user-declared comparison scope is bound to the exact text and current constraint',async()=>{
 const {draftIssues}=await import('../src/recovery-state.js');
 const f=initial();f.sourceContext=sourceChange(f.sourceContext,'update');f.basis=snapshot(f.sourceContext);
 f.draft='验证最多尝试 2 次的历史对照';f.comparisonNotes=[draftIssues(f)[0].key];
 assert.equal(canSend(f),true);
 f.draft='正式请求最多尝试 2 次';
 assert.equal(canSend(f),false);
});
test('repeated same-source demo events do not silently undo local decisions',()=>{
 const c={...initialContext(),resolved:true};
 assert.equal(sourceChange(c,'conflict').resolved,true);
});

test('two phrases can be resolved differently and scope survives reload',async()=>{
 const {draftIssues,resolveIssue,activeComparisons,repairPacket}=await import('../src/recovery-state.js');
 let f=initial();f.draft='正式请求最多尝试 2 次。保留日志格式。\n旧版最多尝试 2 次，用于结果对照。';f.sourceContext=sourceChange(f.sourceContext,'update');
 let issues=draftIssues(f);assert.equal(issues.length,2);
 f=resolveIssue(f,issues[0].key,'replace');assert.equal(draftIssues(f).length,1);assert.equal(canSend(f),false);
 f=resolveIssue(f,draftIssues(f)[0].key,'history');assert.equal(canSend(f),true);
 f=JSON.parse(JSON.stringify(f));assert.equal(differences(f.basis,f.sourceContext).length,0);assert.equal(activeComparisons(f).length,1);
 const packet=repairPacket(f);assert.match(packet,/正式请求最多尝试 1 次。保留日志格式/);assert.match(packet,/旧版最多尝试 2 次/);assert.match(packet,/非正式请求授权/);
});
test('undo preserves later custom edits and restores the conflict gate',async()=>{
 const {draftIssues,resolveIssue,undoLocalEdit}=await import('../src/recovery-state.js');
 let f=initial();f.draft='请补最多尝试 2 次的用例。';f.sourceContext=sourceChange(f.sourceContext,'update');
 f=resolveIssue(f,draftIssues(f)[0].key,'replace');f.draft+='\n保留我后来写的日志要求。';
 f=undoLocalEdit(f,f.editHistory[0].id);assert.match(f.draft,/最多尝试 2 次/);assert.match(f.draft,/后来写的日志要求/);assert.equal(canSend(f),false);
});
test('unsafe undo leaves edited content intact',async()=>{
 const {draftIssues,resolveIssue,undoLocalEdit}=await import('../src/recovery-state.js');
 let f=initial();f.draft='请补最多尝试 2 次的用例。';f.sourceContext=sourceChange(f.sourceContext,'update');
 f=resolveIssue(f,draftIssues(f)[0].key,'replace');f.draft='我已经重写这一整句。';
 const after=undoLocalEdit(f,f.editHistory[0].id);assert.equal(after.draft,f.draft);assert.match(after.undoNotice,/无法安全定位/);
});
test('historical scope is per occurrence; stale scope never enters sent packet',async()=>{
 const {draftIssues,resolveIssue,activeComparisons,repairPacket}=await import('../src/recovery-state.js');
 let f=initial();f.draft='最多尝试 2 次\n最多尝试 2 次';f.sourceContext=sourceChange(f.sourceContext,'update');
 f=resolveIssue(f,draftIssues(f)[0].key,'history');assert.equal(draftIssues(f).length,1);
 f.draft='正式请求最多尝试 2 次';assert.equal(activeComparisons(f).length,0);assert.doesNotMatch(repairPacket(f),/用户明确的历史对照范围/);assert.equal(canSend(f),false);
});
test('opening investigation preserves repair body, status and unresolved context',async()=>{
 const {beginInquiry,inquiryPacket}=await import('../src/recovery-state.js');
 const f=initial();f.sourceContext=sourceChange(f.sourceContext,'conflict');
 const next=beginInquiry(f,'只解释为什么失败');assert.equal(next.draft,f.draft);assert.equal(next.status,'idle');assert.equal(next.sourceContext.conflict,true);assert.equal(canSend(next),false);
 assert.match(inquiryPacket(next.inquiryDraft),/不修改代码、不运行测试或命令/);assert.match(inquiryPacket(next.inquiryDraft),/目标：原会话 code/);
});
test('new explicit source update never clears an unresolved scope conflict',()=>{
 const c=sourceChange(sourceChange(initialContext(),'conflict'),'update');assert.equal(c.attempts,1);assert.equal(c.conflict,true);
});
test('reapplying a local correction clears obsolete undo feedback',async()=>{
 const {draftIssues,resolveIssue,undoLocalEdit}=await import('../src/recovery-state.js');
 let f=initial();f.draft='正式请求最多尝试 3 次。';
 f=resolveIssue(f,draftIssues(f)[0].key,'replace');f=undoLocalEdit(f,f.editHistory[0].id);
 assert.match(f.undoNotice,/已撤销/);
 f=resolveIssue(f,draftIssues(f)[0].key,'replace');assert.equal(f.undoNotice,null);assert.equal(canSend(f),true);
});
test('local inquiry packet never claims remote delivery or an answered question',async()=>{
 const {localInquiryPacket}=await import('../src/recovery-state.js');
 const text=localInquiryPacket('旧方案对照是否有原记录？');
 assert.match(text,/不发送给原 agent/);assert.match(text,/未自动回答或核实问题/);assert.match(text,/旧方案对照/);
});
