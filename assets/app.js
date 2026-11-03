/* ============================================================
   家卫老师 L3 作业在线 —— 核心逻辑
   ============================================================ */

const LS_KEY = 'jw_l3_v1';
const MB_KEY = 'jw_l3_mistakes_v1';   // 错题本（独立键，不随「清空本专题」被清掉）
let DATA = null;          // 题目库
let curTopic = null;      // 当前专题（对象）
let curTopicId = '';      // 当前专题 id（字符串）—— submitted 按它隔离
let curQIdx = 0;          // 当前题在全专题的序号
let flat = [];            // 当前专题的扁平题目列表
let answers = {};         // { qKey: [输入值...] }
let strokes = {};         // { qKey: [点数组...] }  手写笔迹
let mode = 'view';        // view | practice | result
let t0 = 0;               // 进入时间戳
let submitted = {};       // { topicId: { qKey: true } }  已点过「提交」的题 -> 只有这些题才判分（按专题隔离）
let mistakeBook = {};     // { qKey: {addedAt, topic, step, group, qno, text, answer, myans, tries} }  长期错题本
let redoOnly = false;     // 错题重做模式：只显示错题本里的题

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
      topic: curTopicId, idx: curQIdx, answers, submitted, mode, ts: Date.now()
    }));
    saveMistakeBook();
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
/** 从全库题目反查一道题的完整信息（错题本重做时用） */
function findQuestionByKey(key){
  if(!DATA) return null;
  for(const t of DATA.topics){
    for(const st of t.steps){
      for(const g of st.groups){
        for(const q of g.questions){
          if(`${t.id}|${st.no}|${g.no}|${q.no}` === key){
            return {topic:t, step:st, group:g, q};
          }
        }
      }
    }
  }
  return null;
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

/** 错题本：独立于专题进度，跨专题长期保存 */
function loadMistakeBook(){
  try{
    const m = JSON.parse(localStorage.getItem(MB_KEY) || '{}');
    return (m && typeof m === 'object') ? m : {};
  }catch(e){ return {}; }
}
function saveMistakeBook(){
  try{ localStorage.setItem(MB_KEY, JSON.stringify(mistakeBook)); }
  catch(e){ if(!window.__mbWarned){ window.__mbWarned=1; toast('错题本保存失败（存储已满）'); } }
}
/** 加入错题本（可手动加入，也可交卷时自动收录） */
function addMistake(key, opts){
  const f = flat.find(x => x.key === key);
  if(!f) return;
  const q = f.q;
  const cur = mistakeBook[key] || {tries:0};
  mistakeBook[key] = {
    addedAt: cur.addedAt || Date.now(),
    updatedAt: Date.now(),
    topic: curTopicId,
    topicName: (curTopic && curTopic.name) || curTopicId,
    step: f.step.no, stepName: f.step.name,
    group: f.group.no,
    qno: q.no,
    text: q.text,
    answer: (q.blanks||[]).map(b=>(b.label?b.label+' ':'')+b.value+(b.unit||'')).join(' / '),
    blanks: q.blanks || [],
    myans: (opts && opts.myans) ? opts.myans : (answers[key]||[]).map(v=>String(v||'').trim()),
    tries: (cur.tries||0) + 1,
    manual: !!(opts && opts.manual)
  };
  saveMistakeBook();
}
function removeMistake(key){
  delete mistakeBook[key];
  saveMistakeBook();
}
function mistakeCount(){ return Object.keys(mistakeBook).length; }

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
  mistakeBook = loadMistakeBook();   // ★ 首页也要能看到错题本数量
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
          <li>在每题的<b>草稿区</b>写推导过程（iPad 用 Apple Pencil，手指也行）</li>
          <li>写错了可以<b>🩹 橡皮</b>擦掉、<b>↩ 撤销</b>回退一步、<b>↪ 重做</b>找回</li>
          <li>在<b>答案框</b>填最终答案 → 点<b>「提交答案」</b>才判对错</li>
          <li>判错的题<b>自动进错题本</b>，首页点「错题本」随时回来重做</li>
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

      <div class="mbentry" onclick="openMistakeBook()">
        <span class="mbicon">📕</span>
        <span class="mbtxt">错题本<b>${mistakeCount()} 题</b> · 之前做错的题，随时回来重做</span>
        <span class="mbgo">打开 →</span>
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
  curTopicId = t.id;
  flat = flatten(t);

  mistakeBook = loadMistakeBook();
  const st = loadState();
  // submitted 按专题隔离存, 切专题不清空
  if(st && st.submitted) submitted = st.submitted;
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
  if(!j) return `<span class="v-idle">填完答案后点「提交答案」，这里才会告诉你对不对</span>`;
  const filled = ans.map((v,i)=>String(v||'').trim()!=='');
  if(!filled.some(Boolean))
    return `<span class="v-idle">填完答案后点「提交答案」，这里才会告诉你对不对</span>`;

  const right = j.perBlank.every(Boolean);
  const emptyIdx = blanks.map((b,k)=>String(ans[k]||'').trim()===''?k:-1).filter(k=>k>=0);

  if(right){
    return `<span class="v-ok">✓ 答对了！${blanks.length>1?` ${blanks.length} 个空全对`:''}</span>`;
  }
  if(emptyIdx.length){
    return `<span class="v-wait">还差 ${emptyIdx.length} 个空没填（${emptyIdx.map(k=>`第${k+1}空`).join('、')}），填完再提交</span>`;
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
  // ★ 只有点过「提交」的题才判分；没提交的一律不显示对错
  const isSub = !!submitted[curTopicId]?.[f.key];
  const j = (q.answer !== undefined && isSub) ? judge(q, ans) : null;

  let ansHTML;
  if(!blanks.length){
    ansHTML = `<div class="special">📷 这题是「涂色/看图」题，答案在图上。<br>
      <span style="font-size:12.5px">请对照老师发的原 PDF 完成，做完点下一题。</span></div>`;
  }else{
    const anyFilled = ans.some(v=>String(v||'').trim()!=='');
    const inBook = !!mistakeBook[f.key];
    ansHTML = `<div class="answers">
      <div class="ttl">✏️ 填写答案${blanks.length>1?`（本题 ${blanks.length} 个空，按顺序填）`:''}
        <span class="ttl-hint">👆 填完点「提交」再判对错</span></div>
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
      <div class="subrow">
        <button class="submit ${isSub?'done':''}" onclick="submitAns('${f.key}')">
          ${isSub ? '↻ 重新提交' : '✓ 提交答案'}</button>
        <button class="madd ${inBook?'in':''}" onclick="toggleMistake('${f.key}')">
          ${inBook ? '📕 已在错题本' : '📕 加入错题本'}</button>
      </div>
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
        <div class="toolset">
          <button class="on" data-tool="pen" data-i="${i}" onclick="setTool(${i},'pen',this)">🖊 笔</button>
          <button data-tool="erase" data-i="${i}" onclick="setTool(${i},'erase',this)">🩹 橡皮</button>
          <button data-tool="stroke" data-i="${i}" onclick="setTool(${i},'stroke',this)">🗑 整笔擦</button>
        </div>
        <button onclick="undoStroke(${i})">↩ 撤销</button>
        <button onclick="redoStroke(${i})">↪ 重做</button>
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
let padState = {};   // { i: {color, drawing, last, mode} }
let startedByPointer = false;   // 本次笔画是否由 pointer 事件启动（防 touch 双触发）
let redoStack = {};  // { i: [被撤销的笔画...] }  支持「重做」

/* 擦除模式：
   'pen'     正常书写
   'erase'   像素级橡皮擦（手指划过的地方擦掉，像真橡皮）
   'stroke'  整笔擦（点到哪一笔就删掉那一整笔）
*/
const ERASE_R = 13;   // 橡皮半径(px)

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

  padState[i] = {color:'#1e293b', drawing:false, last:null, w:0, h:0, mode:'pen', erasing:false};
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
    startedByPointer = (e && e.type === 'pointerdown');
    const st = padState[i];
    const p = pos(e);
    st.drawing = true; st.last = p;
    strokes[f.key] = strokes[f.key] || [];

    if(st.mode === 'stroke'){
      // 整笔擦：找最近的一笔（非 erase 轨迹），整笔删掉
      const arr = strokes[f.key];
      let best=-1, bestD=1e9;
      arr.forEach((s2,k)=>{
        if(s2.erase) return;                       // 不单独删擦除轨迹
        const c = centroid(s2);
        const d = (c.x-p.x)*(c.x-p.x) + (c.y-p.y)*(c.y-p.y);
        if(d < bestD){ bestD = d; best = k; }
      });
      if(best >= 0 && bestD < 80*80){
        const removed = arr.splice(best,1)[0];
        redoStack[i] = redoStack[i] || [];
        redoStack[i].push(removed);
        // 整笔删了之后，之前盖在它上面的 erase 轨迹也不再有效 -> 全部清掉
        // （否则重画时会缺一块）
        for(let k=arr.length-1;k>=0;k--) if(arr[k].erase) arr.splice(k,1);
        if(!arr.length) document.getElementById('padwrap-'+i)?.classList.remove('has');
        redrawAll(i);
        _strokesDirty = true; saveState();
      }
      st.drawing = false;
      return;
    }

    if(st.mode === 'erase'){
      // 像素级橡皮擦：记一条 erase 轨迹，重绘时跳过
      strokes[f.key].push({erase:true, pts:[p]});
      st.erasing = true;
      wrap.classList.add('has');
      drawEraseSegment(i, null, p, p);
      return;
    }

    strokes[f.key].push({color: st.color, pts:[p]});
    wrap.classList.add('has');
  }
  function move(e){
    if(!padState[i] || !padState[i].drawing) return;
    e.preventDefault();
    const st = padState[i];
    const p = pos(e);
    const arr = strokes[f.key];
    if(!arr || !arr.length) return;

    if(st.mode === 'erase'){
      const last = arr[arr.length-1];
      const prev = last.pts[last.pts.length-1];
      last.pts.push(p);
      drawEraseSegment(i, prev, p);
      return;
    }

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

  // ★ 只用 Pointer Events —— 现代 iPad Safari/Chrome 都支持。
  //   之前同时绑了 touchstart/touchmove/touchend，真机上跟 pointer 事件
  //   双触发，导致笔画状态错乱、撤销/橡皮失效。现在 touch 只做兜底：
  //   仅当 pointerdown 没触发过（老旧 WebView）才接管。
  cv.addEventListener('pointerdown', start);
  cv.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  cv.addEventListener('touchstart', (e)=>{
    if(startedByPointer) return;
    e.preventDefault(); start(e);
  }, {passive:false});
  cv.addEventListener('touchmove', (e)=>{
    if(startedByPointer) return;
    e.preventDefault(); move(e);
  }, {passive:false});
  cv.addEventListener('touchend', (e)=>{
    if(startedByPointer) return;
    end(e);
  });
}

/** 一笔的重心（整笔擦定位用） */
function centroid(st){
  const pts = st.pts || [];
  if(!pts.length) return {x:0,y:0};
  let x=0,y=0;
  pts.forEach(p=>{ x+=p.x; y+=p.y; });
  return {x:x/pts.length, y:y/pts.length};
}

/** 画一段擦除轨迹（destination-out = 真擦像素） */
function drawEraseSegment(i, from, to){
  const f = flat[i]; if(!f) return;
  const cv = document.getElementById('pad-'+i); if(!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = 'rgba(0,0,0,1)';
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.lineWidth = ERASE_R*2;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if(from){ ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); }
  else { ctx.arc(to.x, to.y, ERASE_R, 0, Math.PI*2); ctx.fill(); }
  ctx.restore();
}

/** 全量重绘某题画布（含擦除轨迹） */
function redrawAll(i){
  const f = flat[i]; if(!f) return;
  const cv = document.getElementById('pad-'+i); if(!cv) return;
  const st = padState[i] || {};
  const w = st.w || cv.clientWidth, h = st.h || cv.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.restore();
  redraw(i, ctx, w, h);
}

function redraw(i, ctx, w, h){
  ctx.clearRect(0,0,w,h);
  const f = flat[i];
  if(!f) return;
  const arr = strokes[f.key] || [];
  arr.forEach(st => {
    if(st.erase){
      // 擦除轨迹：用 destination-out 擦
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = ERASE_R*2;
      ctx.lineCap='round'; ctx.lineJoin='round';
      const pts = st.pts || [];
      if(pts.length === 1){
        ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, ERASE_R, 0, Math.PI*2); ctx.fill();
      }else{
        ctx.beginPath();
        pts.forEach((p,k)=> k===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
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
  const removed = arr.pop();
  redoStack[i] = redoStack[i] || [];
  redoStack[i].push(removed);
  const wrap = document.getElementById('padwrap-'+i);
  if(arr.length===0) wrap?.classList.remove('has');
  redrawAll(i);
  _strokesDirty = true;
  saveState();
}

/** 重做（把撤销的那一笔放回去） */
function redoStroke(i){
  const f = flat[i]; if(!f) return;
  const rs = redoStack[i]; if(!rs || !rs.length) return;
  strokes[f.key] = strokes[f.key] || [];
  strokes[f.key].push(rs.pop());
  redrawAll(i);
  document.getElementById('padwrap-'+i)?.classList.add('has');
  _strokesDirty = true;
  saveState();
}

/** 切换工具模式：笔 / 像素橡皮 / 整笔橡皮 */
function setTool(i, mode, btn){
  const st = padState[i]; if(!st) return;
  st.mode = mode;
  const wrap = document.getElementById('padwrap-'+i);
  if(wrap) wrap.dataset.tool = mode;
  // 工具条按钮高亮
  btn?.parentElement?.querySelectorAll('button[data-tool]').forEach(b=>b.classList.remove('on'));
  btn?.classList.add('on');
  const cv = document.getElementById('pad-'+i);
  if(cv) cv.style.cursor = (mode === 'pen') ? 'crosshair' : 'cell';
}

function clearPad(i){
  const f = flat[i]; if(!f) return;
  strokes[f.key] = [];
  redoStack[i] = [];
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
  // ★ 填答案时【不判分】——只有点「提交」才判。
  //   但如果这题之前已经提交过，要实时把旧的判分标记撤掉（答案改了，状态就过期了）。
  const i = flat.findIndex(f => f.key === key);
  if(i < 0) return;
  const card = document.getElementById('card-'+i);
  if(!card) return;
  const f = flat[i];
  const blanks = f.q.blanks || [];

  if(submitted[curTopicId]?.[f.key]){
    // 已提交过 -> 改动答案 => 撤销判分状态，等重新提交
    delete submitted[curTopicId][f.key];
    const inp = card.querySelectorAll('.abl input')[k];
    if(inp) inp.className = '';
    const stEl = card.querySelectorAll('.abl .s')[k];
    if(stEl){ stEl.textContent=''; stEl.className='s'; }
    const vd = document.getElementById('vd-'+i);
    if(vd) vd.innerHTML = `<span class="v-idle">答案改了，点「提交答案」重新判</span>`;
    card.classList.remove('answered','wrong');
    const sbtn = card.querySelector('.submit');
    if(sbtn){ sbtn.textContent='✓ 提交答案'; sbtn.classList.remove('done'); }
    saveState();
  }
  updateProgress();
}

/** ★ 点「提交」才判分 */
function submitAns(key){
  const i = flat.findIndex(f => f.key === key);
  if(i < 0) return;
  const f = flat[i];
  const blanks = f.q.blanks || [];
  const ans = answers[key] || [];

  if(!blanks.length){ toast('这题是涂色/看图题，不用填答案'); return; }
  if(!ans.some(v=>String(v||'').trim()!=='')){ toast('先填答案再提交哦'); return; }
  // ★ 所有空都填了才能判分 —— 没填完不算错，不进错题本
  const unfilled = blanks.filter((b,k)=>String(ans[k]||'').trim()==='')
                     .map((b,k)=>blanks.indexOf(b)+1);
  if(unfilled.length){
    toast(`还有 ${unfilled.length} 个空没填（${unfilled.map(n=>'第'+n+'空').join('、')}），填完再提交`);
    return;
  }

  submitted[curTopicId] = submitted[curTopicId] || {};
  submitted[curTopicId][key] = true;
  saveState();

  const j = judge(f.q, ans);
  const card = document.getElementById('card-'+i);
  if(card){
    card.querySelectorAll('.abl input').forEach((inp,k)=>{
      const v = ans[k];
      if(inp && String(v||'').trim()!=='') inp.className = j.perBlank[k] ? 'ok' : 'no';
    });
    card.querySelectorAll('.abl .s').forEach((el,k)=>{
      if(String(ans[k]||'').trim()!==''){
        el.textContent = j.perBlank[k] ? '✓' : '✗';
        el.className = 's ' + (j.perBlank[k]?'ok':'no');
      }
    });
    const vd = document.getElementById('vd-'+i);
    if(vd) vd.innerHTML = verdictHTML(j, blanks, ans);
    card.classList.toggle('answered', j.correct);
    card.classList.toggle('wrong', !j.correct);
    const sbtn = card.querySelector('.submit');
    if(sbtn){ sbtn.textContent='↻ 重新提交'; sbtn.classList.add('done'); }
  }

  // ★ 判错 -> 自动进错题本
  if(!j.correct){
    addMistake(key, {myans: ans.map(v=>String(v||'').trim())});
    refreshMistakeBtns();
    toast('❌ 这题错了，已放进错题本');
  }else{
    // 做对了 -> 如果之前在错题本里，标记已订正（不移除，等板栗重做过再处理）
    const mb = mistakeBook[key];
    if(mb){ mb.fixedAt = Date.now(); mb.fixed = true; saveMistakeBook(); refreshMistakeBtns(); }
    toast('✅ 答对了！');
  }
  updateProgress();
}

/** 手动加入/移出错题本 */
function toggleMistake(key){
  if(mistakeBook[key]){
    removeMistake(key);
    toast('已移出错题本');
  }else{
    addMistake(key, {manual:true});
    toast('📕 已加入错题本');
  }
  refreshMistakeBtns();
}
/** 刷新所有「加入错题本」按钮的显示 */
function refreshMistakeBtns(){
  flat.forEach(f=>{
    const i = flat.indexOf(f);
    const b = document.querySelector(`#card-${i} .madd`);
    if(!b) return;
    const inBook = !!mistakeBook[f.key];
    b.textContent = inBook ? '📕 已在错题本' : '📕 加入错题本';
    b.classList.toggle('in', inBook);
  });
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
  if(!confirm('清空本专题的所有答案和笔迹？\n（错题本不受影响）')) return;
  answers = {}; strokes = {}; curQIdx = 0;
  if(submitted[curTopicId]) delete submitted[curTopicId];
  saveState(); renderPractice();
}

/* ---------- 错题本 ---------- */
/** 打开错题本页面 */
function openMistakeBook(){
  mode = 'mistake';
  const keys = Object.keys(mistakeBook);
  const items = keys.map(k=>mistakeBook[k]).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  $('#screen').innerHTML = `
    <div class="qhead">
      <div class="tt">📕 错题本</div>
      <div>
        <span class="chip c-step">共 ${items.length} 题</span>
        ${items.length?`<span class="chip c-idx" style="color:#334155;background:#e2e8f0">做错 ${items.filter(x=>!x.fixed).length} · 已订正 ${items.filter(x=>x.fixed).length}</span>`:''}
      </div>
      <div class="qnav">
        <button onclick="backHome()">← 专题列表</button>
        ${items.length?`<button class="primary" onclick="startRedoAll()">🔁 全部重做一遍</button>`:''}
      </div>
    </div>
    ${items.length ? `<div class="mblist">${items.map(it=>`
      <div class="mbitem ${it.fixed?'fixed':''}">
        <div class="mbh">
          <span class="mbtag">${esc(it.topicName||'')}</span>
          <span class="mbstep">台阶 ${esc(it.step||'')} · ${esc(it.stepName||'')} · 第 ${esc(it.group||'')} 组 · 第 ${esc(it.qno||'')} 题</span>
          ${it.fixed?'<span class="mbfix">已订正</span>':'<span class="mbbad">做错了</span>'}
        </div>
        <div class="q">${formatQ(it.text||'')}</div>
        <div class="ans">✓ 正确答案：${esc(it.answer||'')}</div>
        <div class="mine">✗ 之前写的：${esc((it.myans||[]).map(v=>String(v||'').trim()||'（空）').join(' , '))}${it.tries?`　（错过 ${it.tries} 次）`:''}</div>
        <div class="mba">
          <button class="primary" onclick="startRedoOne('${it.key}')">🔁 重做这题</button>
          <button onclick="removeMistake('${it.key}');openMistakeBook()">🗑 移出错题本</button>
        </div>
      </div>`).join('')}</div>`
      : `<div class="card"><div class="okall">📭 错题本还是空的。<br><br>做题时点「提交答案」判错，会自动收进这里；也可以手动点「📕 加入错题本」。</div></div>`}
  `;
  window.scrollTo(0,0);
}
/** 重做某一题：切到该题所在的专题并定位（跨专题也能找到）
 *  顺序很重要：先切专题(openTopic 会从 localStorage 恢复 answers)，
 *  再清这题的答案+提交状态，最后重绘。 */
function startRedoOne(key){
  const it = mistakeBook[key]; if(!it) return;
  const found = findQuestionByKey(key);
  if(!found){ toast('原题找不到了（题目库已更新？）'); return; }

  // 1) 先切专题（内部会 restore answers）
  openTopic(found.topic.id);

  // 2) 再清这题: 答案置空 + 取消提交状态 + 清笔迹(让他重写过程)
  answers[key] = [];
  if(submitted[curTopicId]) delete submitted[curTopicId][key];
  strokes[key] = [];
  saveState();

  // 3) 重绘 + 定位
  const idx = flat.findIndex(f=>f.key===key);
  if(idx<0){ toast('定位失败'); return; }
  curQIdx = idx;
  renderPractice();
  setTimeout(()=>{
    goQ(idx);
    toast('🔁 重做这道错题（已清空上次答案）');
  }, 100);
}
/** 全部重做：进入第一个有错题的专题，按错题顺序逐题跳 */
function startRedoAll(){
  const keys = Object.keys(mistakeBook).filter(k=>!mistakeBook[k].fixed);
  const list = keys.length ? keys : Object.keys(mistakeBook);
  if(!list.length){ toast('错题本是空的'); return; }
  const first = list[0];
  const found = findQuestionByKey(first);
  if(!found){ toast('原题找不到了'); return; }

  // 重做队列：让「下一题」在错题之间跳转
  window.__redoQueue = list;

  openTopic(found.topic.id);
  // 清掉所有待重做题的旧答案
  list.forEach(k=>{
    answers[k] = [];
    if(submitted[curTopicId]) delete submitted[curTopicId][k];
  });
  saveState();
  const idx = flat.findIndex(f=>f.key===first);
  if(idx>=0){
    curQIdx = idx;
    renderPractice();
    setTimeout(()=>{ goQ(idx); toast(`🔁 开始重做，共 ${list.length} 题`); }, 100);
  }
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
    // 只有填满所有空的题才参与判分（没填完 = 没做，不算错）
    const unfilled = blanks.filter((b,k)=>String(a[k]||'').trim()==='').length;
    if(unfilled) return;    // 没做完的题不计入正确率、也不进错题本
    const j = judge(q, a);
    judgeable++;
    if(j.correct) right++;
    else {
      wrong.push({f, i, j, user:a});
      // ★ 交卷时自动收录错题本（即使没点过提交，也按已填答案判）
      if(!mistakeBook[f.key]) addMistake(f.key, {myans: a.map(v=>String(v||'').trim())});
    }
  });
  saveMistakeBook();

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
  if(submitted[curTopicId]) delete submitted[curTopicId];
  mode = 'practice'; t0 = Date.now();
  saveState(); renderPractice();
}

function backHome(){
  mistakeBook = loadMistakeBook();
  saveState();
  // 清掉 ?t= 参数，避免刷新又跳回专题
  try{ history.replaceState(null,'',location.pathname); }catch(e){}
  renderHome();
}
