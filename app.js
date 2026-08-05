/* ============================================================
   CFM PERFORMANCE — clinical multi-client app
   Supabase-backed. Role-based: profiles.role = 'client' | 'clinician'

   SCHEMA ASSUMPTIONS — confirmed from handoff notes + migration SQL:
     plans.plan_data      jsonb   (confirmed)
     sessions.exercises   jsonb   (confirmed)
     goals, lifestyle_logs — exact, from migration SQL

   Everything else below is a best-guess based on context. If your
   actual Supabase schema uses different column names, the queries
   that need adjusting are grouped under each SCHEMA GUESS comment —
   search this file for "SCHEMA GUESS" to find every place to check.
   ============================================================ */

const SUPABASE_URL = 'https://vradqhltkkpfprntstvi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_IYGFPLQo96jGWs6VArtwWA_mjtzgFL_';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const TIMEZONE = 'Australia/Melbourne';

// ---------- STATE ----------
let currentUser = null;      // supabase auth user
let currentProfile = null;   // { id, role, name }
let authMode = 'login';      // 'login' | 'signup'
let view = 'log';            // client views: log/history/program/goals/lifestyle
                              // clinician views: clients/clientDetail
let selectedClientId = null; // clinician: which client is being viewed

let plan = {};                // client's plan_data, keyed by day name
let sessions = [];
let goals = [];
let lifestyleLogs = [];
let clinicianClients = [];    // clinician: linked clients list
let clientDetail = null;      // clinician: loaded detail for selectedClientId

let logState = { date: todayISO(), dayKey: todayDayName(), exercises: [], warmup: '', note: '' };

function todayISO(){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
}
function todayDayName(){ return new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, weekday:'long' }).format(new Date()); }
function formatAU(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function uid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function escapeHtml(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }

function showToast(msg){
  let t = document.getElementById('toast');
  if(!t){
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:10px 16px;border-radius:8px;font-size:13px;z-index:300;opacity:0;transition:opacity .2s;pointer-events:none;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(()=>{ t.style.opacity = '0'; }, 1800);
}

function canonicalKey(name){
  const words = (name||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
  return [...new Set(words)].sort().join(' ');
}

// ============================================================
// AUTH
// ============================================================

async function init(){
  const { data: { session } } = await supabase.auth.getSession();
  if(session){
    currentUser = session.user;
    await loadProfileAndBoot();
  } else {
    renderAuthScreen();
  }
  supabase.auth.onAuthStateChange((event, session)=>{
    if(event === 'SIGNED_OUT'){
      currentUser = null; currentProfile = null;
      renderAuthScreen();
    }
  });
}

async function loadProfileAndBoot(){
  const app = document.getElementById('app');
  app.innerHTML = `<div class="loading">Loading…</div>`;
  // CONFIRMED: profiles(id, role, full_name, created_at)
  const { data, error } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
  if(error || !data){
    showToast("Couldn't load your profile — contact your clinician if this persists");
    await supabase.auth.signOut();
    return;
  }
  currentProfile = data;
  if(currentProfile.role === 'clinician'){
    view = 'clients';
    await renderClinicianShell();
  } else {
    view = 'log';
    await renderClientShell();
  }
}

function renderAuthScreen(){
  const app = document.getElementById('app');
  app.innerHTML = `
  <div class="center-screen">
    <div class="authbox">
      <div id="authErr" class="err" style="display:none;"></div>
      <div class="card">
        <div class="field">
          <label>Email</label>
          <input id="authEmail" type="email" autocomplete="email">
        </div>
        <div class="field">
          <label>Password</label>
          <input id="authPassword" type="password" autocomplete="${authMode==='login'?'current-password':'new-password'}">
        </div>
        ${authMode==='signup' ? `
        <div class="field">
          <label>Your name</label>
          <input id="authName" type="text" autocomplete="name">
        </div>` : ''}
        <button class="btn" id="authSubmitBtn">${authMode==='login' ? 'Log in' : 'Sign up'}</button>
      </div>
      <div class="toggle-link">
        ${authMode==='login'
          ? `New here? <a id="authToggle">Create an account</a>`
          : `Already have an account? <a id="authToggle">Log in</a>`}
      </div>
    </div>
  </div>`;
  document.getElementById('authToggle').onclick = ()=>{
    authMode = authMode==='login' ? 'signup' : 'login';
    renderAuthScreen();
  };
  document.getElementById('authSubmitBtn').onclick = handleAuthSubmit;
}

async function handleAuthSubmit(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errEl = document.getElementById('authErr');
  errEl.style.display = 'none';
  if(!email || !password){
    errEl.textContent = 'Enter an email and password'; errEl.style.display = 'block';
    return;
  }
  if(authMode === 'login'){
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if(error){ errEl.textContent = error.message; errEl.style.display = 'block'; return; }
    currentUser = data.user;
    await loadProfileAndBoot();
  } else {
    const name = document.getElementById('authName').value.trim();
    if(!name){ errEl.textContent = 'Enter your name'; errEl.style.display = 'block'; return; }
    const { data, error } = await supabase.auth.signUp({ email, password });
    if(error){ errEl.textContent = error.message; errEl.style.display = 'block'; return; }
    if(!data.user){
      showToast('Check your email to confirm your account, then log in.');
      authMode = 'login'; renderAuthScreen();
      return;
    }
    // New signups default to role 'client'. A clinician account is set
    // manually in the Supabase Table Editor (profiles.role = 'clinician'),
    // matching the manual client-linking workflow already in use.
    // CONFIRMED: profiles(id, role, full_name, created_at)
    const { error: profErr } = await supabase.from('profiles').insert({ id: data.user.id, role: 'client', full_name: name });
    if(profErr){ errEl.textContent = "Account created, but couldn't set up your profile: " + profErr.message; errEl.style.display = 'block'; return; }
    currentUser = data.user;
    await loadProfileAndBoot();
  }
}

async function handleLogout(){
  await supabase.auth.signOut();
}

// ============================================================
// CLIENT SHELL
// ============================================================

async function renderClientShell(){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="clientHeader" style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
      <div class="eyebrow">${escapeHtml(currentProfile.full_name||'')}</div>
      <button id="logoutBtn" style="background:none;border:none;color:var(--text-faint);font-family:var(--font-mono);font-size:11px;">LOG OUT</button>
    </div>
    <div id="navbar" class="navbar"></div>
    <main id="mainContent" style="padding-bottom:90px;"></main>
  `;
  document.getElementById('logoutBtn').onclick = handleLogout;
  await Promise.all([loadPlan(), loadSessions(), loadGoals(), loadLifestyleLogs()]);
  renderClientNav();
  renderClientView();
}

function renderClientNav(){
  const tabs = [
    {id:'log', label:'Log', ic:'&#9998;'},
    {id:'history', label:'History', ic:'&#128337;'},
    {id:'program', label:'Program', ic:'&#128203;'},
    {id:'goals', label:'Goals', ic:'&#127942;'},
    {id:'lifestyle', label:'Lifestyle', ic:'&#128202;'},
  ];
  document.getElementById('navbar').innerHTML = tabs.map(t=>
    `<button class="navbtn ${view===t.id?'active':''}" data-view="${t.id}"><span class="ic">${t.ic}</span>${t.label}</button>`
  ).join('');
  document.querySelectorAll('.navbtn').forEach(b=>{
    b.onclick = ()=>{ view = b.dataset.view; renderClientNav(); renderClientView(); };
  });
}

function renderClientView(){
  const main = document.getElementById('mainContent');
  if(view === 'log') renderLog(main);
  else if(view === 'history') renderHistory(main);
  else if(view === 'program') renderProgram(main);
  else if(view === 'goals') renderGoals(main);
  else if(view === 'lifestyle') renderLifestyle(main);
}

// ---------- DATA LOADING (client) ----------
// CONFIRMED: plans(client_id, plan_data jsonb, updated_at) — one row per client
async function loadPlan(){
  const { data, error } = await supabase.from('plans').select('plan_data').eq('client_id', currentUser.id).maybeSingle();
  if(error){ showToast("Couldn't load your program"); plan = {}; return; }
  plan = (data && data.plan_data) ? data.plan_data : {};
}

// CONFIRMED: sessions(id, client_id, date, day_key, day_label, warmup, note, exercises jsonb, cardio jsonb, created_at, updated_at)
async function loadSessions(){
  const { data, error } = await supabase.from('sessions').select('*').eq('client_id', currentUser.id).order('date', { ascending: false });
  if(error){ showToast("Couldn't load your session history"); sessions = []; return; }
  sessions = data || [];
}

async function loadGoals(){
  const { data, error } = await supabase.from('goals').select('*').eq('client_id', currentUser.id);
  if(error){ goals = []; return; }
  goals = data || [];
}

async function loadLifestyleLogs(){
  const { data, error } = await supabase.from('lifestyle_logs').select('*').eq('client_id', currentUser.id).order('date', { ascending: false });
  if(error){ lifestyleLogs = []; return; }
  lifestyleLogs = data || [];
}

// ---------- LOG VIEW ----------
function emptyExercisesForToday(){
  const day = plan[logState.dayKey];
  if(!day || day.type !== 'lift') return [];
  return (day.exercises||[]).map(e => ({ id: uid(), name: e.name, target: e.target, videoUrl: e.videoUrl||'', sets: [] }));
}
if(logState.exercises.length === 0){ /* populated after plan loads, see renderLog */ }

function allKnownExerciseNames(){
  const names = new Set();
  Object.values(plan).forEach(d=>(d.exercises||[]).forEach(e=>names.add(e.name)));
  sessions.forEach(s=>(s.exercises||[]).forEach(e=>names.add(e.name)));
  return [...names].sort((a,b)=>a.localeCompare(b));
}
function videoUrlForExerciseName(name){
  const key = canonicalKey(name);
  for(const d of Object.values(plan)){
    const match = (d.exercises||[]).find(e=>canonicalKey(e.name)===key);
    if(match && match.videoUrl) return match.videoUrl;
  }
  return '';
}

function renderLog(main){
  if(!logState._initedForPlan){
    logState.exercises = emptyExercisesForToday();
    logState._initedForPlan = true;
  }
  const day = plan[logState.dayKey];
  main.innerHTML = `
    <div style="padding:16px 18px;">
    <div class="section-label">${escapeHtml(logState.dayKey)} · ${formatAU(logState.date)}</div>
    ${!day ? `<div class="emptystate">No program set for today yet — check with your clinician, or log a custom session below.</div>` : ''}
    <div id="logExerciseList"></div>
    <button class="btn secondary" id="addCustomExBtn" style="margin-top:6px;">+ Add exercise</button>
    <div class="field" style="margin-top:16px;">
      <label>Session note</label>
      <input id="logNoteInput" type="text" value="${escapeAttr(logState.note)}">
    </div>
    </div>
  `;
  document.getElementById('logNoteInput').oninput = e=>{ logState.note = e.target.value; };
  renderLogExerciseList();
  document.getElementById('addCustomExBtn').onclick = openAddExerciseFlow;
  ensureLogSaveBar();
}

function renderLogExerciseList(){
  const el = document.getElementById('logExerciseList');
  if(!el) return;
  if(logState.exercises.length === 0){
    el.innerHTML = `<div class="emptystate">No exercises yet. Tap "Add exercise" to start logging.</div>`;
    return;
  }
  el.innerHTML = logState.exercises.map((ex, exIdx)=>`
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
        <div>
          <div style="font-family:var(--font-display);font-weight:600;font-size:15px;">${escapeHtml(ex.name)}</div>
          ${ex.target ? `<div class="eyebrow">${escapeHtml(ex.target)}</div>` : ''}
          ${ex.videoUrl ? `<a class="videoLink" href="${escapeAttr(ex.videoUrl)}" target="_blank" rel="noopener">&#9654; Watch demo</a>` : ''}
        </div>
        <button class="removeExBtn" data-idx="${exIdx}" style="background:none;border:none;color:var(--text-faint);font-size:16px;">&times;</button>
      </div>
      <div class="setrows" data-idx="${exIdx}">
        ${ex.sets.map((s,setIdx)=>`
          <div class="setrow">
            <span class="idx">${setIdx+1}</span>
            <input class="w" type="number" inputmode="decimal" placeholder="kg" value="${escapeAttr(s.weight)}" data-idx="${exIdx}" data-set="${setIdx}" data-field="weight">
            <input class="r" type="number" inputmode="numeric" placeholder="reps" value="${escapeAttr(s.reps)}" data-idx="${exIdx}" data-set="${setIdx}" data-field="reps">
            <button class="removeSetBtn" data-idx="${exIdx}" data-set="${setIdx}">&times;</button>
          </div>
        `).join('')}
      </div>
      <button class="addset addSetBtn" data-idx="${exIdx}">+ add set</button>
    </div>
  `).join('');

  el.querySelectorAll('.removeExBtn').forEach(b=>b.onclick = ()=>{
    logState.exercises.splice(+b.dataset.idx, 1);
    renderLogExerciseList();
  });
  el.querySelectorAll('.addSetBtn').forEach(b=>b.onclick = ()=>{
    logState.exercises[+b.dataset.idx].sets.push({ weight:'', reps:'' });
    renderLogExerciseList();
  });
  el.querySelectorAll('.removeSetBtn').forEach(b=>b.onclick = ()=>{
    logState.exercises[+b.dataset.idx].sets.splice(+b.dataset.set, 1);
    renderLogExerciseList();
  });
  el.querySelectorAll('input[data-field]').forEach(inp=>{
    inp.oninput = ()=>{
      logState.exercises[+inp.dataset.idx].sets[+inp.dataset.set][inp.dataset.field] = inp.value;
    };
  });
}

function openAddExerciseFlow(){
  const known = allKnownExerciseNames();
  let ov = document.getElementById('addExOverlay');
  if(ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'addExOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;z-index:200;';
  ov.innerHTML = `
    <div style="background:var(--surface);border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:480px;max-height:80vh;overflow-y:auto;">
      <div style="font-family:var(--font-display);font-weight:600;font-size:16px;margin-bottom:12px;">Add exercise</div>
      <div class="field">
        <label>Search existing exercises</label>
        <input id="exSearchInput" type="text" placeholder="e.g. Hip thrust — swap if equipment's taken">
      </div>
      <div id="exSearchResults" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;"></div>
      <div style="font-size:12px;color:var(--text-faint);margin:14px 0 8px;">Or enter your own</div>
      <div class="field">
        <input id="exCustomName" type="text" placeholder="Exercise name">
      </div>
      <div style="display:flex;gap:10px;margin-top:10px;">
        <button class="btn secondary" id="exCancelBtn" style="flex:1;">Cancel</button>
        <button class="btn" id="exAddCustomBtn" style="flex:1;">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(ov);
  function renderResults(q){
    const filtered = known.filter(n=>!q || n.toLowerCase().includes(q.toLowerCase()));
    const box = document.getElementById('exSearchResults');
    box.innerHTML = filtered.length ? filtered.map(n=>
      `<button class="exResultBtn" data-name="${escapeAttr(n)}" style="background:var(--surface-2);border:1px solid var(--border);color:var(--text);font-size:12px;padding:6px 12px;border-radius:20px;">${escapeHtml(n)}</button>`
    ).join('') : `<div style="font-size:12px;color:var(--text-faint);">No matches — enter it below instead.</div>`;
    box.querySelectorAll('.exResultBtn').forEach(b=>{
      b.onclick = ()=>{
        const name = b.dataset.name;
        logState.exercises.push({ id: uid(), name, target:'', videoUrl: videoUrlForExerciseName(name), sets: [] });
        ov.remove();
        renderLogExerciseList();
      };
    });
  }
  renderResults('');
  document.getElementById('exSearchInput').oninput = e=>renderResults(e.target.value);
  document.getElementById('exCancelBtn').onclick = ()=>ov.remove();
  document.getElementById('exAddCustomBtn').onclick = ()=>{
    const name = document.getElementById('exCustomName').value.trim();
    if(!name){ showToast('Enter an exercise name'); return; }
    logState.exercises.push({ id: uid(), name, target:'', videoUrl:'', sets: [] });
    ov.remove();
    renderLogExerciseList();
  };
}

function ensureLogSaveBar(){
  let bar = document.getElementById('saveBar');
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'saveBar';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:12px 18px;background:var(--surface);border-top:1px solid var(--border);z-index:30;';
    bar.innerHTML = `<button class="btn" id="saveSessionBtn">Save session</button>`;
    document.body.appendChild(bar);
    document.getElementById('saveSessionBtn').onclick = handleSaveSession;
  }
  bar.style.display = view === 'log' ? 'block' : 'none';
}

async function handleSaveSession(){
  const exercisesToSave = logState.exercises
    .map(e=>({ name: e.name, target: e.target, sets: e.sets.filter(s=>s.weight!=='' || s.reps!=='') }))
    .filter(e=>e.sets.length > 0);
  if(exercisesToSave.length === 0){ showToast('Log at least one set before saving'); return; }
  // CONFIRMED: sessions(client_id, date, day_key, day_label, exercises jsonb, note)
  const dayInfo = plan[logState.dayKey];
  const { error } = await supabase.from('sessions').upsert({
    client_id: currentUser.id,
    date: logState.date,
    day_key: logState.dayKey,
    day_label: (dayInfo && dayInfo.label) || logState.dayKey,
    exercises: exercisesToSave,
    note: logState.note,
  }, { onConflict: 'client_id,date' });
  if(error){ showToast("Couldn't save — " + error.message); return; }
  showToast('Session saved');
  await loadSessions();
  if(view === 'history') renderClientView();
}

// ---------- HISTORY VIEW ----------
function renderHistory(main){
  if(sessions.length === 0){
    main.innerHTML = `<div style="padding:16px 18px;"><div class="emptystate">No sessions logged yet.</div></div>`;
    return;
  }
  main.innerHTML = `<div style="padding:16px 18px;">` + sessions.map(s=>`
    <div class="card">
      <div class="histdate">${formatAU(s.date)}</div>
      ${(s.exercises||[]).map(ex=>`
        <div style="margin-top:8px;">
          <div style="font-family:var(--font-display);font-weight:600;font-size:14px;">${escapeHtml(ex.name)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
            ${(ex.sets||[]).map(s2=>`<span class="chip">${escapeHtml(s2.weight)}kg × ${escapeHtml(s2.reps)}</span>`).join('')}
          </div>
        </div>
      `).join('')}
      ${s.note ? `<div style="margin-top:10px;font-size:12px;color:var(--text-dim);">${escapeHtml(s.note)}</div>` : ''}
    </div>
  `).join('') + `</div>`;
}

// ---------- PROGRAM VIEW ----------
function renderProgram(main){
  const days = Object.keys(plan);
  if(days.length === 0){
    main.innerHTML = `<div style="padding:16px 18px;"><div class="emptystate">No program set yet — check with your clinician.</div></div>`;
    return;
  }
  main.innerHTML = `<div style="padding:16px 18px;">` + days.map(dayKey=>{
    const day = plan[dayKey];
    if(day.type !== 'lift') return `<div class="card"><div class="section-label">${escapeHtml(dayKey)}</div><div style="font-size:13px;color:var(--text-dim);">${escapeHtml(day.desc||day.label||'Rest / cardio')}</div></div>`;
    return `<div class="card">
      <div class="section-label">${escapeHtml(dayKey)} — ${escapeHtml(day.label||'')}</div>
      ${(day.exercises||[]).map((ex,exIdx)=>`
        <div style="padding:8px 0;border-top:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-family:var(--font-display);font-weight:600;font-size:14px;">${escapeHtml(ex.name)}</div>
            <div class="eyebrow">${escapeHtml(ex.target||'')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
            ${ex.videoUrl ? `<a class="videoLink" href="${escapeAttr(ex.videoUrl)}" target="_blank" rel="noopener">&#9654; Watch demo</a>` : `<span style="font-size:11px;color:var(--text-faint);">No video linked</span>`}
            <button class="editVideoBtn" data-day="${escapeAttr(dayKey)}" data-idx="${exIdx}" style="background:none;border:none;color:#6E93AC;font-size:11px;font-family:var(--font-mono);">edit link</button>
          </div>
        </div>
      `).join('')}
    </div>`;
  }).join('') + `</div>`;

  main.querySelectorAll('.editVideoBtn').forEach(b=>{
    b.onclick = ()=>{
      const dayKey = b.dataset.day, idx = +b.dataset.idx;
      const current = plan[dayKey].exercises[idx].videoUrl || '';
      const url = prompt('Video URL for ' + plan[dayKey].exercises[idx].name, current);
      if(url === null) return;
      plan[dayKey].exercises[idx].videoUrl = url.trim();
      saveVideoUrl(dayKey, idx);
    };
  });
}

async function saveVideoUrl(){
  // CONFIRMED: plans(client_id, plan_data jsonb) — upsert the whole plan_data object
  const { error } = await supabase.from('plans').upsert({ client_id: currentUser.id, plan_data: plan }, { onConflict: 'client_id' });
  if(error){ showToast("Couldn't save video link — " + error.message); return; }
  showToast('Video link saved');
  renderProgram(document.getElementById('mainContent'));
}

// ---------- GOALS VIEW ----------
function renderGoals(main){
  main.innerHTML = `
    <div style="padding:16px 18px;">
    <button class="btn secondary" id="addGoalBtn" style="margin-bottom:14px;">+ Set a goal</button>
    <div id="goalsList"></div>
    </div>
  `;
  document.getElementById('addGoalBtn').onclick = ()=>openGoalForm(null);
  const list = document.getElementById('goalsList');
  const active = goals.filter(g=>!g.achieved);
  const achieved = goals.filter(g=>g.achieved);
  if(goals.length === 0){
    list.innerHTML = `<div class="emptystate">No goals set yet.</div>`;
    return;
  }
  list.innerHTML = [
    ...active.map(g=>goalCardHtml(g,false)),
    ...achieved.map(g=>goalCardHtml(g,true)),
  ].join('');
  list.querySelectorAll('.goalCard').forEach(card=>{
    card.onclick = ()=>openGoalForm(goals.find(g=>g.id===card.dataset.id));
  });
}
function goalCardHtml(g, achieved){
  return `<div class="card goalCard" data-id="${g.id}" style="cursor:pointer;${achieved?'opacity:0.6;':''}">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div style="font-family:var(--font-display);font-weight:600;font-size:15px;">${escapeHtml(g.exercise_label)}</div>
      ${achieved ? `<span class="chip" style="background:var(--sage-dim);color:var(--sage);border-color:var(--sage-dim);">ACHIEVED</span>` : ''}
    </div>
    <div class="eyebrow" style="margin-top:4px;">${g.target_weight?escapeHtml(g.target_weight)+'kg':''}${g.target_reps?' × '+escapeHtml(g.target_reps):''}</div>
    ${g.note ? `<div style="font-size:12px;color:var(--text-dim);margin-top:6px;">${escapeHtml(g.note)}</div>` : ''}
  </div>`;
}
function openGoalForm(existing){
  let ov = document.getElementById('goalFormOverlay');
  if(ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'goalFormOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;z-index:200;';
  ov.innerHTML = `
    <div style="background:var(--surface);border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:480px;">
      <div style="font-family:var(--font-display);font-weight:600;font-size:16px;margin-bottom:14px;">${existing?'Edit goal':'Set a goal'}</div>
      <div class="field"><label>Exercise</label><input id="goalExercise" type="text" value="${escapeAttr(existing?existing.exercise_label:'')}"></div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label>Target weight (kg)</label><input id="goalWeight" type="number" step="0.5" value="${existing&&existing.target_weight!=null?existing.target_weight:''}"></div>
        <div class="field" style="flex:1;"><label>Target reps</label><input id="goalReps" type="text" value="${existing?escapeAttr(existing.target_reps||''):''}"></div>
      </div>
      <div class="field"><label>Note (optional)</label><input id="goalNote" type="text" value="${existing?escapeAttr(existing.note||''):''}"></div>
      ${existing ? `<button id="goalDeleteBtn" style="background:none;border:none;color:var(--rust);font-size:12px;font-family:var(--font-mono);margin-bottom:10px;">Remove this goal</button>` : ''}
      <div style="display:flex;gap:10px;">
        <button class="btn secondary" id="goalCancelBtn" style="flex:1;">Cancel</button>
        <button class="btn" id="goalSaveBtn" style="flex:1;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(ov);
  document.getElementById('goalCancelBtn').onclick = ()=>ov.remove();
  if(existing){
    document.getElementById('goalDeleteBtn').onclick = async ()=>{
      const { error } = await supabase.from('goals').delete().eq('id', existing.id);
      if(error){ showToast("Couldn't remove goal"); return; }
      ov.remove(); await loadGoals(); renderGoals(document.getElementById('mainContent'));
    };
  }
  document.getElementById('goalSaveBtn').onclick = async ()=>{
    const label = document.getElementById('goalExercise').value.trim();
    if(!label){ showToast('Enter an exercise name'); return; }
    const weight = document.getElementById('goalWeight').value;
    const reps = document.getElementById('goalReps').value.trim();
    const note = document.getElementById('goalNote').value.trim();
    const row = {
      client_id: currentUser.id,
      exercise_key: canonicalKey(label),
      exercise_label: label,
      target_weight: weight ? parseFloat(weight) : null,
      target_reps: reps || null,
      note: note || null,
    };
    if(existing) row.id = existing.id;
    // goals has a unique(client_id, exercise_key) constraint — upsert handles both new and edited goals
    const { error } = await supabase.from('goals').upsert(row, { onConflict: 'client_id,exercise_key' });
    if(error){ showToast("Couldn't save goal — " + error.message); return; }
    ov.remove(); await loadGoals(); renderGoals(document.getElementById('mainContent'));
  };
}

// ---------- LIFESTYLE VIEW ----------
function renderLifestyle(main){
  const today = todayISO();
  const todayEntry = lifestyleLogs.find(l=>l.date===today) || {};
  main.innerHTML = `
    <div style="padding:16px 18px;">
    <div class="card">
      <div class="section-label">Today · ${formatAU(today)}</div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label>Steps</label><input id="lsSteps" type="number" value="${todayEntry.steps??''}"></div>
        <div class="field" style="flex:1;"><label>Sleep (hrs)</label><input id="lsSleep" type="number" step="0.5" value="${todayEntry.sleep_hours??''}"></div>
      </div>
      <div class="field">
        <label>Sleep quality</label>
        <select id="lsQuality" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:11px;font-size:15px;">
          <option value="">—</option>
          ${['poor','okay','good'].map(q=>`<option value="${q}" ${todayEntry.sleep_quality===q?'selected':''}>${q}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Nutrition note</label><input id="lsNutrition" type="text" value="${escapeAttr(todayEntry.nutrition_note||'')}"></div>
      <div class="field"><label>Other note</label><input id="lsOther" type="text" value="${escapeAttr(todayEntry.other_note||'')}"></div>
      <button class="btn" id="lsSaveBtn">Save today's log</button>
    </div>
    <div class="section-label" style="margin-top:18px;">Recent</div>
    ${lifestyleLogs.slice(0,14).map(l=>`
      <div class="card">
        <div class="histdate">${formatAU(l.date)}</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:4px;">
          ${l.steps!=null?l.steps+' steps · ':''}${l.sleep_hours!=null?l.sleep_hours+'h sleep':''}${l.sleep_quality?' ('+escapeHtml(l.sleep_quality)+')':''}
        </div>
        ${l.nutrition_note?`<div style="font-size:12px;color:var(--text-faint);margin-top:4px;">${escapeHtml(l.nutrition_note)}</div>`:''}
      </div>
    `).join('')}
    </div>
  `;
  document.getElementById('lsSaveBtn').onclick = async ()=>{
    // SCHEMA GUESS: lifestyle_logs(client_id, date, steps, sleep_hours, sleep_quality, nutrition_note, other_note)
    const row = {
      client_id: currentUser.id,
      date: today,
      steps: document.getElementById('lsSteps').value ? parseInt(document.getElementById('lsSteps').value,10) : null,
      sleep_hours: document.getElementById('lsSleep').value ? parseFloat(document.getElementById('lsSleep').value) : null,
      sleep_quality: document.getElementById('lsQuality').value || null,
      nutrition_note: document.getElementById('lsNutrition').value.trim() || null,
      other_note: document.getElementById('lsOther').value.trim() || null,
    };
    const { error } = await supabase.from('lifestyle_logs').upsert(row, { onConflict: 'client_id,date' });
    if(error){ showToast("Couldn't save — " + error.message); return; }
    showToast('Saved');
    await loadLifestyleLogs();
    renderLifestyle(document.getElementById('mainContent'));
  };
}

// ============================================================
// CLINICIAN SHELL
// ============================================================

async function renderClinicianShell(){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
      <div class="eyebrow">${escapeHtml(currentProfile.full_name||'')} · CLINICIAN</div>
      <button id="logoutBtn" style="background:none;border:none;color:var(--text-faint);font-family:var(--font-mono);font-size:11px;">LOG OUT</button>
    </div>
    <main id="mainContent" style="padding:16px 18px;"></main>
  `;
  document.getElementById('logoutBtn').onclick = handleLogout;
  await loadClinicianClients();
  renderClinicianClientList();
}

// CONFIRMED: clients(id, clinician_id, active, created_at) — no name column.
// Client names live in profiles.full_name, so we look those up separately
// by id after loading the clients rows.
async function loadClinicianClients(){
  const { data, error } = await supabase.from('clients').select('*').eq('clinician_id', currentUser.id);
  if(error){ showToast("Couldn't load your clients"); clinicianClients = []; return; }
  clinicianClients = data || [];
  if(clinicianClients.length > 0){
    const ids = clinicianClients.map(c=>c.id);
    const { data: profileRows, error: profErr } = await supabase.from('profiles').select('id, full_name').in('id', ids);
    if(!profErr && profileRows){
      const nameById = Object.fromEntries(profileRows.map(p=>[p.id, p.full_name]));
      clinicianClients.forEach(c=>{ c.full_name = nameById[c.id] || null; });
    }
  }
}

function renderClinicianClientList(){
  const main = document.getElementById('mainContent');
  if(clinicianClients.length === 0){
    main.innerHTML = `<div class="emptystate">No clients linked yet. Link one via the Supabase Table Editor (Authentication → Users to find their ID, then insert a row in the clients table).</div>`;
    return;
  }
  main.innerHTML = clinicianClients.map(c=>`
    <div class="clientrow" data-id="${c.id}" style="cursor:pointer;">
      <div class="name">${escapeHtml(c.full_name||'Unnamed client')}</div>
      <span class="chip" style="background:${c.active?'var(--sage-dim)':'var(--rust-dim)'};color:${c.active?'var(--sage)':'var(--rust)'};border-color:${c.active?'var(--sage-dim)':'var(--rust-dim)'};">${c.active?'ACTIVE':'INACTIVE'}</span>
    </div>
  `).join('');
  main.querySelectorAll('.clientrow').forEach(row=>{
    row.onclick = async ()=>{
      selectedClientId = row.dataset.id;
      view = 'clientDetail';
      await loadClientDetail(selectedClientId);
      renderClientDetail();
    };
  });
}

async function loadClientDetail(clientId){
  const [{ data: planRow }, { data: sessionRows }, { data: goalRows }, { data: lifestyleRows }] = await Promise.all([
    supabase.from('plans').select('plan_data').eq('client_id', clientId).maybeSingle(),
    supabase.from('sessions').select('*').eq('client_id', clientId).order('date', { ascending: false }).limit(10),
    supabase.from('goals').select('*').eq('client_id', clientId),
    supabase.from('lifestyle_logs').select('*').eq('client_id', clientId).order('date', { ascending: false }).limit(7),
  ]);
  clientDetail = {
    plan: (planRow && planRow.plan_data) || {},
    sessions: sessionRows || [],
    goals: goalRows || [],
    lifestyle: lifestyleRows || [],
  };
}

function renderClientDetail(){
  const main = document.getElementById('mainContent');
  const client = clinicianClients.find(c=>c.id===selectedClientId);
  main.innerHTML = `
    <button id="backToClientsBtn" style="background:none;border:none;color:var(--text-faint);font-family:var(--font-mono);font-size:11px;margin-bottom:14px;">&larr; ALL CLIENTS</button>
    <div class="section-label">${escapeHtml(client?client.full_name:'Client')}</div>

    <div class="card">
      <div class="eyebrow" style="margin-bottom:8px;">RECENT SESSIONS</div>
      ${clientDetail.sessions.length===0 ? '<div style="font-size:13px;color:var(--text-faint);">No sessions logged yet.</div>' :
        clientDetail.sessions.map(s=>`
          <div style="padding:6px 0;border-top:1px solid var(--border);">
            <div class="histdate">${formatAU(s.date)}</div>
            <div style="font-size:12px;color:var(--text-dim);">${(s.exercises||[]).map(e=>escapeHtml(e.name)).join(', ')}</div>
          </div>
        `).join('')}
    </div>

    <div class="card">
      <div class="eyebrow" style="margin-bottom:8px;">GOALS</div>
      ${clientDetail.goals.length===0 ? '<div style="font-size:13px;color:var(--text-faint);">No goals set.</div>' :
        clientDetail.goals.map(g=>`
          <div style="padding:6px 0;border-top:1px solid var(--border);display:flex;justify-content:space-between;">
            <span>${escapeHtml(g.exercise_label)}</span>
            <span style="color:${g.achieved?'var(--sage)':'var(--text-dim)'};">${g.target_weight?g.target_weight+'kg':''}${g.target_reps?' × '+escapeHtml(g.target_reps):''}${g.achieved?' ✓':''}</span>
          </div>
        `).join('')}
    </div>

    <div class="card">
      <div class="eyebrow" style="margin-bottom:8px;">LIFESTYLE — LAST 7 DAYS</div>
      ${clientDetail.lifestyle.length===0 ? '<div style="font-size:13px;color:var(--text-faint);">No lifestyle logs yet.</div>' :
        clientDetail.lifestyle.map(l=>`
          <div style="padding:6px 0;border-top:1px solid var(--border);font-size:12px;color:var(--text-dim);">
            ${formatAU(l.date)} — ${l.steps!=null?l.steps+' steps · ':''}${l.sleep_hours!=null?l.sleep_hours+'h sleep':''}
          </div>
        `).join('')}
    </div>

    <div class="card">
      <div class="eyebrow" style="margin-bottom:8px;">PROGRAM</div>
      ${Object.keys(clientDetail.plan).length===0 ? '<div style="font-size:13px;color:var(--text-faint);">No program set.</div>' :
        Object.entries(clientDetail.plan).map(([dayKey,day])=>`
          <div style="padding:6px 0;border-top:1px solid var(--border);">
            <div style="font-size:13px;font-weight:600;">${escapeHtml(dayKey)}</div>
            <div style="font-size:12px;color:var(--text-dim);">${day.type==='lift' ? (day.exercises||[]).map(e=>escapeHtml(e.name)).join(', ') : escapeHtml(day.desc||'')}</div>
          </div>
        `).join('')}
    </div>
  `;
  document.getElementById('backToClientsBtn').onclick = ()=>{
    view = 'clients';
    renderClinicianClientList();
  };
}

// ============================================================
init();
