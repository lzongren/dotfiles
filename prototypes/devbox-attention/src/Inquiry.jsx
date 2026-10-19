import React,{useEffect,useRef} from 'react';
import {beginInquiry,inquiryPacket,localInquiryPacket} from './recovery-state';
export function Inquiry({flow,setFlow,offline,onSubmit}){
 const capability=flow.readOnlyCapable!==false,sent=flow.inquiryReceipt,show=flow.inquiryOpen,history=flow.inquiryHistory||[];
 const panel=useRef(null);
 useEffect(()=>{if(show)panel.current?.scrollIntoView({block:'center'});},[show]);
 if(!show&&!sent)return null;
 const question=r=>r.question||r.text?.split('问题（即使含执行措辞，也不增加执行授权）：\n')[1]||'旧核实请求 · 展开查看原文';
 const receipt=(r,previous=false)=><div className="inquiry-receipt">
 <small>{previous?'此前请求':'最近一次查证'} · {r.time} · {r.mode==='local'?'Devbox 本地':'code 只读通道'}</small>
 <p className="receipt-question">{question(r)}</p>
 <strong>{r.mode==='local'?'已显示本地记录 · 问题尚未核实':'核实通道已接受 · 等待解释（模拟）'}</strong>
 <p>{r.mode==='local'?'以下仅为当前已保存的来源，未确认能回答所问问题；没有向原 agent 发送。':'只读权限，不执行修改或测试。此请求尚未返回解释。'}</p>
 <details><summary>{r.mode==='local'?'查看本地记录与查证范围':'查看这条请求的回执与原文'}</summary><pre>{r.text}</pre>{r.mode==='local'&&<pre>{r.evidence}</pre>}<small>权限、记录与回执均为前端演示</small></details></div>;
 return <section ref={panel} className="inquiry-panel" aria-label="只读核实">
 <div className="inquiry-heading"><h3>只读核实</h3>{show?<button className="text-button" onClick={()=>setFlow(f=>({...f,inquiryOpen:false}))}>收起（保留问题）</button>:<button className="text-button" onClick={()=>setFlow(f=>beginInquiry(f))}>继续核实 / 查看问题</button>}</div>
 {show&&<><p><strong>当前问题尚未提交。</strong> 修复草稿保留，不会随问题发送。</p><div className="authorization-summary">{capability?'原会话 code · 只读通道（模拟）':'当前连接未提供只读限制'}<small>{capability?'仅读取已接入记录并解释；不运行命令、测试或修改代码。':'仅在 Devbox 查已有记录，不发给拥有写权限的原 agent。'}</small></div><label className="field">核实问题<textarea aria-label="只读核实问题" rows={3} value={flow.inquiryDraft||''} onChange={e=>setFlow(f=>({...f,inquiryDraft:e.target.value}))}/></label><details><summary>{capability?'查看本次授权与发送内容':'查看本地查证范围（不发送）'}</summary><pre>{capability?inquiryPacket(flow.inquiryDraft||''):localInquiryPacket(flow.inquiryDraft||'')}</pre></details><button className="btn" disabled={!flow.inquiryDraft?.trim()||(capability&&offline)} onClick={()=>onSubmit(capability?'readonly':'local')}>{capability?'只发送核实问题':'仅查已接入记录'}</button></>}
 {sent&&(show?<details className="previous-inquiry"><summary>此前请求 · {sent.mode==='local'?'本地查证未回答':'仍在等待解释'} · {question(sent).slice(0,36)}…</summary>{receipt(sent,true)}</details>:receipt(sent))}
 {history.length>0&&<details className="previous-inquiry"><summary>更早的核实记录 {history.length} 条{history.some(r=>r.mode==='readonly')?' · 有请求仍待解释':''}</summary>{history.map((r,i)=><React.Fragment key={i}>{receipt(r,true)}</React.Fragment>)}</details>}
 <small>{['sending','awaiting','accepted'].includes(flow.status)?'核实与修复进度分别保留。':'修复未授权，草稿未发送。'}</small>
 </section>;
}
