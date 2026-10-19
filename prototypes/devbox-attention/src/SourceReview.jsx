import React from 'react';
import {WarningCircle,Clock,CheckCircle} from '@phosphor-icons/react';
import {initialContext,snapshot,differences,contextPacket,draftIssues,resolveIssue,undoLocalEdit,activeComparisons,beginInquiry} from './recovery-state';
export function SourceReview({flow,setFlow,onResume,offline,mode='draft'}){
 const c=flow.sourceContext||initialContext(),rows=differences(flow.basis,c),issues=draftIssues(flow),comparisons=activeComparisons(flow),locked=['sending','awaiting','accepted'].includes(flow.status);
 const change=patch=>setFlow(f=>({...f,...patch}));
 return <section className="source-review" aria-label="来源变化核对">
 {c.stale&&<div className="source-alert"><Clock/><div><strong>后续记录尚未同步 · 修复暂停</strong><p>草稿和历史理由保留。同步不会自动解决范围冲突或发送。</p><button className="btn" disabled={offline||locked} onClick={()=>change({sourceContext:{...c,stale:false},syncNotice:true})}>重新同步来源（演示）</button></div></div>}
 {flow.syncNotice&&!c.stale&&<p className="sync-note">同步完成 · 内容未变，不需重复确认（模拟）</p>}
 {c.conflict&&<div className="source-alert"><WarningCircle/><div><strong>“按 3 次跑回归”的范围尚不明确</strong><p>正式请求上限是 {c.attempts} 次；新记录没有说明是否替代它。</p><details><summary>查看双方出处与原文</summary><div className="source-pair"><blockquote><b>你 · {c.attempts===1?'10/18 10:10 · code#limit-one':'10/17 16:20 · code#constraint-update'}</b><p>PR #184 正式请求最多尝试 {c.attempts} 次；10 秒、幂等、不合并保持。</p></blockquote><blockquote><b>你 · 10/18 10:20 · code#regression-note</b><p>“先按 3 次跑回归，看看压力曲线。”</p><small>范围未说明</small><button className="text-button" onClick={()=>onResume('code','regression-note')}>定位原记录</button></blockquote></div></details><div className="flow-actions"><button className="btn" disabled={locked||c.stale||offline} onClick={()=>{const next={...c,conflict:false,resolved:true};change({sourceContext:next,basis:flow.basis?.attempts===c.attempts?snapshot(next):flow.basis});}}>本轮沿用 {c.attempts} 次，暂不采用 3 次</button><button className="text-button" onClick={()=>setFlow(f=>beginInquiry(f,'请只依据两条原记录核实 3 次指令的适用范围；不明确就保留未知，不改代码、不运行测试。'))}>先核实范围（只读）</button></div></div></div>}
 {c.resolved&&<div className="local-resolution"><CheckCircle size={16}/><span>本次决定：正式请求 {c.attempts} 次 · 3 次原意仍未知</span><button className="text-button" disabled={locked} onClick={()=>change({sourceContext:{...c,conflict:true,resolved:false}})}>撤销范围决定</button></div>}
 {mode==='draft'&&<div className="draft-delta">
 <div className="delta-title"><h3>{issues.length?`只处理 ${issues.length} 处正文差异`:rows.length?'依据有变化 · 正文已保留':'与保存时的依据一致'}</h3><span>其它编辑保留 · 尚未发送</span></div>
 {rows.filter(r=>r.id!=='conflict').map(row=><div className="compact-source-change" key={row.id}><strong>{row.before} → {row.after}</strong><details><summary>变更出处</summary><blockquote>你 · 10/18 10:10 · code#limit-one · PR #184<br/>“限流仍在持续。正式请求最多尝试 1 次，替代昨天的 2 次；其它要求不变。”</blockquote><button className="text-button" onClick={()=>onResume('code','limit-one')}>定位原记录</button></details></div>)}
 {issues.map((x,i)=><article className="local-issue" key={x.key} aria-label={`正文差异 ${i+1}`}><blockquote>{x.line}</blockquote><p><del>{x.before}</del> → <mark>{x.after}</mark></p><div className="flow-actions"><button className="btn" disabled={locked||c.stale} onClick={()=>setFlow(f=>resolveIssue(f,x.key,'replace'))}>只改这一处为 {c.attempts} 次</button><button className="text-button" disabled={locked||c.stale} onClick={()=>setFlow(f=>resolveIssue(f,x.key,'history'))}>这处保留为历史对照</button></div></article>)}
 {!issues.length&&rows.length>0&&flow.basis&&!c.conflict&&<p>未发现支持句式中的旧次数。变化随最终发送采用，无需另点确认。</p>}
 {!flow.basis&&<button className="btn" onClick={()=>change({basis:snapshot(c)})}>记录这份旧草稿的依据</button>}
 {(comparisons.length>0||flow.editHistory?.length>0)&&<details className="processed-edits"><summary>已处理 {comparisons.length+(flow.editHistory?.length||0)} 处 · 查看或撤销</summary>{comparisons.map(x=><div key={x.key}><p>历史对照：{x.line}</p><small>该句的旧次数不改变正式请求限制；说明会随正文发送。</small><button className="text-button" disabled={locked} onClick={()=>change({comparisonNotes:flow.comparisonNotes.filter(k=>k!==x.key)})}>撤销这处对照范围</button></div>)}{flow.editHistory?.map(x=><div key={x.id}><p>{x.before} → {x.after}</p><button className="text-button" disabled={locked} onClick={()=>setFlow(f=>undoLocalEdit(f,x.id))}>撤销这一处替换</button></div>)}</details>}
 {flow.undoNotice&&<p role="status">{flow.undoNotice}</p>}
 <p className="flow-hint">仅检查“最多（尝试）1/2/3 次”等明确句式；快照一致不表示全文语义正确。</p>
 <details className="basis-details"><summary>有效约束与依据 · 按需查看</summary><pre>{contextPacket(c)}</pre></details>
 </div>}
 </section>;
}
