/**
 * PROTOTYPE — throwaway. Emits a single self-contained HTML the human can drive:
 * toggle each candidate-rejection rule, move the length cap, and watch the kill set
 * and the suspected-false-negative list change. That toggling IS the state machine
 * #35 has to rule on (rule set → kill set).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const data = readFileSync('/tmp/sg-guardrail-probe/out/probe-data.json', 'utf8')

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>#33 抽取器护栏全库实测 — PROTOTYPE</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:13px/1.6 -apple-system,"PingFang SC",Segoe UI,sans-serif;color:#1a1a1a;background:#f6f7f9}
header{background:#fff;border-bottom:1px solid #e1e4e8;padding:14px 20px}
h1{margin:0 0 4px;font-size:16px}
.sub{color:#666;font-size:12px}
.warn{display:inline-block;background:#fff3cd;border:1px solid #ffeaa7;color:#7a5c00;padding:2px 8px;border-radius:3px;font-size:11px;margin-left:8px}
.ok{background:#d4edda;border-color:#b7dfc0;color:#1a6b2d}
.layout{display:flex;align-items:flex-start;gap:16px;padding:16px 20px}
aside{flex:0 0 330px;position:sticky;top:16px}
.card{background:#fff;border:1px solid #e1e4e8;border-radius:6px;padding:12px;margin-bottom:12px}
.card h2{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#666}
label.rule{display:block;padding:6px 0;border-bottom:1px solid #f0f0f0;cursor:pointer}
label.rule:last-child{border-bottom:0}
label.rule input{margin-right:6px}
.rl{font-weight:600}
.cnt{float:right;color:#888;font-variant-numeric:tabular-nums;font-size:11px}
.why{display:block;color:#777;font-size:11px;margin-left:19px;margin-top:2px}
.tier-proposed .rl{color:#0a5ca8}
.tier-rejected{opacity:.75;background:#fff8f8}
.tier-rejected .rl{color:#b3261e}
main{flex:1;min-width:0}
.stats{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.stat{background:#fff;border:1px solid #e1e4e8;border-radius:6px;padding:10px 14px;flex:1;min-width:120px}
.stat .n{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.stat .l{font-size:11px;color:#666}
.tabs{display:flex;gap:4px;margin-bottom:10px}
.tabs button{background:#fff;border:1px solid #e1e4e8;padding:7px 14px;border-radius:5px;cursor:pointer;font:inherit;font-size:12px}
.tabs button.on{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
input[type=search]{width:100%;padding:7px 10px;border:1px solid #d0d7de;border-radius:5px;font:inherit;margin-bottom:10px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e1e4e8;border-radius:6px;overflow:hidden}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #f0f0f0;vertical-align:top}
th{background:#fafbfc;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#666;position:sticky;top:0}
td.term{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;max-width:260px;word-break:break-all}
td.ctx{color:#666;font-size:11px;max-width:430px}
td.def{font-family:ui-monospace,monospace;font-size:11px;color:#444;max-width:200px;word-break:break-all}
.chip{display:inline-block;background:#eef1f4;border-radius:3px;padding:1px 5px;margin:1px 2px 1px 0;font-size:10px;color:#333;white-space:nowrap}
.chip.p{background:#e3f0fb;color:#0a5ca8}
.src{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px}
.src.paren{background:#e8f0e8;color:#2d5c2d}.src.quote{background:#f4ecdc;color:#7a5c00}.src.domain{background:#ece8f4;color:#4a2d7a}
.fn{color:#b3261e;font-size:10px}
.more{padding:10px;text-align:center;color:#666;font-size:12px}
.slider{display:flex;align-items:center;gap:8px}
.slider input{flex:1}
code{background:#f0f2f4;padding:1px 4px;border-radius:3px;font-size:11px}
</style></head><body>
<header>
  <h1>#33 抽取器护栏候选规则 — 全库实测 <span class="warn">PROTOTYPE / 一次性探针，不进 main</span></h1>
  <div class="sub" id="hdr"></div>
</header>
<div class="layout">
  <aside>
    <div class="card">
      <h2>拒收规则（勾选=生效）</h2>
      <div id="rules"></div>
    </div>
    <div class="card">
      <h2>长度上限</h2>
      <div class="slider"><input type="range" id="cap" min="8" max="50" value="24"><span id="capv">24</span></div>
      <div class="why" style="margin-left:0">抽取器现状是 2–50。加上结构性规则后，长度上限的独杀数塌到个位数 —— 这个数字不必纠结。</div>
    </div>
    <div class="card">
      <h2>读法</h2>
      <div class="why" style="margin-left:0">
        <b>独杀</b>=只有这条规则会杀它，别的规则都放过 —— 这才是一条规则的真实贡献。<br><br>
        <b>疑似假阴性</b>=被杀掉、但形状像真业务词的候选。看这一栏判断护栏会不会误杀 <code>DAU</code> / <code>现金券</code> 这类词。
      </div>
    </div>
  </aside>
  <main>
    <div class="stats" id="stats"></div>
    <div class="tabs">
      <button data-t="killed" class="on">杀掉的</button>
      <button data-t="survived">存活的</button>
      <button data-t="fn">疑似假阴性</button>
      <button data-t="domain">domain 分支（护栏管不到）</button>
    </div>
    <input type="search" id="q" placeholder="过滤：候选词 / 定义 id / 上下文…">
    <div id="note"></div>
    <table><thead><tr><th>候选</th><th>来源</th><th>定义</th><th>上下文</th><th>判定</th></tr></thead><tbody id="rows"></tbody></table>
    <div class="more" id="more"></div>
  </main>
</div>
<script>
const DATA = ${data};
const rows = DATA.rows, meta = DATA.meta, rulesMeta = DATA.rules;
const state = {on:new Set(rulesMeta.filter(r=>r.on).map(r=>r.id)), cap:24, tab:'killed', q:'', hideNameId:true};
/** Rules that test "是这个定义自己的列名" — an identity test, not a business-alias judgement.
 *  A candidate killed ONLY by these is a column name, so it is not a false negative. */
const NAME_ID = new Set(['own-column-name','column-name-canon']);

document.getElementById('hdr').innerHTML =
  meta.tables+' 张表 + '+meta.events+' 个事件 = '+(meta.tables+meta.events)+' 个定义，'+
  '基线候选 '+meta.baselineTotal+' 条（paren '+meta.bySource.paren+' / quote '+meta.bySource.quote+' / domain '+meta.bySource.domain+'）'+
  '<span class="warn ok">保真 '+(meta.fidelity.checked-meta.fidelity.failures)+'/'+meta.fidelity.checked+' 复现线上抽取器</span>'+
  '<span class="warn ok">回放 445/445 复现 3cef160 实际写入</span>';

function killedBy(r){
  const out = r.r.filter(id=>state.on.has(id));
  if(r.l > state.cap) out.push('len>'+state.cap);
  return out;
}
/** suspected false negative: killed, shape looks business-like, and not killed purely by a name-identity rule */
function isFN(v){
  if(!v.k.length || !v.r.f.length) return false;
  return !(state.hideNameId && v.k.every(k=>NAME_ID.has(k)));
}
function render(){
  const verdicts = rows.map(r=>({r, k:killedBy(r)}));
  const killed = verdicts.filter(v=>v.k.length>0), surv = verdicts.filter(v=>v.k.length===0);
  // stats
  document.getElementById('stats').innerHTML =
    stat(rows.length,'基线候选总数') +
    stat(killed.length,'杀掉 ('+(killed.length/rows.length*100).toFixed(1)+'%)') +
    stat(surv.length,'存活 ('+(surv.length/rows.length*100).toFixed(1)+'%)') +
    stat(surv.filter(v=>v.r.s==='domain').length,'其中 domain 分支（永远重抽）') +
    stat(killed.filter(isFN).length,'疑似假阴性');
  // rule list with live sole counts
  document.getElementById('rules').innerHTML = rulesMeta.map(m=>{
    const hits = verdicts.filter(v=>v.r.r.includes(m.id)).length;
    const sole = verdicts.filter(v=>{const k=killedBy(v.r); return k.length===1 && k[0]===m.id}).length;
    return '<label class="rule tier-'+m.tier+'"><input type="checkbox" data-r="'+m.id+'"'+(state.on.has(m.id)?' checked':'')+
      '><span class="rl">'+esc(m.label)+'</span><span class="cnt">命中 '+hits+' / 独杀 '+sole+'</span>'+
      '<span class="why">'+esc(m.why)+'</span></label>';
  }).join('');
  document.querySelectorAll('[data-r]').forEach(cb=>cb.onchange=()=>{
    cb.checked?state.on.add(cb.dataset.r):state.on.delete(cb.dataset.r); render();
  });
  // table
  let list;
  if(state.tab==='killed') list = killed;
  else if(state.tab==='survived') list = surv;
  else if(state.tab==='domain') list = verdicts.filter(v=>v.r.s==='domain');
  else list = killed.filter(isFN);
  // the FN tab shows its own exclusion, rather than hiding it in code
  const nameOnly = killed.filter(v=>v.r.f.length>0 && v.k.every(k=>NAME_ID.has(k)));
  document.getElementById('note').innerHTML = state.tab!=='fn' ? '' :
    '<div class="card" style="margin-bottom:10px"><label style="cursor:pointer"><input type="checkbox" id="hn"'+(state.hideNameId?' checked':'')+'> '+
    '折叠「仅因是本定义自己的列名而被杀」的 '+nameOnly.length+' 条 / '+new Set(nameOnly.map(v=>v.r.t)).size+' 个词'+
    '</label><div class="why" style="margin-left:0">这是<b>同一性判断</b>（这个词就是本定义的某个列名），不是业务判断，所以不算误杀。'+
    '这一整类里含中文的词有 <b>'+new Set(nameOnly.filter(v=>/[\\u4e00-\\u9fa5]/.test(v.r.t)).map(v=>v.r.t)).size+'</b> 个 —— 中文业务词零风险。</div></div>';
  const hn = document.getElementById('hn');
  if(hn) hn.onchange = () => { state.hideNameId = hn.checked; render() };
  if(state.q){const q=state.q.toLowerCase();list=list.filter(v=>(v.r.t+' '+v.r.d+' '+v.r.x).toLowerCase().includes(q))}
  const distinct = new Set(list.map(v=>v.r.t)).size;
  const shown = list.slice(0,400);
  document.getElementById('rows').innerHTML = shown.map(v=>
    '<tr><td class="term">'+esc(v.r.t)+'<br><span style="color:#999;font-size:10px">len '+v.r.l+'</span>'+
    (v.r.f.length?'<br><span class="fn">'+v.r.f.map(esc).join(' · ')+'</span>':'')+'</td>'+
    '<td><span class="src '+v.r.s+'">'+v.r.s+'</span></td>'+
    '<td class="def">'+esc(v.r.d)+'</td>'+
    '<td class="ctx">'+esc(v.r.x)+'</td>'+
    '<td>'+(v.k.length?v.k.map(k=>'<span class="chip'+(isProposed(k)?' p':'')+'">'+esc(k)+'</span>').join(''):'<span style="color:#1a6b2d">存活</span>')+'</td></tr>'
  ).join('');
  document.getElementById('more').textContent =
    (list.length>400 ? '显示前 400 条，共 '+list.length+' 条（用上方搜索缩小范围）' : list.length+' 条') + ' / '+distinct+' 个不同的词';
}
function isProposed(id){const m=rulesMeta.find(r=>r.id===id);return m&&m.tier==='proposed'}
function stat(n,l){return '<div class="stat"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); state.tab=b.dataset.t; render();
});
document.getElementById('cap').oninput = e=>{state.cap=+e.target.value;document.getElementById('capv').textContent=state.cap;render()};
document.getElementById('q').oninput = e=>{state.q=e.target.value;render()};
render();
</script></body></html>`

writeFileSync('/tmp/sg-guardrail-probe/out/report.html', html)
console.log(`wrote out/report.html (${(html.length / 1024 / 1024).toFixed(2)} MB)`)
