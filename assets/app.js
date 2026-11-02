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
/* ============================================================
   存储：答案/进度 → localStorage（轻量）
        笔迹       → IndexedDB（配额大，几十~几百MB）
   ⚠️ 实测本机 localStorage 已被其它应用占满 5112KB（可写 0MB），
      所以笔迹绝不能放 localStorage。
   ============================================================ */
const DB_NAME = 'jw_l3_strokes';
const DB_STORE = 'strokes';
let _db = null;

function openDB(){
  if(_db) return Promise.resolve(_db);
  return new Promise((resolve, reject)=>{
    if(!window.indexedDB){ reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(DB_STORE))
        db.createObjectStore(DB_STORE, {keyPath:'key'});
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
  });
}

function idbSet(key, val){
  return openDB().then(db => new Promise((resolve, reject)=>{
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put({key, val});
    tx.oncomplete = () => resolve(true);
    tx.onerror = e => reject(e.target.error);
  })).catch(()=>false);
}

function idbGet(key){
  return openDB().then(db => new Promise((resolve, reject)=>{
    const tx = db.transaction(DB_STORE, 'readonly');
    const r = tx.objectStore(DB_STORE).get(key);
    r.onsuccess = () => resolve(r.result ? r.result.val : null);
    r.onerror = e => reject(e.target.error);
  })).catch(()=>null);
}

function idbClear(){
  return openDB().then(db => new Promise(resolve=>{
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  })).catch(()=>false);
}

let _strokesDirty = false;
function saveState(){
  // ① 轻量状态 → localStorage（答案 + 进度，不含笔迹）
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      topic: curTopic, idx: curQIdx, answers, mode, ts: Date.now()
    }));
  }catch(e){
    // localStorage 满了 → 答案也存不下，只能提示
    if(!window.__lsWarned){ window.__lsWarned = 1; toast('浏览器存储已满，进度可能无法保存'); }
  }
  // ② 笔迹 → IndexedDB（延迟合并写）
  if(_strokesDirty){
    _strokesDirty = false;
    idbSet('strokes', strokes).then(ok=>{
      if(!ok && !window.__idbWarned){ window.__idbWarned = 1;
        toast('笔迹保存失败（刷新会丢失草稿）'); }
    });
  }
}

/** 轻提示 */
function toast(msg){
  let t = document.getElementById('__toast');
  if(!t){
    t = document.createElement('div');
    t.id = '__toast';
    t.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);'
      + 'background:#1e293b;color:#fff;padding:11px 20px;border-radius:11px;'
      + 'font-size:13.5px;z-index:999;box-shadow:0 4px 16px rgba(0,0,0,.22);max-width:88vw;text-align:center';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t.__timer);
  t.__timer = setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .3s'; }, 3200);
}
function loadState(){
  try{
    const d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    return d && d.answers ? d : null;
  }catch(e){ return null; }
}
function clearState(){
  try{ localStorage.removeItem(LS_KEY); }catch(e){}
  idbClear();
}
/** 从 IndexedDB 恢复笔迹（异步） */
function restoreStrokes(){
  return idbGet('strokes').then(v=>{
    if(v && typeof v === 'object'){ strokes = v; return true; }
    return false;
  }).catch(()=>false);
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
  // 首页不显示进度条和返回按钮
  const tp = document.getElementById('topprog'); if(tp) tp.style.display='none';
  const pt = document.getElementById('progtxt'); if(pt) pt.textContent='';
  const bb = document.getElementById('backbtn'); if(bb) bb.style.display='none';
  $('#screen').innerHTML = `
    <div class="hero">
      <h2>家卫老师小学数学 L3 · 在线作业</h2>
      <div class="sub">${DATA.topics.length} 个专题 · ${DATA.stats.totalQuestions} 道题 · 不用打印，做完自动判分</div>

      <details class="howto" id="howtoBox">
        <summary>📌 第一次用？点这里看操作说明</summary>
        <ol>
          <li>选一个专题 → 点「开始做」</li>
          <li>在每题的<b>手写板</b>写推导过程（iPad 用 Apple Pencil，手指也行）</li>
          <li>在<b>答案框</b>填最终答案 → 系统<b>立即判分</b>，对错马上显示</li>
          <li>多空题按题目里空格的顺序填，比如「长13厘米,宽7厘米」就填 13 和 7</li>
          <li>进度自动保存，下次接着做</li>
        </ol>
      </details>

      <div class="pills">
        <span class="pill">${DATA.stats.totalQuestions} 道题</span>
        <span class="pill">${DATA.topics.length} 个专题</span>
        <span class="pill">${DATA.stats.multiBlank} 道多空题</span>
        <span class="pill">${DATA.stats.totalSteps} 个台阶</span>
      </div>

      <div class="listhead">
        <span>📚 选择专题</span>
        <input class="tsrch" id="tsearch" placeholder="🔍 搜索..." oninput="filterTopics(this.value)">
      </div>
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
      <div class="mt">${t.stats.questions} 题 · ${t.stats.steps} 个台阶 · ${t.stats.groups} 组</div>
      <div class="go">开始做 →</div>
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
    strokes = {};
    curQIdx = st.idx || 0;
  }else{
    answers = {}; strokes = {}; curQIdx = 0;
  }
  mode = 'practice';
  t0 = Date.now();
  renderPractice();
  saveState();
  // 从 IndexedDB 恢复笔迹（异步）
  restoreStrokes().then(ok=>{
    if(ok){ renderPractice(); }   // 重绘带笔迹的卡片
  });
}

function renderPractice(){
  const tp = document.getElementById('topprog'); if(tp) tp.style.display='';
  const bb = document.getElementById('backbtn'); if(bb) bb.style.display='';
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

/** 判分状态行：不用弹窗，直接在题目处显示 */
function verdictHTML(j, blanks, ans){
  if(!j) return `<span class="v-idle">填完答案，这里会立刻告诉你对不对</span>`;
  const filled = ans.map((v,i)=>String(v||'').trim()!=='');
  if(!filled.some(Boolean))
    return `<span class="v-idle">填完答案，这里会立刻告诉你对不对</span>`;

  const right = j.perBlank.every(Boolean);
  const allFilled = j.perBlank.length === filled.filter(Boolean).length;

  if(right){
    return `<span class="v-ok">✓ 答对了！${blanks.length>1?` ${blanks.length} 个空全对`:''}</span>`;
  }
  if(!allFilled){
    const miss = j.perBlank.map((ok,k)=>ok?null:k).filter(x=>x!==null);
    return `<span class="v-wait">还差 ${miss.length} 个空没填（${miss.map(k=>`第${k+1}空`).join('、')}）</span>`;
  }
  // 答错：逐空说明
  const detail = blanks.map((b,k)=>{
    const ok = j.perBlank[k];
    const mine = String(ans[k]||'').trim() || '（空）';
    return ok
      ? `<span class="v-item ok">第${k+1}空 ✓ ${esc(b.value)}${esc(b.unit||'')}</span>`
      : `<span class="v-item no">第${k+1}空 ✗ 你写「${esc(mine)}」· 正确「${esc(b.value)}${esc(b.unit||'')}」</span>`;
  }).join('');
  return `<span class="v-no">✗ 还不对</span><div class="v-detail">${detail}</div>`;
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
    const anyFilled = ans.some(v=>String(v||'').trim()!=='');
    ansHTML = `<div class="answers">
      <div class="ttl">✏️ 填写答案${blanks.length>1?`（本题 ${blanks.length} 个空，按顺序填）`:''}
        <span class="ttl-hint">👆 判分只看这里，填完立刻出结果</span></div>
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
      <div class="verdict" id="vd-${i}">${verdictHTML(j, blanks, ans)}</div>
    </div>`;
  }

  const cls = j ? (j.correct ? 'answered' : 'wrong') : '';

  return `<div class="qcard ${cls} ${cur?'current':''}" id="card-${i}">
    <div class="qnum">${q.no}</div>
    <div class="qtext">${formatQ(q.text)}</div>
    <div class="paper">
      <div class="lbl">
        <b>✍️ 草稿区 · 写推导过程</b>
        <span>只用来打草稿，<b>不对这里判分</b> · 判分看下面的答案框</span>
        <button class="fold" onclick="togglePad(${i})" id="fold-${i}">收起 ▲</button>
      </div>
      <div id="padbody-${i}">
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
        ${q.answer!==undefined ? `<button onclick="showAns('${f.key}')">💡 展开答案</button>`:''}
      </div>
      </div>
    </div>
    ${ansHTML}
    <div class="reveal" id="reveal-${i}" style="display:none"></div>
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
    const h = Math.max(110, Math.min(190, Math.round(w * 0.26)));
    cv.style.height = h + 'px';
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    redraw(i, ctx, w, h);
  }

  padState[i] = {color:'#1e293b', drawing:false, last:null, w:0, h:0};
  resize();
  padState[i].w = wrap.clientWidth;
  padState[i].h = parseInt(cv.style.height) || 150;
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
    _strokesDirty = true;
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

function togglePad(i){
  const body = document.getElementById('padbody-'+i);
  const btn = document.getElementById('fold-'+i);
  if(!body) return;
  const collapsed = body.style.display === 'none';
  body.style.display = collapsed ? '' : 'none';
  if(btn) btn.textContent = collapsed ? '收起 ▲' : '展开 ▼';
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
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.restore();
  redraw(i, ctx, st.w || cv.clientWidth, st.h || cv.clientHeight);
  _strokesDirty = true;
  saveState();
}

function clearPad(i){
  const f = flat[i]; if(!f) return;
  strokes[f.key] = [];
  const cv = document.getElementById('pad-'+i);
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.restore();
  document.getElementById('padwrap-'+i)?.classList.remove('has');
  _strokesDirty = true;
  saveState();
}

/* ---------- 作答交互 ---------- */
function onAns(key, k, val){
  answers[key] = answers[key] || [];
  answers[key][k] = val;
  saveState();
  // 局部刷新该题卡片（不整页重绘，避免打断输入）
  const i = flat.findIndex(f => f.key === key);
  if(i < 0) return;
  const card = document.getElementById('card-'+i);
  if(!card) return;
  const f = flat[i];
  const blanks = f.q.blanks || [];
  const j = judge(f.q, answers[key]);

  // 更新这个输入框的样式
  const inp = card.querySelectorAll('.abl input')[k];
  if(inp) inp.className = String(val).trim()==='' ? '' : (j.perBlank[k] ? 'ok' : 'no');
  const stEl = card.querySelectorAll('.abl .s')[k];
  if(stEl){ stEl.textContent = j.perBlank[k] ? '✓' : '✗';
    stEl.className = 's ' + (j.perBlank[k]?'ok':'no'); }

  // ★ 刷新题目处的判分状态行（不用弹窗）
  const vd = document.getElementById('vd-'+i);
  if(vd) vd.innerHTML = verdictHTML(j, blanks, answers[key]);

  card.classList.toggle('answered', j.correct);
  card.classList.toggle('wrong', !j.correct && answers[key].some(v=>String(v||'').trim()!==''));
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
  // 不弹窗，直接在题目下方展开答案
  const f = flat.find(x=>x.key===key);
  if(!f) return;
  const i = flat.indexOf(f);
  const box = document.getElementById('reveal-'+i);
  if(!box) return;
  if(box.style.display === 'block'){ box.style.display = 'none'; return; }
  const b = (f.q.blanks||[]).map(x=>(x.label?x.label+' ':'')+x.value + (x.unit||'')).join('　·　');
  box.innerHTML = `<b>参考答案：</b>${esc(b)}`;
  box.style.display = 'block';
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
  // 清掉 ?t= 参数，避免刷新又跳回专题
  try{ history.replaceState(null,'',location.pathname); }catch(e){}
  renderHome();
}
