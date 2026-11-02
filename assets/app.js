/* ============================================================
   家卫老师 L3 作业在线 —— 核心逻辑
   ============================================================ */

const LS_KEY = 'jw_l3_v1';
let DATA = null;          // 题目库
let curTopic = null;      // 当前专题
let curQIdx = 0;          // 当前题在全专题的序号
let flat = [];            // 当前专题的扁平题目列表
let answers = {};         // { qKey: [输入值...] }
let strokes = {};         // { qKey: [点数组...] }  手写笔迹
let mode = 'view';        // view | practice | result
let t0 = 0;               // 进入时间戳

/* ---------- 工具 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function esc(s){
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/** 答案规范化：全角→半角、去空格去逗号、忽略末尾句号、数字统一 */
function normAnswer(s){
  let t = String(s == null ? '' : s).trim();
  // 全角 → 半角
  t = t.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/　/g, ' ');
  t = t.replace(/\s+/g, '').replace(/,/g, '').replace(/，/g, '');
  t = t.replace(/[。.]$/, '');
  // 数值统一：2400.0 → 2400 ; 0.50 → 0.5
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (!isNaN(n)) return String(n);
  }
  return t;
}

/** 从答案串里取出数值部分（"长13厘米" → "13"） */
function extractValue(s){
  const t = normAnswer(s);
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : t;
}

/** 判一题：返回 {correct, perBlank:[bool]} */
function judge(q, userInputs){
  const blanks = q.blanks || [];
  if (!blanks.length) return {correct:false, perBlank:[], special:true};

  const perBlank = blanks.map((b, i) => {
    const u = userInputs[i];
    if (u === undefined || u === null || String(u).trim() === '') return false;
    const un = normAnswer(u);
    const an = normAnswer(b.value);
    // 数值比较优先
    const unNum = extractValue(un), anNum = extractValue(an);
    const unIsNum = /^-?\d+(\.\d+)?$/.test(unNum);
    const anIsNum = /^-?\d+(\.\d+)?$/.test(anNum);
    if (unIsNum && anIsNum) {
      return Math.abs(parseFloat(unNum) - parseFloat(anNum)) < 1e-9;
    }
    return un === an;
  });
  return {correct: perBlank.every(Boolean), perBlank};
}

/* ---------- 存储 ---------- */
function saveState(){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      topic: curTopic, idx: curQIdx, answers, strokes, mode
    }));
  }catch(e){}
}
function loadState(){
  try{
    const d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    return d && d.answers ? d : null;
  }catch(e){ return null; }
}
function clearState(){
  try{ localStorage.removeItem(LS_KEY); }catch(e){}
}

/* ---------- 题目扁平化 ---------- */
function flatten(topic){
  const list = [];
  topic.steps.forEach(s => {
    s.groups.forEach(g => {
      g.questions.forEach(q => {
        list.push({
          step: s, group: g, q,
          key: `${topic.id}|${s.no}|${g.no}|${q.no}`,
          idxInStep: list.length
        });
      });
    });
  });
  return list;
}

/* ---------- 渲染：起始页 ---------- */
function renderHome(){
  mode = 'view';
  $('#screen').innerHTML = `
    <div class="hero">
      <h2>家卫老师小学数学 L3 · 在线作业</h2>
      <div class="sub">${DATA.topics.length} 个专题 · ${DATA.stats.totalQuestions} 道题 · 不用打印，做完自动判分</div>

      <div class="howto">
        <h4>📌 怎么用</h4>
        <ol>
          <li>选一个专题 → 点「开始做」</li>
          <li>每题下面有一块<b>手写板</b>：iPad 用 Apple Pencil（手指也行）写推导过程</li>
          <li>写完在<b>答案框</b>填数字 → 系统<b>自动判分</b>，对错立刻显示</li>
          <li>进度自动保存，下次接着做</li>
        </ol>
      </div>

      <div class="stats">
        <div class="stat"><b>${DATA.stats.totalQuestions}</b><span>总题数</span></div>
        <div class="stat"><b>${DATA.topics.length}</b><span>专题</span></div>
        <div class="stat"><b>${DATA.stats.multiBlank}</b><span>多空题</span></div>
        <div class="stat"><b>${DATA.stats.totalSteps}</b><span>台阶</span></div>
      </div>

      <input class="tsrch" id="tsearch" placeholder="🔍 搜索专题名..." oninput="filterTopics(this.value)">
      <div class="tgrid" id="tgrid"></div>
    </div>`;
  renderTopicCards('');
}

function filterTopics(q){
  const kw = (q||'').trim().toLowerCase();
  renderTopicCards(kw);
}

function renderTopicCards(kw){
  const grid = $('#tgrid');
  if(!grid) return;
  const st = loadState();
  grid.innerHTML = DATA.topics.filter(t =>
    !kw || t.name.toLowerCase().includes(kw) || (t.title||'').toLowerCase().includes(kw)
  ).map(t => {
    const done = st && st.topic === t.id;
    const pct = done ? (Object.keys(st.answers||{}).filter(k=>k.startsWith(t.id+'|') &&
      (st.answers[k]||[]).some(v=>String(v).trim()!=='')).length / t.stats.questions * 100) : 0;
    return `<button class="tcard ${done?'done':''}" onclick="openTopic('${t.id}')">
      ${done && pct>0 ? `<span class="pg">${Math.round(pct)}%</span>` : ''}
      <div class="nm">${esc(t.name)}</div>
      <div class="mt">${t.stats.questions} 题 · ${t.stats.steps} 台阶 · ${t.stats.groups} 组</div>
    </button>`;
  }).join('') || '<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:30px">没有匹配的专题</div>';
}

/* ---------- 渲染：答题页 ---------- */
function openTopic(id){
  const t = DATA.topics.find(x => x.id === id);
  if(!t) return;
  curTopic = t;
  flat = flatten(t);

  const st = loadState();
  if(st && st.topic === id){
    answers = st.answers || {};
    strokes = st.strokes || {};
    curQIdx = st.idx || 0;
  }else{
    answers = {}; strokes = {}; curQIdx = 0;
  }
  mode = 'practice';
  t0 = Date.now();
  renderPractice();
  saveState();
}

function renderPractice(){
  const t = curTopic;
  const cur = flat[curQIdx];
  const answered = flat.filter(f => {
    const a = answers[f.key];
    return a && a.some(v => String(v||'').trim() !== '');
  }).length;

  $('#screen').innerHTML = `
    <div class="qhead">
      <div class="tt">${esc(t.name)}</div>
      <div>
        <span class="chip c-step">台阶 ${esc(cur.step.no)} · ${esc(cur.step.name)}</span>
        <span class="chip c-group">第 ${esc(cur.group.no)} 组</span>
        <span class="chip c-idx" style="color:#334155;background:#e2e8f0">第 ${curQIdx+1} / ${flat.length} 题</span>
      </div>
      <div class="qnav">
        <button onclick="goQ(${curQIdx-1})" ${curQIdx===0?'disabled':''}>← 上一题</button>
        <button onclick="goQ(${curQIdx+1})" ${curQIdx===flat.length-1?'disabled':''}>下一题 →</button>
        <button class="primary" onclick="finishPractice()">交卷看结果</button>
      </div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:13.5px;color:#1e40af;font-weight:700">
          已完成 ${answered} / ${flat.length} 题（${Math.round(answered/flat.length*100)}%）
        </span>
        <span style="flex:1;min-width:100px;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden">
          <i style="display:block;height:100%;width:${answered/flat.length*100}%;background:#16a34a;transition:width .3s"></i>
        </span>
        <button onclick="confirmReset()" style="background:none;border:0;color:#94a3b8;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:underline">清空本专题</button>
      </div>
    </div>
    <div id="qlist"></div>`;

  $('#qlist').innerHTML = flat.map((f,i) => renderCard(f, i)).join('');
  // 初始化所有画布
  flat.forEach((f,i) => initPad(f, i));
  scrollToCur();
  updateProgress();
}

function renderCard(f, i){
  const q = f.q;
  const cur = i === curQIdx;
  const ans = answers[f.key] || [];
  const blanks = q.blanks || [];
  const j = q.answer !== undefined ? judge(q, ans) : null;

  let ansHTML;
  if(!blanks.length){
    ansHTML = `<div class="special">📷 这题是「涂色/看图」题，答案在图上。<br>
      <span style="font-size:12.5px">请对照老师发的原 PDF 完成，做完点下一题。</span></div>`;
  }else{
    ansHTML = `<div class="answers">
      <div class="ttl">✏️ 填写答案${blanks.length>1?`（本题 ${blanks.length} 个空）`:''}</div>
      ${blanks.map((b,k)=>{
        const v = ans[k] || '';
        let cls = '', st = '';
        if(j && String(v).trim()!==''){
          if(j.perBlank[k]){ cls='ok'; st=`<span class="s ok">✓</span>`; }
          else { cls='no'; st=`<span class="s no">✗</span>`; }
        }
        const lbl = b.label ? b.label : (blanks.length>1 ? `空${k+1}` : '');
        return `<div class="abl">
          ${lbl?`<span class="lbl">${esc(lbl)}</span>`:''}
          <input type="text" inputmode="decimal" value="${esc(v)}" class="${cls}"
            placeholder="?" oninput="onAns('${f.key}',${k},this.value)">
          ${b.unit?`<span class="u">${esc(b.unit)}</span>`:''}
          ${st}
        </div>`;
      }).join('')}
    </div>`;
  }

  const cls = j ? (j.correct ? 'answered' : 'wrong') : '';

  return `<div class="qcard ${cls} ${cur?'current':''}" id="card-${i}">
    <div class="qnum">${q.no}</div>
    <div class="qtext">${formatQ(q.text)}</div>
    <div class="paper">
      <div class="lbl">
        <b>✍️ 写过程（手写板）</b>
        <span>虚线框内书写 · 下方可切换颜色、撤销</span>
      </div>
      <div class="pad" id="padwrap-${i}">
        <canvas id="pad-${i}"></canvas>
        <div class="ph">在这里写计算过程（支持手指 / Apple Pencil）</div>
      </div>
      <div class="padtools">
        <div class="swatch">
          <button class="on" data-c="#1e293b" data-i="${i}" style="background:#1e293b" onclick="setColor(this)"></button>
          <button data-c="#dc2626" data-i="${i}" style="background:#dc2626" onclick="setColor(this)"></button>
          <button data-c="#2563eb" data-i="${i}" style="background:#2563eb" onclick="setColor(this)"></button>
        </div>
        <button onclick="undoStroke(${i})">↩ 撤销</button>
        <button class="clr" onclick="clearPad(${i})">✕ 清空</button>
        ${q.answer!==undefined && j && !j.correct ? `<button onclick="showAns('${f.key}')">💡 看答案</button>`:''}
      </div>
    </div>
    ${ansHTML}
  </div>`;
}

/** 题干格式化：数字加粗上色 */
function formatQ(t){
  return esc(t)
    .replace(/(\d+(?:\.\d+)?)/g, '<span class="num">$1</span>')
    .replace(/(厘米|分米|毫米|千米|米|平方米|平方厘米|平方分米|元|角|岁|个|人|天|小时|分钟|次|倍|千米\/小时|米\/秒|克|千克|吨)(?!<)/g,
             '<span class="unit">$1</span>');
}

/* ---------- 手写画布 ---------- */
let padState = {};   // { i: {color, drawing, last} }

function initPad(f, i){
  const cv = document.getElementById('pad-'+i);
  if(!cv) return;
  const wrap = document.getElementById('padwrap-'+i);
  const dpr = window.devicePixelRatio || 1;

  function resize(){
    const w = wrap.clientWidth;
    const h = Math.max(150, Math.min(320, Math.round(w * 0.42)));
    cv.style.height = h + 'px';
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    redraw(i, ctx, w, h);
  }

  padState[i] = {color:'#1e293b', drawing:false, last:null, w:0, h:0};
  resize();
  window.addEventListener('resize', () => {
    const c2 = document.getElementById('pad-'+i);
    if(c2 && padState[i]){ const w=c2.clientWidth; const h=Math.max(150,Math.min(320,Math.round(w*0.42)));
      c2.style.height=h+'px'; c2.width=Math.round(w*dpr); c2.height=Math.round(h*dpr);
      const ctx=c2.getContext('2d'); ctx.scale(dpr,dpr); redraw(i,ctx,w,h); }
  });

  function pos(e){
    const r = cv.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return {x: src.clientX - r.left, y: src.clientY - r.top};
  }

  function start(e){
    e.preventDefault();
    const st = padState[i];
    st.drawing = true; st.last = pos(e);
    strokes[f.key] = strokes[f.key] || [];
    strokes[f.key].push({color: st.color, pts:[st.last]});
    wrap.classList.add('has');
  }
  function move(e){
    if(!padState[i] || !padState[i].drawing) return;
    e.preventDefault();
    const st = padState[i];
    const p = pos(e);
    const arr = strokes[f.key];
    if(!arr || !arr.length) return;
    arr[arr.length-1].pts.push(p);
    const ctx = cv.getContext('2d');
    ctx.strokeStyle = st.color;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    const pts = arr[arr.length-1].pts;
    ctx.moveTo(pts[0].x, pts[0].y);
    for(let k=1;k<pts.length;k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.stroke();
  }
  function end(){
    if(padState[i]) padState[i].drawing = false;
    saveState();
  }

  cv.addEventListener('pointerdown', start);
  cv.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  cv.addEventListener('touchstart', start, {passive:false});
  cv.addEventListener('touchmove', move, {passive:false});
  cv.addEventListener('touchend', end);
}

function redraw(i, ctx, w, h){
  ctx.clearRect(0,0,w,h);
  const f = flat[i];
  if(!f) return;
  const arr = strokes[f.key] || [];
  arr.forEach(st => {
    ctx.strokeStyle = st.color; ctx.lineWidth = 2.4;
    ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.beginPath();
    st.pts.forEach((p,k)=> k===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
    if(st.pts.length===1) ctx.arc(st.pts[0].x, st.pts[0].y, 1.2, 0, Math.PI*2);
    ctx.stroke();
  });
  if(arr.length) document.getElementById('padwrap-'+i)?.classList.add('has');
}

function setColor(btn){
  const i = btn.dataset.i;
  if(padState[i]) padState[i].color = btn.dataset.c;
  btn.parentElement.querySelectorAll('button').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}

function undoStroke(i){
  const f = flat[i]; if(!f) return;
  const arr = strokes[f.key]; if(!arr || !arr.length) return;
  arr.pop();
  const cv = document.getElementById('pad-'+i);
  const wrap = document.getElementById('padwrap-'+i);
  if(arr.length===0) wrap?.classList.remove('has');
  const st = padState[i];
  const ctx = cv.getContext('2d');
  ctx.clearRect(0,0,cv.width,cv.height);
  redraw(i, ctx, st.w||cv.clientWidth, st.h||cv.clientHeight);
  saveState();
}

function clearPad(i){
  const f = flat[i]; if(!f) return;
  strokes[f.key] = [];
  const cv = document.getElementById('pad-'+i);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0,0,cv.width,cv.height);
  document.getElementById('padwrap-'+i)?.classList.remove('has');
  saveState();
}

/* ---------- 作答交互 ---------- */
function onAns(key, k, val){
  answers[key] = answers[key] || [];
  answers[key][k] = val;
  saveState();
  // 局部刷新该题卡片
  const i = flat.findIndex(f => f.key === key);
  if(i < 0) return;
  const card = document.getElementById('card-'+i);
  if(!card) return;
  const f = flat[i];
  const j = judge(f.q, answers[key]);
  const blanks = f.q.blanks || [];
  card.querySelectorAll('.abl input')[k].className =
    String(val).trim()==='' ? '' : (j.perBlank[k] ? 'ok' : 'no');
  const stEl = card.querySelectorAll('.abl .s')[k];
  if(stEl){ stEl.textContent = j.perBlank[k] ? '✓' : '✗';
    stEl.className = 's ' + (j.perBlank[k]?'ok':'no'); }
  card.classList.toggle('answered', j.correct);
  card.classList.toggle('wrong', !j.correct && String(val).trim()!=='');
  updateProgress();
}

function goQ(i){
  if(i < 0 || i >= flat.length) return;
  curQIdx = i;
  saveState();
  const cards = $$('.qcard');
  cards.forEach(c => c.classList.remove('current'));
  const c = document.getElementById('card-'+i);
  if(c) c.classList.add('current');
  scrollToCur();
}

function scrollToCur(){
  setTimeout(()=>{
    const c = document.getElementById('card-'+curQIdx);
    if(c) c.scrollIntoView({behavior:'smooth', block:'start'});
  }, 60);
}

function updateProgress(){
  const answered = flat.filter(f => {
    const a = answers[f.key];
    return a && a.some(v => String(v||'').trim() !== '');
  }).length;
  const p = $('#progfill');
  if(p) p.style.width = (answered/flat.length*100)+'%';
  const t = $('#progtxt');
  if(t) t.textContent = `${answered}/${flat.length}`;
}

function showAns(key){
  const f = flat.find(x=>x.key===key);
  if(!f) return;
  const b = (f.q.blanks||[]).map(x=>x.value + (x.unit||'')).join(' , ');
  alert(`参考答案：${b}`);
}

function confirmReset(){
  if(!confirm('清空本专题的所有答案和笔迹？')) return;
  answers = {}; strokes = {}; curQIdx = 0;
  saveState(); renderPractice();
}

/* ---------- 交卷 ---------- */
function finishPractice(){
  const unanswered = flat.filter(f => {
    const a = answers[f.key];
    return !(a && a.some(v => String(v||'').trim() !== ''));
  }).length;
  const msg = unanswered
    ? `还有 ${unanswered} 题没做，确定交卷吗？`
    : '确定交卷看结果吗？';
  if(!confirm(msg)) return;
  mode = 'result';
  saveState();
  renderResult();
}

function renderResult(){
  let right = 0, judgeable = 0, wrong = [], total = 0;
  flat.forEach((f,i) => {
    const q = f.q;
    const a = answers[f.key] || [];
    const hasAns = a.some(v => String(v||'').trim() !== '');
    total++;
    if(!q.blanks || !q.blanks.length){
      if(hasAns) judgeable++;   // 涂色题不判对错
      return;
    }
    const j = judge(q, a);
    judgeable++;
    if(j.correct) right++;
    else wrong.push({f, i, j, user:a});
  });

  const rate = judgeable ? Math.round(right/judgeable*100) : 0;
  let lv, lvc;
  if(rate>=95){ lv='🏆 完美！几乎全对'; lvc='#16a34a'; }
  else if(rate>=80){ lv='👍 很好，继续保持'; lvc='#2563eb'; }
  else if(rate>=60){ lv='💪 及格，错题要复盘'; lvc='#ea580c'; }
  else { lv='📖 先把错题搞懂，别急着做新题'; lvc='#dc2626'; }

  $('#screen').innerHTML = `
    <div class="score">
      <div class="big">${right}<span> / ${judgeable}</span></div>
      <div class="of">正确率 ${rate}% · 用时 ${Math.max(1,Math.round((Date.now()-t0)/60000))} 分钟</div>
      <div class="lv" style="background:${lvc}55">${lv}</div>
    </div>

    <div class="card">
      <h3>📋 本次小结</h3>
      <div class="stats" style="margin:0">
        <div class="stat"><b>${total}</b><span>总题数</span></div>
        <div class="stat"><b style="color:#16a34a">${right}</b><span>做对</span></div>
        <div class="stat"><b style="color:#dc2626">${wrong.length}</b><span>做错</span></div>
        <div class="stat"><b>${rate}%</b><span>正确率</span></div>
      </div>
      <div class="qnav" style="margin-top:14px">
        <button onclick="backHome()">← 回到专题列表</button>
        <button class="primary" onclick="redoTopic()">再做一遍</button>
      </div>
    </div>

    <div class="card">
      <h3>❌ 错题本（${wrong.length}）</h3>
      ${wrong.length ? `<div class="wronglist">${wrong.map(w=>`
        <div class="witem">
          <div class="widx">台阶 ${esc(w.f.step.no)} · ${esc(w.f.step.name)} · 第 ${esc(w.f.group.no)} 组 · 第 ${w.f.q.no} 题</div>
          <div class="q">${formatQ(w.f.q.text)}</div>
          <div class="ans">✓ 正确答案：${esc((w.f.q.blanks||[]).map(b=>b.value+(b.unit||'')).join(' , '))}</div>
          <div class="mine">✗ 板栗写的：${esc((w.user||[]).map(v=>String(v||'').trim()||'（空）').join(' , '))}</div>
        </div>`).join('')}</div>`
      : `<div class="okall">🎉 全部做对，太棒了！</div>`}
    </div>`;

  updateProgress();
  window.scrollTo(0,0);
}

function redoTopic(){
  answers = {}; strokes = {}; curQIdx = 0;
  mode = 'practice'; t0 = Date.now();
  saveState(); renderPractice();
}

function backHome(){
  saveState();
  renderHome();
}
