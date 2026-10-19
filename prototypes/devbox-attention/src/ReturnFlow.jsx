import React,{useEffect,useRef} from 'react';
import {ArrowRight,ArrowLeft,CheckCircle,Clock,WarningCircle,FileText,PaperPlaneTilt,Terminal,Info} from '@phosphor-icons/react';
import {RecoveryBrief} from './RecoveryBrief';
import {Inquiry} from './Inquiry';
import {SourceReview} from './SourceReview';
import {initialContext,snapshot,canSend,beginInquiry,repairPacket,draftIssues} from './recovery-state';
import {artifactsFor} from './context-data';
export const freshReturn=()=>({step:0,checked:[],choice:'fix',note:'',draft:'',status:'idle',fail:false,lastHandoff:null,opened:[],sourceContext:initialContext(),basis:null});
export function ReturnFlow({flow,setFlow,group,ci,offline,onResume,onSend,onFinish,onResult,onHome,newResult,onViewResult,onInquiry}){
 const passed=ci==='passed',version=passed?'b82d0e3':'a71c9d2',files=artifactsFor('retry',ci,group.attention==='done');
 const sc=flow.sourceContext||initialContext(),attempts=sc.attempts;
 const ready=passed&&!sc.stale&&!sc.conflict&&attempts===2;
 const pending=['sending','awaiting','accepted'].includes(flow.status),done=group.attention==='done';
 const sectionRef=useRef(null),previousStep=useRef(flow.step);
 const change=k=>setFlow(f=>({...f,...k}));
 useEffect(()=>{if(previousStep.current!==flow.step){previousStep.current=flow.step;const el=sectionRef.current;el?.focus({preventScroll:true});el?.scrollIntoView({block:'start'});}},[flow.step]);
 function prepare(choice){
  if(pending||newResult||done)return;
  if(choice==='ask'){setFlow(f=>beginInquiry(f));return;}
  if(offline)return;
  if(flow.draft&&flow.choice===choice){change({step:3});return;}
  const decision=choice==='ask'?'请解释当前结果与代码之间的关系，列明证据和仍需验证的问题；本次不授权改代码。':passed?'结合新检查结果复核剩余边界，返回待人工验收的结论。':'定位并修复总时限超出的原因，核实 remainingBudget 的 deadline 来源，再运行总时限、当前有效次数与幂等性边界回归。';
  change({step:3,choice,status:'idle',basis:snapshot(sc),draft:`请在当前原会话继续。\n\n本次决定：${decision}\n当前版本 ${version}：retry-ci.log（${passed?'12/12 通过，适用于当时最多 2 次的要求':'11/12 通过，总时限实测 12641ms'}）和 retry-budget.diff。\n这些是供你核查的依据，不代表我已完整审阅或验收改动。\n${passed?'旧检查不能证明后续变更的约束已满足。':'预算重置仍是待验证线索，请结合日志和代码确认。'}\n按随附的用户决定与有效约束继续，不将 agent 建议当作授权。\n返回：${choice==='ask'?'解释、证据位置及未验证问题；无需改动。':'改动版本、对应测试日志、仍未解决的问题。'}`});

 }
 const actions=()=> <div className="next-decision"><strong>接下来怎么做</strong><div className="flow-actions"><button className="btn primary" disabled={pending||offline||newResult||done} onClick={()=>prepare('fix')}>{passed?'请原 agent 继续复核':'交回原 agent 修复'} <ArrowRight/></button><button className="btn" disabled={pending||offline||newResult||done} onClick={()=>prepare('ask')}>先请 agent 解释</button></div><p className="flow-hint">先预览和编辑，再发送。退回或提问无需声明整份成果已验收。</p></div>;
 const resultNotice=newResult&&<div className="result-ready" role="status"><FileText/><div><strong>新结果已到 · b82d0e3</strong><p>补修与检查已返回，尚未验收。</p></div><button className="btn primary" onClick={onViewResult}>查看新结果</button></div>;
 return <section ref={sectionRef} tabIndex={-1} className="return-flow compact-return" aria-label="回访与交接流程">
  <div className="return-anchor"><span>{flow.lastHandoff?'比较基准 · 上次交接 a71c9d2':'离开基准 · 10/15 18:24'}</span><span>当前版本 · {version}</span></div>
  <nav className="return-nav" aria-label="工作视图"><button aria-current={flow.step===0?'page':undefined} onClick={()=>change({step:0})}>变化与下一步</button><button aria-current={flow.step===1?'page':undefined} onClick={()=>change({step:1})}>成果与验收</button>{flow.draft&&<button aria-current={flow.step===3?'page':undefined} onClick={()=>change({step:3})}>{flow.status==='accepted'?'交接回执':'交接草稿'}</button>}</nav>
  {offline&&<p className="warning-banner"><WarningCircle/>build-box 未连接。以下为上次已知记录，可能有未同步变化；恢复连接后才能交接或验收。</p>}
  {flow.step===0?<RecoveryBrief onResume={onResume} context={sc}/>:<details className="recovery-recap"><summary>历史依据：10 秒 · 最多 {attempts} 次{sc.conflict?"（范围待核实）":sc.stale?"（上次已知）":""} · 仅幂等请求 · 不自动合并 <span>展开理由与变更出处</span></summary><RecoveryBrief onResume={onResume} context={sc}/></details>}
  {flow.step!==3&&(sc.conflict||sc.stale||sc.resolved)&&<SourceReview flow={flow} setFlow={setFlow} onResume={onResume} offline={offline} mode="context"/>}
  {resultNotice}
  <Inquiry flow={flow} setFlow={setFlow} offline={offline} onSubmit={onInquiry}/>
  {done&&<div className="flow-complete" tabIndex={-1}><CheckCircle/><div><strong>已记录 {version} 的本轮验收</strong><p>PR 未合并，其他工作仍各自保留待办。</p></div><button className="btn" onClick={onHome}>回到首页</button></div>}
  {flow.step===0&&<>
   <div className="return-next-row"><h2>{passed?'上次交接后的变化':'实现返回了，总时限仍未通过'}</h2>{!passed&&!done&&<button className="btn primary" disabled={pending||offline||newResult} onClick={()=>prepare('fix')}>交回原 agent 修复 <ArrowRight/></button>}</div>
   <p className="flow-lead">{passed&&attempts!==2?'新要求已改为最多 '+attempts+' 次；b82d0e3 的检查只覆盖此前 2 次，不能用于当前要求验收。':passed?(flow.lastHandoff?'原 agent 按 10 秒、最多 2 次尝试补修；a71c9d2 → b82d0e3，11/12 → 12/12 通过。':'a71c9d2 → b82d0e3：补修和 12 项通过的检查已返回，仍需你验收。'):'现在需要处理：总时限实测 12.6 秒，仍不满足 10 秒；当前次数要求尚未补验。预算重置是待核实线索。'}</p>
   <article className="key-evidence"><div><FileText/><strong>retry-ci.log</strong><span>{version} · Shell · {passed?'09:47':'09:41'}</span></div><pre>{passed?'PASS 12 / 12 checks\nTotal deadline / max 2 attempts / idempotency: passed':'FAIL keeps total deadline\nExpected ≤ 10000ms · Received 12641ms'}</pre><details><summary>查看完整检查日志</summary><pre>{files.find(a=>a.id==='ci').body}</pre><button className="text-button" onClick={()=>onResume('test','latest')}>查看检查原记录 <ArrowRight/></button></details></article>
   {!done&&(passed?<div className="flow-actions"><button className="btn primary" onClick={()=>change({step:1})}>{attempts===2?'核对补修并验收':'查看旧检查的覆盖范围'} <ArrowRight/></button><button className="text-button" disabled={pending||offline||newResult} onClick={()=>prepare('ask')}>先请 agent 解释</button></div>:<><button className="text-button" disabled={pending||offline||newResult} onClick={()=>prepare('ask')}>先请 agent 解释</button><p className="flow-hint">交回修复会先生成可编辑草稿，不要求先验收整份成果。</p></>)}
   <div className="flow-actions"><button className="text-button" onClick={()=>change({step:1})}>按需查看完整改动 <ArrowRight/></button>{pending&&<button className="text-button" onClick={()=>change({step:3})}>查看交接回执</button>}</div>
   <details className="compact-history"><summary>查看这段工作的变化记录</summary><div className="change-events">{(passed?[['09:47','新检查','b82d0e3 · 12 / 12 通过'],['09:46','补修','单一 deadline，剩余预算跨轮次递减'],['09:41','历史失败','a71c9d2 · 总时限失败']]:[['09:41','检查','a71c9d2 · 总时限失败'],['09:34','待核对分析','Codex 怀疑预算被重置，尚未验证'],['09:12','新产物','Claude · a71c9d2 · 2 个文件']]).map(([time,title,body])=><div key={time}><time>{time}</time><div><strong>{title}</strong><p>{body}</p></div></div>)}</div></details>
  </>}
  {flow.step===1&&<>
   <h2>{passed?'核对补修，决定本轮是否结束':'当前成果与原要求'}</h2><p className="flow-lead">{passed?`a71c9d2 → ${version}：预算计算已补修，12 项检查通过。只核对这次返回的补修与日志；已记录的理由和约束在上方保留，不需重新确认。`:'总时限仍失败。可以直接退回修复或提问；只有确认完成才需要完整核对。'}</p>
   <div className="acceptance-list"><div><span>总时限 ≤ 10 秒</span><b className={passed?'check-passed':'check-failed'}>{passed?'当前检查通过':'失败 · 12.6 秒'}</b></div><div><span>非幂等写入不自动重试</span><b className="check-passed">当前检查通过</b></div><div><span>最多尝试 {attempts} 次 · 当前要求</span><b className={passed&&attempts===2?"check-passed":"check-failed"}>{attempts!==2?"旧检查不覆盖新要求":passed?"当前检查通过":"尚未补验"}</b></div><div><span>未经确认不合并</span><b>PR 保持开放</b></div></div>
   {files.filter(a=>['ci','diff'].includes(a.id)).map(a=><article className="review-artifact" key={version+a.id}><div className="review-file-title"><FileText/><div><strong>{a.name}</strong><small>{version} · {a.trust} · 来源 {a.session}</small></div></div><p>{a.summary}</p><details open={flow.opened?.includes(a.id)} onToggle={e=>{const open=e.currentTarget.open;setFlow(f=>{if(!!f.opened?.includes(a.id)===open)return f;return {...f,opened:open?[...new Set([...(f.opened||[]),a.id])]:(f.opened||[]).filter(x=>x!==a.id)};});}}><summary>{passed?'当前版本内容（可收起）':`展开${a.id==='ci'?'检查日志':'改动内容'}`}</summary><pre>{a.body}</pre><button className="text-button" onClick={()=>onResume(a.session,'latest')}>定位生成它的原会话 <ArrowRight/></button></details></article>)}
   {!done&&<>{passed&&<div className="accept-inline"><p>确认即表示你已阅读上方对应版本的日志与改动，接受本轮结果。有效约束已带入检查；不需重复勾选，PR 不会合并。</p><button className="btn primary" disabled={!ready||offline||pending||newResult} onClick={onFinish}>确认 {version} 本轮完成</button></div>}{actions()}</>}
  </>}
  {flow.step===3&&<>
   <h2>{flow.status==='accepted'?'原 agent 已接手':pending?'正在交接给原 agent':'修复草稿 · 由你决定何时交出'}</h2>
   {!pending&&<SourceReview flow={flow} setFlow={setFlow} onResume={onResume} offline={offline}/>}
   <div className="handoff-target"><Terminal/><div><strong>修复目标 · Claude 编码会话</strong><small>原会话 code · workstation · fix/retry-budget</small></div><button className="text-button" onClick={()=>onResume('code','latest')}>查看原会话</button></div>
   {flow.status!=='idle'&&<div className={`handoff-status ${flow.status}`} role="status">{flow.status==='accepted'?<CheckCircle/>:flow.status==='failed'?<WarningCircle/>:<Clock/>}<div><strong>{newResult?'已有新结果，等待你核对':({idle:'尚未发送',sending:'正在发送',awaiting:'已送达，等待接受回执',accepted:'已接受 · 等待结果',failed:'发送失败 · 草稿已保留'}[flow.status])}</strong><p>{flow.status==='accepted'?'回执对应原会话 code。接手不等于完成；未合并 PR。':flow.status==='sending'?'正在发送，编辑已暂时锁定；尚未收到接受回执。':flow.status==='failed'?'未获得接受回执，待办仍保留。可以重试。':flow.status==='awaiting'?'尚未确认 agent 已接手；待办仍保留。':'只发到上方原会话；可在下方直接修改指令。'}</p></div></div>}
   {flow.status==='accepted'?<><details className="sent-draft"><summary>查看已发送的决定与依据</summary><pre>{flow.lastHandoff?.text||flow.draft}</pre></details><div className="flow-actions"><button className="btn primary" onClick={onHome}>返回首页</button>{!newResult&&<button className="text-button" onClick={onResult}>演示：新结果返回</button>}</div></>:<><label className="field">修复指令 · 可编辑<textarea aria-label="增量交接内容" rows={9} value={flow.draft} disabled={pending} onChange={e=>change({draft:e.target.value,undoNotice:null})}/></label><details className="sent-draft"><summary>预览实际修复指令与授权范围</summary><pre>{repairPacket(flow)}</pre></details><p className="authorization-summary">本次授权：修复当前超时及正文列出的边界回归 · 不合并 PR<small>{draftIssues(flow).length?"还有正文差异待处理，暂不能发送。":sc.conflict?"范围尚未决定，核实可以继续。":sc.stale?"来源过期，需恢复同步。":"发送会采用当前依据；不需重复勾选未变的约束。"}</small></p><div className="flow-actions"><button className="btn primary" disabled={!canSend(flow,offline)||newResult} onClick={onSend}><PaperPlaneTilt/>{flow.status==='failed'?'重试发送修复任务':'发送修复任务到 code'}</button><button className="text-button" disabled={pending} onClick={()=>setFlow(f=>beginInquiry(f))}>先核实，不交修复</button><button className="text-button" disabled={pending} onClick={()=>change({step:0})}><ArrowLeft/>返回看变化（保留草稿）</button></div></>}
   <p className="flow-hint">本地模拟 · 正文与依据附件一同发送；只保存在本机。来源提取、同步与回执均为虚构样例。</p>
  </>}
 </section>;
}
