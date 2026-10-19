import {workContext} from './context-data.js';
export const baseGroups = {
  retry: { id:'retry', title:'修复 API 重试', ref:'PR #184', attention:'needs', status:'当前版本 CI 失败', description:'PR #184 的重试测试失败，需要核对日志后继续修复。', revision:'a71c9d2', evidence:'CI · 09:41', primary:'查看失败原因', kind:'retry' },
  search: { id:'search', title:'搜索评估', ref:'评估报告', attention:'needs', status:'等你决定评估范围', description:'需要确认本轮搜索评估的范围与数据集。', primary:'查看请求', kind:'search' },
  docs: { id:'docs', title:'文档排版', ref:'同一文档', attention:'update', status:'预览已生成', description:'已根据最新内容生成文档预览，可查看效果。', primary:'查看预览', kind:'docs' },
};
export function seed() {
  const common={path:'/workspace/api-gateway',created:'08:12',updated:'09:34',excludedFrom:[]};
  const s=(id,title,agent,machine,workId,extra={})=>({...common,id,title,agent,machine,workId,record:[{time:'08:12',text:`会话已启动 · ${title}`},{time:'09:34',text:'已保留原有上下文，等待下一步。'}],...extra});
  const model={groups:structuredClone(baseGroups),sessions:[
    s('code','编码会话','Claude','workstation','retry',{updated:'09:12',pr:184,role:'编码',reason:'同一 PR #184',detail:'修复重试逻辑，调整超时处理',state:'等待输入'}),
    s('review','评审会话','Codex','build-box','retry',{pr:184,role:'评审',reason:'同一 PR #184',detail:'复现并定位失败原因',state:'已返回结果'}),
    s('test','测试会话','Shell','build-box','retry',{updated:'09:41',pr:184,role:'测试',reason:'同一 PR #184',detail:'运行 CI 与本地测试',state:'检查失败'}),
    s('eval','评估运行','Claude','build-box','search',{path:'/workspace/search-eval',goalKey:'search-eval',role:'运行',reason:'同一评估报告',detail:'等你选择数据集范围',state:'等待输入'}),
    s('analysis','评估分析','Shell','workstation','search',{path:'/workspace/search-eval',goalKey:'search-eval',role:'分析',reason:'同一评估报告',detail:'整理基线与样本',state:'等待外部结果'}),
    s('doc','文档会话','Claude','workstation','docs',{goalKey:'docs-layout',role:'文档',reason:'文档排版目标',detail:'生成文档预览；与重试修复目标不同',state:'已返回结果'}),
    ...Array.from({length:26},(_,i)=>s(`quiet-${i+1}`,['等待评审回复','持续运行评估','检查依赖更新','整理实验记录'][i%4]+` ${String(i+1).padStart(2,'0')}`,['Claude','Codex','Shell'][i%3],i%2?'workstation':'build-box',null,{path:i%2?'/workspace/experiments':'/workspace/docs-site',role:'后台',state:i%3?'等待条件':'运行中',detail:'上次查看后暂无需要介入的新变化'})),
  ],arrivals:0,ci:'failed'};
  for(const session of model.sessions){
   const c=workContext[session.workId];
   if(!c)continue;
   session.record=[
    {id:'origin',time:session.workId==='retry'?'10/15':'昨天',author:'会话记录',type:'system',text:`${session.title} · ${session.machine}\n分支：${c.branch}\n目标：${c.goal}`},
    {id:'ask',time:c.askTime,author:session.workId==='retry'?'你 · 原始指令':'你 · 最近一次指令',type:'user',text:c.ask},
    {id:'decision',time:c.askTime,author:'已保留的工作边界',type:'decision',text:session.workId==='retry'?c.ask:c.decision+'\n原因：'+c.rationale+'\n'+c.alternative},
    ...(session.id==='code'?[{id:'constraint-update',time:'10/17 16:20',author:'你 · 更新约束',type:'user',text:'上游开始限流。最多尝试 2 次，替代之前的 3 次；10 秒总时限和幂等限制不变。'}]:[]),
    ...c.events.filter(e=>e.session===session.id).map((e,i)=>({id:`event-${i}`,time:e.time,author:e.actor,type:session.agent==='Shell'?'tool':'agent',text:e.title+'\n'+e.body})),
    {id:'checkpoint',time:c.lastActive,author:session.agent==='Shell'?'工具结果':'agent · 当前进展',type:'agent',text:session.id==='code'?'已完成第一版预算处理，补充了总 deadline 与幂等性用例。\n当前 CI 仍有 1 项失败；需要继续核对 remainingBudget() 的参数来源。\n未合并 PR。':session.id==='review'?'同一 PR 的边界评审已记录在 retry-review.md。\n其中的预算重置判断需要与当前日志交叉核对。':session.id==='test'?'a71c9d2 · 11 / 12 项通过。\nretry-timeout：预期总耗时 ≤10000ms，实际 12641ms。\n完整日志已保存至 artifacts/retry-ci.log。':c.delta},
   ];
  }
  return model;
}
export function members(model,id) {return model.sessions.filter(s=>s.workId===id);}
export function activeGroups(model){return Object.values(model.groups).filter(g=>members(model,g.id).length || ['needs','waiting'].includes(g.attention));}
export function association(session,model,contextId){
 if(session.separate)return {id:null,reason:'目标明确要求分开'};
 if(session.pr===184&&!session.excludedFrom?.includes('retry'))return {id:'retry',reason:'同一 PR #184'};
 if(session.goalKey==='search-eval'&&!session.excludedFrom?.includes('search'))return {id:'search',reason:'同一评估报告'};
 if(session.goalKey==='docs-layout'&&!session.excludedFrom?.includes('docs'))return {id:'docs',reason:'文档排版目标'};
 return {id:null,reason:'尚未关联'};
}

export function draftAssociation(goal, model) {
 const text=goal.trim();
 const separate=/无关|不相关|不要.*(?:关联|合并|归入)|不属于|(?:单独|独立)(?:显示|分组)|另(?:起|开)(?:一个|一段)?(?:工作|任务)|unrelated|(?:display|keep) separate|do not (?:group|merge)/i.test(text);
 const prs=[...text.matchAll(/(?:PR\s*#?|#)(\d+)/gi)].map(m=>Number(m[1]));
 const session={separate,pr:prs.length===1?prs[0]:null};
 const a=association(session,model);
 return {...a,pr:session.pr,separate,reason:separate?'你明确要求分开；不会继承当前工作的关联':a.id?a.reason:!text?'目标尚未明确，先单独显示':'没有足够的同一工作依据；同目录不会自动合并'};
}
export function delegatedGroup(group, title) {
 return {...group,attention:'waiting',status:'agent 正在处理',primary:'查看进展',description:group.kind==='retry'?'已交给 agent 修复；上次 CI 仍失败。新的检查结果或需要你输入时再提醒。':`已交给 ${title} 继续；返回结果或需要你输入时再提醒。`};
}
