const SUPABASE_URL = 'https://vradqhltkkpfprntstvi.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyYWRxaGx0a2twZnBybnRzdHZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzMTU0NjMsImV4cCI6MjEwMDg5MTQ2M30.mOAFSaZRw-IonYywWnUyDIVyxGPfFzVB-NvC6YD0FcE';

const app = document.getElementById('app');

if(typeof window.supabase === 'undefined' || !window.supabase.createClient){
  app.innerHTML = `
    <div style="padding:40px 20px;text-align:center;color:#F5F1E8;font-family:sans-serif;">
      <p style="color:#C15C33;font-weight:bold;">Couldn't load the Supabase library.</p>
      <p style="font-size:13px;color:#B3AFA4;">This usually means the script from cdn.jsdelivr.net didn't load — check your internet connection, or try again in a minute in case the CDN is temporarily unavailable.</p>
    </div>
  `;
  throw new Error('Supabase library not loaded');
}

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;
let currentProfile = null;
let authMode = 'login'; // 'login' | 'signup'

function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function loadProfile(){
  const { data, error } = await supabaseClient.from('profiles').select('*').eq('id', currentUser.id).single();
  if(error){ currentProfile = null; return; }
  currentProfile = data;
}

async function init(){
  try{
    const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
    if(sessionError) throw sessionError;
    if(session){
      currentUser = session.user;
      await loadProfile();
    }
    renderApp();

    supabaseClient.auth.onAuthStateChange(async (event, session)=>{
      try{
        if(session){
          currentUser = session.user;
          await loadProfile();
        } else {
          currentUser = null;
          currentProfile = null;
        }
        renderApp();
      }catch(err){
        showFatalError(err);
      }
    });
  }catch(err){
    showFatalError(err);
  }
}

function showFatalError(err){
  console.error('App error:', err);
  app.innerHTML = `
    <div class="center-screen">
      <div class="authbox">
        <div class="card">
          <div class="eyebrow" style="color:var(--rust);">Something went wrong</div>
          <p style="color:var(--text-dim);font-size:13px;line-height:1.5;margin-top:10px;word-break:break-word;">
            ${escapeHtml(err && err.message ? err.message : String(err))}
          </p>
        </div>
      </div>
    </div>
  `;
}

function renderApp(){
  if(!currentUser){
    renderAuth();
  } else if(!currentProfile){
    app.innerHTML = `<div class="loading">Setting up your account…</div>`;
  } else if(currentProfile.role === 'clinician'){
    renderClinicianDashboard();
  } else {
    renderClientDashboard();
  }
}

// ---------- AUTH SCREENS ----------
function renderAuth(){
  const isLogin = authMode === 'login';
  app.innerHTML = `
    <div class="center-screen">
      <div class="authbox">
        <div class="brand">PELVIC FLOOR <span>TRAINING</span></div>
        <div class="card">
          <div id="authError" class="err" style="display:none;"></div>
          <div class="field"><label>Email</label><input type="email" id="authEmail" autocomplete="email"></div>
          <div class="field"><label>Password</label><input type="password" id="authPassword" autocomplete="${isLogin?'current-password':'new-password'}"></div>
          ${!isLogin ? `<div class="field"><label>Full name</label><input type="text" id="authName" autocomplete="name"></div>` : ''}
          <button class="btn" id="authSubmitBtn">${isLogin ? 'Log in' : 'Sign up'}</button>
        </div>
        <div class="toggle-link">
          ${isLogin ? `New here? <a id="toggleAuthMode">Sign up</a>` : `Already have an account? <a id="toggleAuthMode">Log in</a>`}
        </div>
      </div>
    </div>
  `;
  document.getElementById('toggleAuthMode').onclick = ()=>{ authMode = isLogin ? 'signup' : 'login'; renderAuth(); };
  document.getElementById('authSubmitBtn').onclick = ()=> isLogin ? handleLogin() : handleSignup();
}

function showAuthError(msg){
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.style.display = 'block';
}

async function handleLogin(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if(!email || !password){ showAuthError('Enter your email and password.'); return; }
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if(error){ showAuthError(error.message); return; }
  // onAuthStateChange will fire and re-render
}

async function handleSignup(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const fullName = document.getElementById('authName').value.trim();
  if(!email || !password){ showAuthError('Enter your email and password.'); return; }
  if(password.length < 6){ showAuthError('Password needs to be at least 6 characters.'); return; }
  const { error } = await supabaseClient.auth.signUp({
    email, password,
    options: { data: { full_name: fullName } }
  });
  if(error){ showAuthError(error.message); return; }
  showAuthError('Account created — check your email to confirm, then log in.');
}

async function handleLogout(){
  await supabaseClient.auth.signOut();
}

// ---------- CLIENT STATE ----------
let PLAN = {};
let sessions = [];
let clientView = 'log';
let editingSessionId = null;
let logState = null;
let expandedHistory = {};
let editingProgram = false;

const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function blankPlanTemplate(){
  const t = {};
  DAY_ORDER.forEach(d=>{ t[d] = { label:'Rest day', type:'rest', desc:'Tap Edit Program to set up your week.' }; });
  return t;
}
function todayISO(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayDayName(){
  return new Intl.DateTimeFormat('en-AU', { weekday:'long' }).format(new Date());
}
function formatAU(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function fmtWeight(w){ const v=String(w==null?'':w).trim(); if(!v) return '–'; return /[a-z]/i.test(v) ? v : `${v}kg`; }

function emptyExercisesFor(dayKey){
  const day = PLAN[dayKey];
  if(!day || day.type !== 'lift') return [];
  return (day.exercises||[]).map(e=>({ name:e.name, target:e.target||'', hero:!!e.hero, videoUrl:e.videoUrl||'', custom:false, sets:[] }));
}
function resetLogForDay(dayKey){
  const day = PLAN[dayKey];
  logState.dayKey = dayKey;
  if(day && day.type === 'lift'){
    logState.exercises = emptyExercisesFor(dayKey);
    logState.cardio = { active:false, type:'Run', distance:'', time:'', note:'' };
  } else {
    logState.exercises = [];
    logState.cardio = { active:true, type:'Walk', distance:'', time:'', note:'' };
  }
}
function newLogState(){
  logState = { date: todayISO(), dayKey: todayDayName(), exercises:[], cardio:{active:false,type:'Run',distance:'',time:'',note:''}, warmup:'', note:'' };
  resetLogForDay(logState.dayKey);
}

// ---------- SUPABASE DATA ----------
async function loadPlan(){
  const { data, error } = await supabaseClient.from('plans').select('plan_data').eq('client_id', currentUser.id).maybeSingle();
  PLAN = (data && data.plan_data && Object.keys(data.plan_data).length) ? data.plan_data : blankPlanTemplate();
}
async function savePlan(){
  await supabaseClient.from('plans').upsert({ client_id: currentUser.id, plan_data: PLAN, updated_at: new Date().toISOString() });
}
async function loadSessions(){
  const { data, error } = await supabaseClient.from('sessions').select('*').eq('client_id', currentUser.id).order('date', { ascending:false });
  sessions = data || [];
}
async function saveSessionToDb(session){
  const row = {
    client_id: currentUser.id, date: session.date, day_key: session.dayKey, day_label: session.dayLabel,
    warmup: session.warmup, note: session.note, exercises: session.exercises, cardio: session.cardio,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseClient.from('sessions').upsert(row, { onConflict:'client_id,date' });
  return error;
}
async function deleteSessionFromDb(id){
  await supabaseClient.from('sessions').delete().eq('id', id).eq('client_id', currentUser.id);
}

// ---------- CLIENT DASHBOARD SHELL ----------
async function renderClientDashboard(){
  app.innerHTML = `
    <header>
      <div class="brand" style="margin:0;text-align:left;">HI, <span>${escapeHtml((currentProfile.full_name||'THERE').toUpperCase())}</span></div>
      <button class="btn danger" id="logoutBtn" style="width:auto;padding:9px 16px;font-size:12px;">Log out</button>
    </header>
    <main><div class="loading2">Loading your data…</div></main>
    <div class="navbar" id="clientNav"></div>
  `;
  document.getElementById('logoutBtn').onclick = handleLogout;
  await loadPlan();
  await loadSessions();
  if(!logState) newLogState();
  renderClientNav();
  renderClientView();
}

function renderClientNav(){
  const tabs = [
    {id:'log', label:'Log', ic:'&#9998;'},
    {id:'history', label:'History', ic:'&#128337;'},
    {id:'program', label:'Program', ic:'&#128203;'},
  ];
  document.getElementById('clientNav').innerHTML = tabs.map(t=>
    `<button class="navbtn ${clientView===t.id?'active':''}" data-view="${t.id}"><span class="ic">${t.ic}</span>${t.label}</button>`
  ).join('');
  document.querySelectorAll('.navbtn').forEach(b=>{
    b.onclick = ()=>{
      if(b.dataset.view==='log' && clientView!=='log'){ editingSessionId=null; newLogState(); }
      clientView = b.dataset.view;
      renderClientNav();
      renderClientView();
    };
  });
}
function renderClientView(){
  const main = document.querySelector('main');
  if(clientView === 'log') renderClientLog(main);
  else if(clientView === 'history') renderClientHistory(main);
  else if(clientView === 'program') renderClientProgram(main);
}

// ---------- LOG ----------
function renderClientLog(main){
  const day = PLAN[logState.dayKey] || {type:'rest', desc:''};
  let html = `<div class="field" style="display:flex;gap:10px;margin-bottom:14px;">
    <div style="flex:1;"><label>Date</label><input type="date" id="logDate" value="${logState.date}"></div>
    <div style="flex:1;"><label>Day</label>
      <select id="logDay">${DAY_ORDER.map(d=>`<option value="${d}" ${d===logState.dayKey?'selected':''}>${d} — ${escapeHtml((PLAN[d]||{}).label||'')}</option>`).join('')}</select>
    </div>
  </div>`;

  if(day.type !== 'lift'){
    html += `<div class="card"><div class="section-label">Recovery / Cardio</div><div style="font-size:13px;color:var(--text-dim);">${escapeHtml(day.desc||'')}</div></div>`;
  } else {
    html += `<div class="section-label">Exercises</div>`;
    logState.exercises.forEach((ex,i)=>{
      html += renderExerciseCard(ex, i);
    });
    html += `<button class="btn secondary" id="addExBtn" style="margin-bottom:14px;">+ Add exercise</button>`;
  }

  html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
    <span class="section-label" style="margin:0;">Run / walk</span>
    <button id="toggleCardioBtn" style="background:none;border:none;color:${logState.cardio.active?'var(--brass)':'var(--text-faint)'};font-family:var(--font-mono);font-size:11px;">${logState.cardio.active?'REMOVE':'+ ADD'}</button>
  </div>`;
  if(logState.cardio.active){
    html += `<div class="card">
      <div class="field" style="display:flex;gap:10px;">
        <div style="flex:1;"><label>Distance (km)</label><input type="text" id="cardioDist" value="${escapeHtml(logState.cardio.distance)}"></div>
        <div style="flex:1;"><label>Time</label><input type="text" id="cardioTime" value="${escapeHtml(logState.cardio.time)}" placeholder="mm:ss"></div>
      </div>
    </div>`;
  }

  html += `<div class="field" style="margin:14px 0;"><label>Session notes</label><textarea id="logNote" rows="2">${escapeHtml(logState.note)}</textarea></div>
  <button class="btn" id="saveLogBtn">${editingSessionId?'Update session':'Save session'}</button>`;

  main.innerHTML = html;
  wireClientLog(main);
}
function renderExerciseCard(ex, i){
  return `<div class="card" data-idx="${i}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
      <div style="flex:1;">
        <input class="exNameInput" data-idx="${i}" value="${escapeAttr(ex.name)}" placeholder="Exercise name" style="background:none;border:none;font-family:var(--font-display);font-weight:600;font-size:15px;color:var(--text);width:100%;padding:0;">
        ${ex.target?`<div style="font-family:var(--font-mono);font-size:11px;color:${ex.hero?'#C15C33':'var(--text-faint)'};margin-top:2px;">${escapeHtml(ex.target)}${ex.hero?' · HERO':''}</div>`:''}
        ${ex.videoUrl?`<a class="videoLink" href="${escapeAttr(ex.videoUrl)}" target="_blank" rel="noopener">&#127909; Watch technique video</a>`:''}
      </div>
      <button class="removeExBtn" data-idx="${i}" style="background:none;border:none;color:var(--text-faint);font-size:16px;">&times;</button>
    </div>
    ${ex.sets.map((s,si)=>`
      <div class="setrow" data-idx="${i}" data-si="${si}">
        <span class="idx">${si+1}</span>
        <input class="w setField" data-field="weight" placeholder="kg" value="${escapeAttr(s.weight)}">
        <span style="color:var(--text-faint);font-size:12px;">×</span>
        <input class="r setField" data-field="reps" placeholder="reps" value="${escapeAttr(s.reps)}">
        <select class="setField" data-field="rir">
          <option value="">RIR</option>
          ${['0-1','2-3','4-5','Failure'].map(r=>`<option value="${r}" ${s.rir===r?'selected':''}>${r}</option>`).join('')}
        </select>
        <input class="n setField" data-field="note" placeholder="note" value="${escapeAttr(s.note||'')}">
        <button class="removeSetBtn" data-idx="${i}" data-si="${si}">&times;</button>
      </div>
    `).join('')}
    <button class="addset" data-idx="${i}">+ Add set</button>
  </div>`;
}
function wireClientLog(main){
  document.getElementById('logDate').onchange = e=>{ logState.date = e.target.value; renderClientLog(main); };
  document.getElementById('logDay').onchange = e=>{ resetLogForDay(e.target.value); renderClientLog(main); };
  const addExBtn = document.getElementById('addExBtn');
  if(addExBtn) addExBtn.onclick = ()=>{ logState.exercises.push({name:'',target:'',hero:false,videoUrl:'',custom:true,sets:[]}); renderClientLog(main); };
  document.getElementById('toggleCardioBtn').onclick = ()=>{ logState.cardio.active = !logState.cardio.active; renderClientLog(main); };
  const cd = document.getElementById('cardioDist'); if(cd) cd.oninput = e=>logState.cardio.distance=e.target.value;
  const ct = document.getElementById('cardioTime'); if(ct) ct.oninput = e=>logState.cardio.time=e.target.value;
  document.getElementById('logNote').oninput = e=>logState.note = e.target.value;

  main.querySelectorAll('.exNameInput').forEach(inp=>{ inp.oninput = e=>{ logState.exercises[+inp.dataset.idx].name = e.target.value; }; });
  main.querySelectorAll('.removeExBtn').forEach(b=>{ b.onclick = ()=>{ logState.exercises.splice(+b.dataset.idx,1); renderClientLog(main); }; });
  main.querySelectorAll('.addset').forEach(b=>{ b.onclick = ()=>{ logState.exercises[+b.dataset.idx].sets.push({weight:'',reps:'',rir:'',note:''}); renderClientLog(main); }; });
  main.querySelectorAll('.removeSetBtn').forEach(b=>{ b.onclick = ()=>{ logState.exercises[+b.dataset.idx].sets.splice(+b.dataset.si,1); renderClientLog(main); }; });
  main.querySelectorAll('.setrow').forEach(row=>{
    const i = +row.dataset.idx, si = +row.dataset.si;
    row.querySelectorAll('.setField').forEach(f=>{
      const ev = f.tagName==='SELECT' ? 'onchange' : 'oninput';
      f[ev] = e=>{ logState.exercises[i].sets[si][f.dataset.field] = e.target.value; };
    });
  });

  document.getElementById('saveLogBtn').onclick = async ()=>{
    const loggedExercises = logState.exercises
      .filter(ex=>ex.name.trim() && ex.sets.some(s=>s.weight||s.reps))
      .map(ex=>({ name: ex.name.trim(), tier: ex.hero?'hero':'accessory',
        sets: ex.sets.filter(s=>s.weight||s.reps).map(s=>({weight:s.weight||'',reps:s.reps||'',rir:s.rir||'',note:s.note||''})) }));
    const hasCardio = logState.cardio.active && (logState.cardio.distance || logState.cardio.time);
    if(loggedExercises.length===0 && !hasCardio){ alert('Log at least one set or a run/walk first'); return; }
    const session = {
      date: logState.date, dayKey: logState.dayKey, dayLabel: (PLAN[logState.dayKey]||{}).label || logState.dayKey,
      warmup:'', note: logState.note.trim(), exercises: loggedExercises, cardio: hasCardio ? {...logState.cardio} : null,
    };
    const err = await saveSessionToDb(session);
    if(err){ alert('Could not save: ' + err.message); return; }
    await loadSessions();
    editingSessionId = null;
    newLogState();
    clientView = 'history';
    renderClientNav();
    renderClientView();
  };
}

// ---------- HISTORY ----------
function renderClientHistory(main){
  const sorted = [...sessions].sort((a,b)=>b.date.localeCompare(a.date));
  if(sorted.length===0){ main.innerHTML = `<div class="emptystate">No sessions yet. Head to Log to add your first one.</div>`; return; }
  main.innerHTML = sorted.map(s=>{
    const open = !!expandedHistory[s.id];
    let body = '';
    if(open){
      (s.exercises||[]).forEach(ex=>{
        body += `<div style="font-family:var(--font-display);font-weight:500;font-size:13px;margin-bottom:4px;">${escapeHtml(ex.name)}</div><div style="margin-bottom:8px;">`;
        (ex.sets||[]).forEach(st=>{ body += `<span class="chip">${fmtWeight(st.weight)} × ${st.reps||'–'}${st.rir?' · '+st.rir:''}</span>`; });
        body += `</div>`;
      });
      if(s.cardio) body += `<div style="font-family:var(--font-mono);font-size:12px;color:#6E93AC;margin-bottom:8px;">${s.cardio.type}: ${s.cardio.distance||'–'}km ${s.cardio.time?'in '+s.cardio.time:''}</div>`;
      if(s.note) body += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">Notes: ${escapeHtml(s.note)}</div>`;
      body += `<div style="display:flex;gap:14px;"><button class="editHistBtn" data-id="${s.id}" style="background:none;border:none;color:var(--brass);font-family:var(--font-mono);font-size:11px;">EDIT</button>
      <button class="deleteHistBtn" data-id="${s.id}" style="background:none;border:none;color:#C15C33;font-family:var(--font-mono);font-size:11px;">DELETE</button></div>`;
    }
    return `<div class="card">
      <button class="histhead" data-id="${s.id}">
        <div><div class="histdate">${formatAU(s.date)}</div><div class="histlabel">${escapeHtml(s.day_label||s.dayLabel||'')}</div></div>
        <span style="color:var(--text-faint);">${open?'&#9650;':'&#9660;'}</span>
      </button>
      <div class="histbody" style="${open?'':'display:none;'}">${body}</div>
    </div>`;
  }).join('');
  main.querySelectorAll('.histhead').forEach(b=>{ b.onclick = ()=>{ expandedHistory[b.dataset.id]=!expandedHistory[b.dataset.id]; renderClientHistory(main); }; });
  main.querySelectorAll('.deleteHistBtn').forEach(b=>{
    b.onclick = async ()=>{ await deleteSessionFromDb(b.dataset.id); await loadSessions(); renderClientHistory(main); };
  });
  main.querySelectorAll('.editHistBtn').forEach(b=>{
    b.onclick = ()=>{
      const s = sessions.find(x=>x.id===b.dataset.id);
      if(!s) return;
      editingSessionId = s.id;
      logState = {
        date: s.date, dayKey: PLAN[s.day_key] ? s.day_key : todayDayName(), warmup: s.warmup||'', note: s.note||'',
        exercises: (s.exercises||[]).map(ex=>({ name:ex.name, target:'', hero: ex.tier==='hero', videoUrl:'', custom:true,
          sets:(ex.sets||[]).map(st=>({weight:st.weight||'',reps:st.reps||'',rir:st.rir||'',note:st.note||''})) })),
        cardio: s.cardio ? {...s.cardio, active:true} : {active:false,type:'Run',distance:'',time:'',note:''},
      };
      clientView = 'log';
      renderClientNav();
      renderClientView();
    };
  });
}

// ---------- PROGRAM ----------
function renderClientProgram(main){
  if(editingProgram){ renderProgramEditor(main); return; }
  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
    <div class="section-label" style="margin:0;">Weekly program</div>
    <button class="btn secondary" id="editProgramBtn" style="width:auto;padding:8px 14px;font-size:12px;">Edit</button>
  </div>`;
  DAY_ORDER.forEach(k=>{
    const d = PLAN[k];
    const sub = d.type==='lift' ? (d.exercises||[]).map(e=>e.name).filter(Boolean).join(', ') || 'No exercises yet' : (d.desc||'');
    html += `<div class="clientrow" style="align-items:flex-start;">
      <div><div class="histdate">${k.toUpperCase()}</div><div class="histlabel" style="font-size:14px;">${escapeHtml(d.label)}</div>
      <div style="font-size:11px;color:var(--text-faint);margin-top:2px;max-width:220px;">${escapeHtml(sub)}</div></div>
    </div>`;
  });
  main.innerHTML = html;
  document.getElementById('editProgramBtn').onclick = ()=>{ editingProgram = true; renderClientProgram(main); };
}
function renderProgramEditor(main){
  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <div class="section-label" style="margin:0;">Edit program</div>
    <button class="btn" id="doneEditBtn" style="width:auto;padding:8px 14px;font-size:12px;">Done</button>
  </div>`;
  DAY_ORDER.forEach(k=>{
    const d = PLAN[k];
    html += `<div class="card"><div class="section-label">${k.toUpperCase()}</div>
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        <div style="flex:1;"><label style="display:block;font-size:11px;color:var(--text-faint);margin-bottom:4px;">Type</label>
          <select class="dayTypeSel" data-day="${k}" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:8px;">
            <option value="rest" ${d.type==='rest'?'selected':''}>Rest</option>
            <option value="cardio" ${d.type==='cardio'?'selected':''}>Cardio</option>
            <option value="lift" ${d.type==='lift'?'selected':''}>Lift</option>
          </select>
        </div>
        <div style="flex:1;"><label style="display:block;font-size:11px;color:var(--text-faint);margin-bottom:4px;">Label</label>
          <input class="dayLabelInp" data-day="${k}" value="${escapeAttr(d.label)}" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:8px;">
        </div>
      </div>`;
    if(d.type !== 'lift'){
      html += `<input class="dayDescInp" data-day="${k}" value="${escapeAttr(d.desc||'')}" placeholder="Description" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:8px;">`;
    } else {
      (d.exercises||[]).forEach((ex,i)=>{
        html += `<div style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px;">
          <div style="display:flex;gap:6px;margin-bottom:6px;">
            <input class="exNameEdit" data-day="${k}" data-idx="${i}" value="${escapeAttr(ex.name)}" placeholder="Exercise name" style="flex:1;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px;font-size:13px;">
            <input class="exTargetEdit" data-day="${k}" data-idx="${i}" value="${escapeAttr(ex.target||'')}" placeholder="3x8-10" style="width:70px;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px;font-size:12px;font-family:var(--font-mono);">
            <button class="heroToggle" data-day="${k}" data-idx="${i}" style="background:none;border:1px solid ${ex.hero?'#C15C33':'var(--border)'};color:${ex.hero?'#C15C33':'var(--text-faint)'};border-radius:6px;padding:6px 8px;font-size:10px;">HERO</button>
            <button class="removeExEdit" data-day="${k}" data-idx="${i}" style="background:none;border:none;color:var(--text-faint);font-size:15px;">&times;</button>
          </div>
          <input class="exVideoEdit" data-day="${k}" data-idx="${i}" value="${escapeAttr(ex.videoUrl||'')}" placeholder="Video link (optional)" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px;font-size:12px;">
        </div>`;
      });
      html += `<button class="addExEdit" data-day="${k}" style="background:none;border:none;color:#6E93AC;font-family:var(--font-mono);font-size:11px;">+ Add exercise</button>`;
    }
    html += `</div>`;
  });
  main.innerHTML = html;
  document.getElementById('doneEditBtn').onclick = async ()=>{ editingProgram=false; await savePlan(); renderClientProgram(main); };
  main.querySelectorAll('.dayTypeSel').forEach(sel=>{ sel.onchange = e=>{ PLAN[sel.dataset.day].type = e.target.value; if(e.target.value==='lift' && !PLAN[sel.dataset.day].exercises) PLAN[sel.dataset.day].exercises=[]; renderProgramEditor(main); }; });
  main.querySelectorAll('.dayLabelInp').forEach(inp=>{ inp.oninput = e=>{ PLAN[inp.dataset.day].label = e.target.value; }; });
  main.querySelectorAll('.dayDescInp').forEach(inp=>{ inp.oninput = e=>{ PLAN[inp.dataset.day].desc = e.target.value; }; });
  main.querySelectorAll('.exNameEdit').forEach(inp=>{ inp.oninput = e=>{ PLAN[inp.dataset.day].exercises[inp.dataset.idx].name = e.target.value; }; });
  main.querySelectorAll('.exTargetEdit').forEach(inp=>{ inp.oninput = e=>{ PLAN[inp.dataset.day].exercises[inp.dataset.idx].target = e.target.value; }; });
  main.querySelectorAll('.exVideoEdit').forEach(inp=>{ inp.oninput = e=>{ PLAN[inp.dataset.day].exercises[inp.dataset.idx].videoUrl = e.target.value; }; });
  main.querySelectorAll('.heroToggle').forEach(b=>{ b.onclick = ()=>{ const ex=PLAN[b.dataset.day].exercises[b.dataset.idx]; ex.hero=!ex.hero; renderProgramEditor(main); }; });
  main.querySelectorAll('.removeExEdit').forEach(b=>{ b.onclick = ()=>{ PLAN[b.dataset.day].exercises.splice(b.dataset.idx,1); renderProgramEditor(main); }; });
  main.querySelectorAll('.addExEdit').forEach(b=>{ b.onclick = ()=>{ if(!PLAN[b.dataset.day].exercises) PLAN[b.dataset.day].exercises=[]; PLAN[b.dataset.day].exercises.push({name:'',target:'',hero:false,videoUrl:''}); renderProgramEditor(main); }; });
}

function escapeAttr(s){ return escapeHtml(s); }

// ---------- CLINICIAN DASHBOARD ----------
async function renderClinicianDashboard(){
  app.innerHTML = `
    <header>
      <div class="brand" style="margin:0;text-align:left;">YOUR <span>CLIENTS</span></div>
      <button class="btn danger" id="logoutBtn" style="width:auto;padding:9px 16px;font-size:12px;">Log out</button>
    </header>
    <main><div class="loading">Loading your clients…</div></main>
  `;
  document.getElementById('logoutBtn').onclick = handleLogout;

  const { data: clientRows, error: clientErr } = await supabaseClient
    .from('clients')
    .select('id, active, created_at')
    .eq('clinician_id', currentUser.id);

  const main = document.querySelector('main');

  if(clientErr){
    main.innerHTML = `<div class="card"><div class="err">Couldn't load clients: ${escapeHtml(clientErr.message)}</div></div>`;
    return;
  }
  if(!clientRows || clientRows.length === 0){
    main.innerHTML = `<div class="card">
      <div class="eyebrow">No clients yet</div>
      <p style="color:var(--text-dim);font-size:14px;line-height:1.5;">
        Once a client signs up with their own email, link them to your account by adding a row in the
        <strong>clients</strong> table (Table Editor in Supabase): set <code>id</code> to their user id and
        <code>clinician_id</code> to yours.
      </p>
    </div>`;
    return;
  }

  const ids = clientRows.map(c=>c.id);
  const { data: profileRows } = await supabaseClient.from('profiles').select('id, full_name').in('id', ids);
  const nameById = {};
  (profileRows||[]).forEach(p=>{ nameById[p.id] = p.full_name; });

  main.innerHTML = clientRows.map(c=>`
    <div class="clientrow">
      <div class="name">${escapeHtml(nameById[c.id] || 'Unnamed client')}</div>
      <span class="eyebrow">${c.active ? 'ACTIVE' : 'INACTIVE'}</span>
    </div>
  `).join('');
}

init();
