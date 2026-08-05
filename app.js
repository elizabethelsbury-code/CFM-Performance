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
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const TIMEZONE = 'Australia/Melbourne';

// ---------- STATE ----------
let currentUser = null;      // supabase auth user
let currentProfile = null;   // { id, role, name }
let authMode = 'login';      // 'login' | 'signup'
let view = 'log';            // shared tab views: log/schedule/history/progress/biglifts/library/program/goals/lifestyle/cycle/correlate
                              // clinician-only top view: 'clients'
let activeClientId = null;   // whose data the shared views read/write — the logged-in client, or (for a clinician) the client currently being viewed
let viewingAsClinician = false; // true while a clinician is inside a client's tabbed view
let viewingClientName = '';  // display name of the client being viewed, when viewingAsClinician

let plan = {};                // active client's plan_data, keyed by day name
let sessions = [];
let goals = [];
let lifestyleLogs = [];
let clinicianClients = [];    // clinician: linked clients list

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
  const { data: { session } } = await supabaseClient.auth.getSession();
  if(session){
    currentUser = session.user;
    await loadProfileAndBoot();
  } else {
    renderAuthScreen();
  }
  supabaseClient.auth.onAuthStateChange((event, session)=>{
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
  let { data, error } = await supabaseClient.from('profiles').select('*').eq('id', currentUser.id).single();
  if(error || !data){
    // No profile row yet — this is the first time we've had a real session
    // for this user (e.g. right after confirming their email), so it's safe
    // to create it now. Falls back to whatever name they entered at signup,
    // saved in auth metadata since it couldn't be written to the DB until now.
    const fallbackName = currentUser.user_metadata?.full_name || '';
    const { data: created, error: createErr } = await supabaseClient
      .from('profiles')
      .insert({ id: currentUser.id, role: 'client', full_name: fallbackName })
      .select()
      .single();
    if(createErr || !created){
      showToast("Couldn't load your profile — contact your clinician if this persists");
      await supabaseClient.auth.signOut();
      return;
    }
    data = created;
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
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if(error){ errEl.textContent = error.message; errEl.style.display = 'block'; return; }
    currentUser = data.user;
    await loadProfileAndBoot();
  } else {
    const name = document.getElementById('authName').value.trim();
    if(!name){ errEl.textContent = 'Enter your name'; errEl.style.display = 'block'; return; }
    const { data, error } = await supabaseClient.auth.signUp({ email, password, options: { data: { full_name: name } } });
    if(error){ errEl.textContent = error.message; errEl.style.display = 'block'; return; }
    if(!data.session){
      // No active session means email confirmation is required before login works.
      // We deliberately don't try to create the profile row here — there's no
      // authorized session yet, so RLS would block it. The name is saved in
      // auth metadata above; loadProfileAndBoot creates the profile from that
      // on the person's first real login, once they've confirmed their email.
      showToast('Check your email to confirm your account, then log in.');
      authMode = 'login'; renderAuthScreen();
      return;
    }
    currentUser = data.user;
    await loadProfileAndBoot();
  }
}

async function handleLogout(){
  await supabaseClient.auth.signOut();
}

// ============================================================
// CLIENT SHELL
// ============================================================

async function renderClientShell(){
  activeClientId = currentUser.id;
  viewingAsClinician = false;
  view = 'log';
  await renderTabbedShell(currentProfile.full_name||'');
}

async function enterClientAsClinician(clientId, clientName){
  activeClientId = clientId;
  viewingAsClinician = true;
  viewingClientName = clientName;
  view = 'log';
  await renderTabbedShell(clientName);
}

async function renderTabbedShell(headerName){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="clientHeader" style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
      <div>
        ${viewingAsClinician ? `<button id="backToClientsBtn" style="background:none;border:none;color:var(--brass);font-family:var(--font-mono);font-size:11px;padding:0;margin-bottom:4px;display:block;">&larr; CLIENTS</button>` : ''}
        <div class="eyebrow">${escapeHtml(headerName)}${viewingAsClinician?' · VIEWING AS CLINICIAN':''}</div>
      </div>
      <button id="logoutBtn" style="background:none;border:none;color:var(--text-faint);font-family:var(--font-mono);font-size:11px;">LOG OUT</button>
    </div>
    <div id="navbar" class="navbar"></div>
    <main id="mainContent" style="padding-bottom:150px;"></main>
  `;
  document.getElementById('logoutBtn').onclick = handleLogout;
  if(viewingAsClinician){
    document.getElementById('backToClientsBtn').onclick = async ()=>{
      viewingAsClinician = false;
      activeClientId = null;
      view = 'clients';
      await renderClinicianShell();
    };
  }
  await Promise.all([loadPlan(), loadSessions(), loadGoals(), loadLifestyleLogs(), loadSettings(), loadCycleEntries()]);
  renderClientNav();
  renderClientView();
}

function renderClientNav(){
  const tabs = [
    {id:'log', label:'Log', ic:'&#9998;'},
    {id:'schedule', label:'Schedule', ic:'&#128197;'},
    {id:'history', label:'History', ic:'&#128337;'},
    {id:'progress', label:'Progress', ic:'&#128200;'},
    {id:'biglifts', label:'Big lifts', ic:'&#127942;'},
    {id:'library', label:'Library', ic:'&#128218;'},
    {id:'program', label:'Program', ic:'&#128203;'},
    {id:'goals', label:'Goals', ic:'&#127942;'},
    {id:'lifestyle', label:'Lifestyle', ic:'&#128202;'},
    {id:'cycle', label:'Cycle', ic:'&#128167;'},
    {id:'correlate', label:'Correlate', ic:'&#128260;'},
  ];
  document.getElementById('navbar').innerHTML = `<div style="display:flex;overflow-x:auto;width:100%;">` + tabs.map(t=>
    `<button class="navbtn ${view===t.id?'active':''}" data-view="${t.id}" style="flex:0 0 auto;min-width:60px;"><span class="ic">${t.ic}</span>${t.label}</button>`
  ).join('') + `</div>`;
  document.querySelectorAll('.navbtn').forEach(b=>{
    b.onclick = ()=>{ view = b.dataset.view; renderClientNav(); renderClientView(); };
  });
}

function renderClientView(){
  const main = document.getElementById('mainContent');
  if(view === 'log') renderLog(main);
  else if(view === 'schedule') renderSchedule(main);
  else if(view === 'history') renderHistory(main);
  else if(view === 'progress') renderProgress(main);
  else if(view === 'biglifts') renderBigLifts(main);
  else if(view === 'library') renderLibraryTab(main);
  else if(view === 'program') renderProgram(main);
  else if(view === 'goals') renderGoals(main);
  else if(view === 'lifestyle') renderLifestyle(main);
  else if(view === 'cycle') renderCycle(main);
  else if(view === 'correlate') renderCorrelate(main);
}

// ---------- DATA LOADING (client) ----------
// CONFIRMED: plans(client_id, plan_data jsonb, updated_at) — one row per client
async function loadPlan(){
  const { data, error } = await supabaseClient.from('plans').select('plan_data').eq('client_id', activeClientId).maybeSingle();
  if(error){ showToast("Couldn't load your program"); plan = {}; return; }
  plan = (data && data.plan_data) ? data.plan_data : {};
}

// CONFIRMED: sessions(id, client_id, date, day_key, day_label, warmup, note, exercises jsonb, cardio jsonb, created_at, updated_at)
async function loadSessions(){
  const { data, error } = await supabaseClient.from('sessions').select('*').eq('client_id', activeClientId).order('date', { ascending: false });
  if(error){ showToast("Couldn't load your session history"); sessions = []; return; }
  sessions = data || [];
}

async function loadGoals(){
  const { data, error } = await supabaseClient.from('goals').select('*').eq('client_id', activeClientId);
  if(error){ goals = []; return; }
  goals = data || [];
}

async function loadLifestyleLogs(){
  const { data, error } = await supabaseClient.from('lifestyle_logs').select('*').eq('client_id', activeClientId).order('date', { ascending: false });
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
    bar.style.cssText = 'position:fixed;bottom:58px;left:0;right:0;padding:12px 18px;background:var(--surface);border-top:1px solid var(--border);z-index:29;';
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
  const { error } = await supabaseClient.from('sessions').upsert({
    client_id: activeClientId,
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
  const clinicianToolbar = viewingAsClinician ? `<div style="display:flex;gap:10px;margin-bottom:14px;">
    <button id="editFullProgramBtn" class="btn secondary" style="flex:1;">Edit full program</button>
    <button id="importNotesBtn" class="btn secondary" style="flex:1;">Import from notes</button>
  </div>` : '';
  if(days.length === 0){
    main.innerHTML = `<div style="padding:16px 18px;">${clinicianToolbar}<div class="emptystate">${viewingAsClinician ? 'No program set yet — tap "Edit full program" to build one.' : 'No program set yet — check with your clinician.'}</div></div>`;
    if(viewingAsClinician){
      document.getElementById('editFullProgramBtn').onclick = ()=>renderProgramEditor(main);
      document.getElementById('importNotesBtn').onclick = ()=>renderProgramImportForm(main);
    }
    return;
  }
  main.innerHTML = `<div style="padding:16px 18px;">` + clinicianToolbar + days.map(dayKey=>{
    const day = plan[dayKey];
    if(day.type !== 'lift') return `<div class="card"><div class="section-label">${escapeHtml(dayKey)}</div><div style="font-size:13px;color:var(--text-dim);">${escapeHtml(day.desc||day.label||'Rest / cardio')}</div></div>`;
    return `<div class="card">
      <div class="section-label">${escapeHtml(dayKey)} — ${escapeHtml(day.label||'')}</div>
      ${(day.exercises||[]).map((ex,exIdx)=>`
        <div style="padding:8px 0;border-top:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-family:var(--font-display);font-weight:600;font-size:14px;color:${ex.hero?'var(--rust)':'var(--text)'};">${ex.hero?'&#9733; ':''}${escapeHtml(ex.name)}</div>
            <div class="eyebrow">${escapeHtml(ex.target||'')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:4px;flex-wrap:wrap;">
            ${ex.videoUrl ? `<a class="videoLink" href="${escapeAttr(ex.videoUrl)}" target="_blank" rel="noopener">&#9654; Watch demo</a>` : `<span style="font-size:11px;color:var(--text-faint);">No video linked</span>`}
            <button class="editVideoBtn" data-day="${escapeAttr(dayKey)}" data-idx="${exIdx}" style="background:none;border:none;color:#6E93AC;font-size:11px;font-family:var(--font-mono);">edit link</button>
            <button class="toggleHeroBtn" data-day="${escapeAttr(dayKey)}" data-idx="${exIdx}" style="background:none;border:none;color:${ex.hero?'var(--rust)':'var(--text-faint)'};font-size:11px;font-family:var(--font-mono);">${ex.hero?'unmark big lift':'mark as big lift'}</button>
          </div>
        </div>
      `).join('')}
    </div>`;
  }).join('') + `</div>`;

  if(viewingAsClinician){
    document.getElementById('editFullProgramBtn').onclick = ()=>renderProgramEditor(main);
    document.getElementById('importNotesBtn').onclick = ()=>renderProgramImportForm(main);
  }
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
  main.querySelectorAll('.toggleHeroBtn').forEach(b=>{
    b.onclick = ()=>{
      const dayKey = b.dataset.day, idx = +b.dataset.idx;
      plan[dayKey].exercises[idx].hero = !plan[dayKey].exercises[idx].hero;
      saveVideoUrl(dayKey, idx);
    };
  });
}

async function saveVideoUrl(){
  // CONFIRMED: plans(client_id, plan_data jsonb) — upsert the whole plan_data object
  const { error } = await supabaseClient.from('plans').upsert({ client_id: activeClientId, plan_data: plan }, { onConflict: 'client_id' });
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
      const { error } = await supabaseClient.from('goals').delete().eq('id', existing.id);
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
      client_id: activeClientId,
      exercise_key: canonicalKey(label),
      exercise_label: label,
      target_weight: weight ? parseFloat(weight) : null,
      target_reps: reps || null,
      note: note || null,
    };
    if(existing) row.id = existing.id;
    // goals has a unique(client_id, exercise_key) constraint — upsert handles both new and edited goals
    const { error } = await supabaseClient.from('goals').upsert(row, { onConflict: 'client_id,exercise_key' });
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
      client_id: activeClientId,
      date: today,
      steps: document.getElementById('lsSteps').value ? parseInt(document.getElementById('lsSteps').value,10) : null,
      sleep_hours: document.getElementById('lsSleep').value ? parseFloat(document.getElementById('lsSleep').value) : null,
      sleep_quality: document.getElementById('lsQuality').value || null,
      nutrition_note: document.getElementById('lsNutrition').value.trim() || null,
      other_note: document.getElementById('lsOther').value.trim() || null,
    };
    const { error } = await supabaseClient.from('lifestyle_logs').upsert(row, { onConflict: 'client_id,date' });
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
  const { data, error } = await supabaseClient.from('clients').select('*').eq('clinician_id', currentUser.id);
  if(error){ showToast("Couldn't load your clients"); clinicianClients = []; return; }
  clinicianClients = data || [];
  if(clinicianClients.length > 0){
    const ids = clinicianClients.map(c=>c.id);
    const { data: profileRows, error: profErr } = await supabaseClient.from('profiles').select('id, full_name').in('id', ids);
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
    row.onclick = ()=>{
      const client = clinicianClients.find(c=>c.id===row.dataset.id);
      enterClientAsClinician(row.dataset.id, client?client.full_name:'Client');
    };
  });
}

// ============================================================
// SETTINGS (start date, for Schedule's week/phase calc)
// ============================================================
let settings = { startDate: null };

async function loadSettings(){
  const { data, error } = await supabaseClient.from('settings').select('*').eq('client_id', activeClientId).maybeSingle();
  if(error || !data || !data.start_date){ settings.startDate = todayISO(); return; }
  settings.startDate = data.start_date;
}
async function saveStartDate(newDate){
  const { error } = await supabaseClient.from('settings').upsert({ client_id: activeClientId, start_date: newDate }, { onConflict: 'client_id' });
  if(error){ showToast("Couldn't save — " + error.message); return; }
  settings.startDate = newDate;
  showToast('Start date updated');
}
function getWeekAndPhase(dateISOStr){
  const start = new Date(settings.startDate + 'T00:00:00');
  const now = new Date((dateISOStr||todayISO()) + 'T00:00:00');
  const diffDays = Math.floor((now - start) / 86400000);
  let week = Math.floor(diffDays / 7) + 1;
  if(week < 1) week = 1;
  const capped = Math.min(week, 12);
  let phase, deload = false;
  if(capped <= 3) phase = 'Build';
  else if(capped === 4){ phase = 'Deload'; deload = true; }
  else if(capped <= 7) phase = 'Build';
  else if(capped === 8){ phase = 'Deload'; deload = true; }
  else if(capped <= 11) phase = 'Peak';
  else phase = 'Consolidate';
  if(week > 12) phase = 'Complete';
  return { week, phase, deload };
}
function addDaysISO(iso, n){
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function weekdayForISO(iso){
  return new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, weekday:'long' }).format(new Date(iso + 'T12:00:00'));
}

// ============================================================
// SCHEDULE VIEW
// ============================================================
function renderSchedule(main){
  const today = todayISO();
  const { week: currentWeek, phase: currentPhase } = getWeekAndPhase(today);
  let html = `
    <div style="padding:16px 18px;">
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
      <div><div class="eyebrow">Week</div><div style="font-family:var(--font-display);font-weight:700;font-size:20px;">${currentPhase==='Complete'?`${currentWeek} · Done`:`${Math.min(currentWeek,12)} / 12`}</div></div>
      <div class="eyebrow" style="color:var(--brass);">${escapeHtml(currentPhase)}</div>
    </div>
    <div class="field" style="margin-top:10px;"><label>Block start date</label>
      <input type="date" id="startDateInput" value="${settings.startDate}">
    </div>
    <div class="section-label" style="margin-top:16px;">Next 14 days</div>
  `;
  for(let i=0;i<14;i++){
    const iso = addDaysISO(today, i);
    const dayName = weekdayForISO(iso);
    const day = plan[dayName];
    const { phase, deload } = getWeekAndPhase(iso);
    const isToday = i === 0;
    const logged = sessions.some(s=>s.date===iso);
    let exList = day ? (day.type==='lift' ? (day.exercises||[]).map(e=>e.name).join(', ') : (day.desc||'')) : 'No program set';
    html += `<div class="card" style="${isToday?'border-color:var(--brass);':''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        <div>
          <div class="eyebrow" style="color:${isToday?'var(--brass)':'var(--text-faint)'};">${isToday?'TODAY · ':''}${dayName.toUpperCase()} · ${formatAU(iso)}</div>
          <div style="font-family:var(--font-display);font-weight:600;font-size:14px;">${escapeHtml(day?day.label||dayName:'Rest')}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
          ${logged?'<span class="chip" style="background:var(--sage-dim);color:var(--sage);border-color:var(--sage-dim);">LOGGED</span>':''}
          ${deload?'<span class="chip" style="background:var(--sage-dim);color:var(--sage);border-color:var(--sage-dim);">DELOAD</span>':''}
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-dim);">${escapeHtml(exList)}</div>
      <button class="scheduleLogBtn" data-date="${iso}" data-day="${escapeAttr(dayName)}" style="background:none;border:none;color:${logged?'var(--sage)':'var(--brass)'};font-family:var(--font-mono);font-size:11px;margin-top:6px;">${logged?'✓ LOGGED — TAP TO EDIT':'LOG THIS SESSION →'}</button>
    </div>`;
  }
  html += `</div>`;
  main.innerHTML = html;
  document.getElementById('startDateInput').onchange = e=>saveStartDate(e.target.value);
  main.querySelectorAll('.scheduleLogBtn').forEach(b=>{
    b.onclick = ()=>{
      logState.date = b.dataset.date;
      logState.dayKey = b.dataset.day;
      logState._initedForPlan = false;
      const existing = sessions.find(s=>s.date===b.dataset.date);
      if(existing){
        logState.exercises = (existing.exercises||[]).map(e=>({ id: uid(), name: e.name, target: e.target||'', videoUrl: videoUrlForExerciseName(e.name), sets: (e.sets||[]).map(s=>({...s})) }));
        logState.note = existing.note || '';
        logState._initedForPlan = true;
      }
      view = 'log';
      renderClientNav(); renderClientView();
    };
  });
}

// ============================================================
// PROGRESS VIEW
// ============================================================
let progressGroupKey = null;
function groupedExerciseOptions(){
  const groupNameCounts = {};
  function addName(name){
    const key = canonicalKey(name);
    if(!key) return;
    groupNameCounts[key] = groupNameCounts[key] || {};
    groupNameCounts[key][name] = (groupNameCounts[key][name]||0) + 1;
  }
  Object.values(plan).forEach(d=>(d.exercises||[]).forEach(e=>addName(e.name)));
  sessions.forEach(s=>(s.exercises||[]).forEach(e=>addName(e.name)));
  const options = Object.keys(groupNameCounts).map(key=>{
    const counts = groupNameCounts[key];
    const bestName = Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
    return { key, label: bestName };
  });
  options.sort((a,b)=>a.label.localeCompare(b.label));
  return options;
}
function topWeight(ex){
  const nums = (ex.sets||[]).map(s=>parseFloat(s.weight)).filter(n=>!isNaN(n));
  return nums.length ? Math.max(...nums) : null;
}
function renderProgress(main){
  const options = groupedExerciseOptions();
  if(options.length === 0){
    main.innerHTML = `<div style="padding:16px 18px;"><div class="emptystate">Log a few sessions to see progress trends here.</div></div>`;
    return;
  }
  if(!progressGroupKey || !options.some(o=>o.key===progressGroupKey)) progressGroupKey = options[0].key;
  const data = sessions.filter(s=>(s.exercises||[]).some(e=>canonicalKey(e.name)===progressGroupKey))
    .map(s=>{ const ex = s.exercises.find(e=>canonicalKey(e.name)===progressGroupKey); return {date:s.date, weight: topWeight(ex)}; })
    .filter(d=>d.weight!==null).sort((a,b)=>a.date.localeCompare(b.date));
  const latest = data.length ? data[data.length-1].weight : null;
  const best = data.length ? Math.max(...data.map(d=>d.weight)) : null;
  const currentLabel = (options.find(o=>o.key===progressGroupKey)||{}).label || '';
  const activeGoal = goals.find(g=>g.exercise_key===progressGroupKey && !g.achieved);

  let goalHtml;
  if(activeGoal && activeGoal.target_weight){
    const pct = best!==null ? Math.max(4, Math.min(100, Math.round((best/activeGoal.target_weight)*100))) : 4;
    goalHtml = `<div class="card">
      <div class="eyebrow" style="margin-bottom:6px;">Goal</div>
      <div style="font-family:var(--font-display);font-weight:600;font-size:15px;margin-bottom:8px;">${activeGoal.target_weight}kg${activeGoal.target_reps?' × '+escapeHtml(activeGoal.target_reps):''}</div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--brass);"></div></div>
    </div>`;
  } else {
    goalHtml = `<div class="emptystate" style="padding:12px 0;">No goal set for ${escapeHtml(currentLabel)} yet — set one in the Goals tab.</div>`;
  }

  main.innerHTML = `<div style="padding:16px 18px;">
    <div class="field"><label>Lift</label>
      <select id="progressSelect" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:11px;font-size:15px;">
        ${options.map(o=>`<option value="${escapeAttr(o.key)}" ${o.key===progressGroupKey?'selected':''}>${escapeHtml(o.label)}</option>`).join('')}
      </select>
    </div>
    <div style="display:flex;gap:10px;margin:14px 0;">
      <div class="card" style="flex:1;"><div class="eyebrow">Latest top set</div><div style="font-family:var(--font-display);font-weight:700;font-size:18px;">${latest!==null?latest+'kg':'—'}</div></div>
      <div class="card" style="flex:1;"><div class="eyebrow">Best logged</div><div style="font-family:var(--font-display);font-weight:700;font-size:18px;color:var(--brass);">${best!==null?best+'kg':'—'}</div></div>
    </div>
    ${goalHtml}
    <div id="progressChart" style="margin-top:14px;"></div>
  </div>`;
  document.getElementById('progressSelect').onchange = e=>{ progressGroupKey = e.target.value; renderProgress(main); };
  renderLineChart(document.getElementById('progressChart'), data, '#4CA893');
}

function renderLineChart(container, data, colorHex, small){
  if(!data || data.length < 2){
    container.innerHTML = `<div style="text-align:center;padding:30px 0;color:var(--text-faint);font-size:13px;">${!data||data.length===0?'No sets logged for this lift yet':'Log one more session to see a trend'}</div>`;
    return;
  }
  const w = 600, h = small ? 140 : 220, padL = 36, padR = 10, padT = 14, padB = 22;
  const weights = data.map(d=>d.weight);
  const minW = Math.min(...weights), maxW = Math.max(...weights);
  const range = (maxW - minW) || 1;
  const yFor = v => padT + (1 - (v - minW + range*0.1) / (range*1.2)) * (h - padT - padB);
  const xFor = i => padL + (i/(data.length-1)) * (w - padL - padR);
  let path = data.map((d,i)=>`${i===0?'M':'L'} ${xFor(i).toFixed(1)} ${yFor(d.weight).toFixed(1)}`).join(' ');
  let dots = data.map((d,i)=>`<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(d.weight).toFixed(1)}" r="3" fill="${colorHex}"/>`).join('');
  let gridlines = '';
  for(let i=0;i<=2;i++){
    const y = padT + i*(h-padT-padB)/2;
    gridlines += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w-padR}" y2="${y.toFixed(1)}" stroke="#333438" stroke-width="1" stroke-dasharray="3,3"/>`;
  }
  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${gridlines}
    <text x="${padL}" y="${padT-2}" fill="#67655F" font-size="9" font-family="IBM Plex Mono, monospace">${maxW}kg</text>
    <text x="${padL}" y="${h-padB+12}" fill="#67655F" font-size="9" font-family="IBM Plex Mono, monospace">${minW}kg</text>
    <path d="${path}" fill="none" stroke="${colorHex}" stroke-width="2"/>
    ${dots}
    <text x="${padL}" y="${h-4}" fill="#67655F" font-size="9" font-family="IBM Plex Mono, monospace">${formatAU(data[0].date).slice(0,5)}</text>
    <text x="${w-padR}" y="${h-4}" fill="#67655F" font-size="9" font-family="IBM Plex Mono, monospace" text-anchor="end">${formatAU(data[data.length-1].date).slice(0,5)}</text>
  </svg>`;
}

// ============================================================
// BIG LIFTS VIEW
// ============================================================
function renderBigLifts(main){
  const heroGroups = new Map();
  Object.values(plan).forEach(d=>(d.exercises||[]).forEach(e=>{
    if(e.hero && e.name && e.name.trim()){
      const key = canonicalKey(e.name);
      if(key && !heroGroups.has(key)) heroGroups.set(key, e.name);
    }
  }));
  main.innerHTML = `<div style="padding:16px 18px;"><div class="section-label">Your big lifts over time</div><div id="biglifts-body"></div></div>`;
  const body = document.getElementById('biglifts-body');
  if(heroGroups.size === 0){
    body.innerHTML = `<div class="emptystate">Mark an exercise as a "big lift" in Program to track its trend here.</div>`;
    return;
  }
  const palette = ['#C49A45','#6E93AC','#8A9A79','#C15C33','#9B7EDE','#C97F9A'];
  const sorted = [...sessions].sort((a,b)=>a.date.localeCompare(b.date));
  let i = 0;
  heroGroups.forEach((label, key)=>{
    const color = palette[i++ % palette.length];
    const data = sorted.map(s=>{
      const ex = (s.exercises||[]).find(e=>canonicalKey(e.name)===key);
      if(!ex) return null;
      const w = topWeight(ex);
      return w!==null ? {date:s.date, weight:w} : null;
    }).filter(Boolean);
    const first = data[0]?.weight, last = data[data.length-1]?.weight;
    const delta = (first!==undefined && last!==undefined) ? Math.round((last-first)*100)/100 : null;
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-family:var(--font-display);font-weight:600;font-size:15px;">${escapeHtml(label)}</div>
        <div style="text-align:right;">
          <div style="font-family:var(--font-display);font-weight:700;font-size:16px;color:${color};">${last!==undefined?last+'kg':'—'}</div>
          ${delta!==null?`<div style="font-size:11px;color:${delta>0?'var(--sage)':delta<0?'var(--rust)':'var(--text-faint)'};">${delta>0?'+':''}${delta}kg since ${formatAU(data[0].date)}</div>`:''}
        </div>
      </div>
      <div class="chart-slot"></div>
    `;
    body.appendChild(div);
    renderLineChart(div.querySelector('.chart-slot'), data, color, true);
  });
}

// ============================================================
// LIBRARY VIEW (browse-only reference)
// ============================================================
const EXERCISE_LIBRARY = {"Squat pattern":["Barbell Back Squat","Barbell Front Squat","Goblet Squat","Lunges","Bulgarian Split Squat","Hack Squats","Leg Press","Pendulum Squat"],"Hinging":["Deadlift","BB Romanian Deadlift","Barbell Hip Thrust","Kas Glute Bridge","45 Degree Extension","DB Romanian Deadlift","Glute Ham Raise"],"Isolation (lower)":["Supine Bench Hamstring Curl","Seated Calf Raises","Seated Hamstring Curl Machine","Standing Calf Raise Machine","Leg Extensions"],"Pulling":["Lat Focused Neutral Grip Pulldown","Bent over barbell row","Single arm DB Rows","Prone grip seated cable row","Chest Supported T Bar Row"],"Upper pressing":["Barbell Bench Press","DB Flat Bench Press","DB Incline Bench Press","Machine Shoulder Press","DB Seated Shoulder Press"],"Isolation (upper)":["Rear delt cable fly","Bicep Curls","Cable Lateral Raise","Cross body Tricep Extensions","DB Lateral Raise"],"Mobility & warm-up":["Banded Around the Worlds","Bottom Under Press","Lat Stretch","Thoracic Extension","Spiderman"]};
let libraryCategoryFilter = 'all';
function renderLibraryTab(main){
  const cats = Object.keys(EXERCISE_LIBRARY);
  main.innerHTML = `<div style="padding:16px 18px;">
    <input type="text" id="libTabSearchInput" placeholder="Search exercises…" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:10px;font-size:14px;margin-bottom:12px;">
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;" id="libTabCatChips">
      <button class="libTabCatChip" data-cat="all" style="background:${libraryCategoryFilter==='all'?'var(--brass)':'var(--surface-2)'};color:${libraryCategoryFilter==='all'?'#0A1F1A':'var(--text-dim)'};border:1px solid var(--border);border-radius:20px;padding:6px 12px;font-size:12px;">All</button>
      ${cats.map(c=>`<button class="libTabCatChip" data-cat="${escapeAttr(c)}" style="background:${libraryCategoryFilter===c?'var(--brass)':'var(--surface-2)'};color:${libraryCategoryFilter===c?'#0A1F1A':'var(--text-dim)'};border:1px solid var(--border);border-radius:20px;padding:6px 12px;font-size:12px;">${escapeHtml(c)}</button>`).join('')}
    </div>
    <div id="libTabResults"></div>
  </div>`;
  function renderResults(filter){
    const q = (filter||'').trim().toLowerCase();
    const resultsEl = document.getElementById('libTabResults');
    let rhtml = '';
    cats.forEach(cat=>{
      if(libraryCategoryFilter !== 'all' && libraryCategoryFilter !== cat) return;
      const items = EXERCISE_LIBRARY[cat].filter(name=>!q || name.toLowerCase().includes(q));
      if(items.length === 0) return;
      rhtml += `<div class="card"><div class="eyebrow" style="margin-bottom:8px;color:var(--brass);">${escapeHtml(cat)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${items.map(name=>`<span class="chip">${escapeHtml(name)}</span>`).join('')}</div>
      </div>`;
    });
    resultsEl.innerHTML = rhtml || `<div class="emptystate">No exercises match your search.</div>`;
  }
  renderResults('');
  document.getElementById('libTabSearchInput').oninput = e=>renderResults(e.target.value);
  main.querySelectorAll('.libTabCatChip').forEach(b=>{
    b.onclick = ()=>{ libraryCategoryFilter = b.dataset.cat; renderLibraryTab(main); };
  });
}

// ============================================================
// CYCLE VIEW — full structured version, matching cycle_entries schema
// ============================================================
const FLOW_LEVELS = ['None','Spotting','Light','Medium','Heavy'];
const MENSTRUAL_SYMPTOMS = ['Dysmenorrhoea','Menorrhagia','Bloating','Fatigue','Headache/migraine','Breast tenderness','Mood lability','Nausea','Lumbopelvic pain','Sleep disruption','Cravings','Joint laxity (subjective)'];
const SYMPTOM_DOMAINS = [
  { key:'urinary', label:'URINARY', items:['SUI','UUI','MUI','Urgency','Frequency (>8/day)','Nocturia','Hesitancy','Slow/intermittent stream','Incomplete emptying','Post-void dribble','Dysuria'], color:'#5B8AA6' },
  { key:'prolapse', label:'PROLAPSE / POP', items:['Vaginal heaviness/dragging','Visible/palpable bulge','Anterior compartment','Apical/uterine','Posterior compartment','Worse end of day','Worse with load','Splinting required'], color:'#9B7EDE' },
  { key:'bowel', label:'BOWEL / ANORECTAL', items:['Obstructed defecation','Straining','Digital splinting','Faecal urgency','Flatal incontinence','Faecal incontinence','Incomplete evacuation'], color:'#6E9B6E' },
  { key:'sexual', label:'SEXUAL FUNCTION', items:['Superficial dyspareunia','Deep dyspareunia','Reduced sensation','Coital incontinence'], color:'#C97F9A' },
  { key:'abdominal', label:'ABDOMINAL WALL / DRA / SCAR', items:['Coning/doming','IRD widening (subjective)','Loss of linea alba tension','LSCS scar pain','LSCS scar tethering','Scar numbness/hypersensitivity'], color:'#C99A3D' },
  { key:'msk', label:'LUMBOPELVIC MSK', items:['Pelvic girdle pain','SIJ pain','Pubic symphysis pain','Lumbar pain','Levator tenderness','Levator overactivity','Hamstring origin pain'], color:'#B4574B' },
];
const CYCLE_PHASES = ['Auto','Menstrual','Follicular','Ovulatory','Early luteal','Late luteal'];
const ONSET_TIMING = ['Nil','During session','Immediate post (<1h)','Same day (1–12h)','24h post','48h post'];
const SETTLING = ['Settled within session','Settled <24h','Settled 24–48h','Ongoing >48h'];
const LOAD_TOLERANCE = ['Better than usual','As expected','Worse than usual'];
const BREATH_STRATEGIES = ['Exhale on exertion','Breath-hold / Valsalva','Continuous breathing','360 brace','Belt used','Band used'];
const PROM_INSTRUMENTS = [ { name:'ICIQ-UI SF', max:21 }, { name:'PFDI-20', max:300 }, { name:'POPDI-6', max:100 }, { name:'CRADI-8', max:100 }, { name:'UDI-6', max:100 }, { name:'PFIQ-7', max:300 }, { name:'APFQ', max:40 } ];

let cycleEntries = [];
let cycleState = null;
let showProms = false;
function freshCycleState(dateStr){
  return {
    date: dateStr, flow:'None', periodStart:false, phaseOverride:'Auto',
    menstrualSymptoms: [], domains: {}, nrs: {}, timing: {},
    settling:'', tolerance:'', followUp24h:false, provocation:'',
    breath: [], proms: {}, note: '',
  };
}
async function loadCycleEntries(){
  const { data, error } = await supabaseClient.from('cycle_entries').select('*').eq('client_id', activeClientId).order('date', { ascending: false });
  if(error){ cycleEntries = []; return; }
  cycleEntries = data || [];
  if(!cycleState) cycleState = freshCycleState(todayISO());
}
function loadCycleStateForDate(dateStr){
  const found = cycleEntries.find(e=>e.date===dateStr);
  if(found){
    cycleState = {
      date: dateStr, flow: found.flow||'None', periodStart: !!found.period_start, phaseOverride: found.phase_override||'Auto',
      menstrualSymptoms: found.menstrual_symptoms||[], domains: found.domains||{}, nrs: found.nrs||{}, timing: found.timing||{},
      settling: found.settling||'', tolerance: found.tolerance||'', followUp24h: !!found.follow_up_24h,
      provocation: found.provocation||'', breath: found.breath||[], proms: found.proms||{}, note: found.note||'',
    };
  } else {
    cycleState = freshCycleState(dateStr);
  }
}
function derivePhase(cycleDay){
  if(cycleDay===null) return null;
  if(cycleDay<=5) return 'Menstrual';
  if(cycleDay<=12) return 'Follicular';
  if(cycleDay<=15) return 'Ovulatory';
  if(cycleDay<=22) return 'Early luteal';
  return 'Late luteal';
}
function getCycleDayFor(dateStr){
  const starts = cycleEntries.filter(e=>e.period_start && e.date<=dateStr).map(e=>e.date).sort();
  if(!starts.length) return null;
  const last = starts[starts.length-1];
  const ms = new Date(dateStr+'T00:00:00') - new Date(last+'T00:00:00');
  return Math.round(ms/86400000) + 1;
}
function chipBtn(cls, label, active, color, extraAttrs){
  return `<button class="${cls}" style="background:${active?color:'var(--surface-2)'};border:1px solid ${active?color:'var(--border)'};color:${active?'#0A1F1A':'var(--text-dim)'};border-radius:20px;padding:6px 12px;font-size:12px;margin:0 4px 4px 0;" ${extraAttrs||''}>${escapeHtml(label)}</button>`;
}
function ensureDomain(key){
  if(!cycleState.domains[key]) cycleState.domains[key] = { selected: [], notes: '' };
  return cycleState.domains[key];
}
function renderCycle(main){
  if(!cycleState) cycleState = freshCycleState(todayISO());
  const cycleDay = getCycleDayFor(cycleState.date);
  const autoPhase = derivePhase(cycleDay);
  const effectivePhase = cycleState.phaseOverride === 'Auto' ? autoPhase : cycleState.phaseOverride;
  const sameDaySession = sessions.find(s=>s.date===cycleState.date) || null;

  let html = `<div style="padding:16px 18px;">
  <div class="field"><label>Date</label><input type="date" id="cycleDateInput" value="${cycleState.date}"></div>
  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;font-family:var(--font-mono);font-size:11px;">
    ${cycleDay!==null?`<span style="color:var(--brass);">CYCLE DAY ${cycleDay}</span>`:''}
    ${effectivePhase?`<span style="color:#6E93AC;">· ${effectivePhase.toUpperCase()}</span>`:''}
    ${sameDaySession?`<span style="color:var(--text-faint);">· TRAINING: ${escapeHtml(sameDaySession.day_label||sameDaySession.day_key||'').toUpperCase()}</span>`:''}
  </div>

  <div class="card">
    <div class="section-label">Quick log</div>
    <button id="nilSymptomsBtn" style="width:100%;padding:11px;border-radius:9px;border:1px solid var(--sage);background:none;color:var(--sage);font-size:13px;">&#10003; Nil symptoms today</button>
  </div>

  <div class="section-label">Flow</div>
  <div style="margin-bottom:10px;">${FLOW_LEVELS.map(f=>chipBtn('flowchip', f, cycleState.flow===f, 'var(--rust)', `data-val="${f}"`)).join('')}</div>
  <button id="periodStartBtn" style="width:100%;text-align:left;background:none;border:none;color:${cycleState.periodStart?'var(--brass)':'var(--text-dim)'};padding:8px 0;margin-bottom:10px;">${cycleState.periodStart?'&#9745;':'&#9744;'} Day 1 of cycle</button>

  <div class="eyebrow" style="margin-bottom:6px;">PHASE ${autoPhase?`(auto: ${autoPhase})`:'(log a day 1 to auto-derive)'}</div>
  <div style="margin-bottom:14px;">${CYCLE_PHASES.map(p=>chipBtn('phasechip', p, cycleState.phaseOverride===p, '#6E93AC', `data-val="${p}"`)).join('')}</div>

  <div class="section-label">Menstrual symptoms</div>
  <div style="margin-bottom:16px;">${MENSTRUAL_SYMPTOMS.map(s=>chipBtn('menstrualChip', s, cycleState.menstrualSymptoms.includes(s), 'var(--rust)', `data-val="${escapeAttr(s)}"`)).join('')}</div>
  `;

  SYMPTOM_DOMAINS.forEach(domain=>{
    const d = ensureDomain(domain.key);
    html += `<div class="card">
      <div class="eyebrow" style="color:${domain.color};margin-bottom:8px;">${domain.label}</div>
      <div style="margin-bottom:10px;">${domain.items.map(item=>chipBtn('domainChip', item, d.selected.includes(item), domain.color, `data-domain="${domain.key}" data-val="${escapeAttr(item)}"`)).join('')}</div>
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        <div style="flex:1;">
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px;">Pain/severity (0–10)</label>
          <input type="number" min="0" max="10" class="domainNrsInput" data-domain="${domain.key}" value="${cycleState.nrs[domain.key]??''}" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px;font-size:13px;">
        </div>
        <div style="flex:1;">
          <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:4px;">Onset timing</label>
          <select class="domainTimingSelect" data-domain="${domain.key}" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px;font-size:13px;">
            <option value="">—</option>
            ${ONSET_TIMING.map(t=>`<option value="${t}" ${cycleState.timing[domain.key]===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <textarea class="domainNotesInput" data-domain="${domain.key}" rows="2" placeholder="Notes…" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px;font-size:13px;">${escapeHtml(d.notes)}</textarea>
    </div>`;
  });

  html += `
  <div class="card">
    <div class="section-label">Settling & tolerance</div>
    <div class="eyebrow" style="margin:8px 0 4px;">Settling</div>
    <div style="margin-bottom:8px;">${SETTLING.map(s=>chipBtn('settlingChip', s, cycleState.settling===s, '#6E93AC', `data-val="${escapeAttr(s)}"`)).join('')}</div>
    <div class="eyebrow" style="margin:8px 0 4px;">Load tolerance</div>
    <div style="margin-bottom:8px;">${LOAD_TOLERANCE.map(t=>chipBtn('toleranceChip', t, cycleState.tolerance===t, 'var(--sage)', `data-val="${escapeAttr(t)}"`)).join('')}</div>
    <button id="followUpBtn" style="width:100%;text-align:left;background:none;border:none;color:${cycleState.followUp24h?'var(--rust)':'var(--text-dim)'};padding:8px 0;">${cycleState.followUp24h?'&#9745;':'&#9744;'} Flag for 24h review</button>
  </div>

  <div class="field" style="margin-top:14px;"><label>Provocation</label><input type="text" id="provocationInput" value="${escapeAttr(cycleState.provocation)}" placeholder="What seemed to trigger it?"></div>

  <div class="section-label" style="margin-top:14px;">Breath strategy used</div>
  <div style="margin-bottom:14px;">${BREATH_STRATEGIES.map(b=>chipBtn('breathChip', b, cycleState.breath.includes(b), 'var(--brass)', `data-val="${escapeAttr(b)}"`)).join('')}</div>

  <button id="togglePromsBtn" style="background:none;border:none;color:var(--brass);font-family:var(--font-mono);font-size:11px;margin-bottom:10px;">${showProms?'HIDE':'SHOW'} PROMs (outcome measures)</button>
  ${showProms ? `<div class="card">${PROM_INSTRUMENTS.map(p=>`
    <div class="field"><label>${escapeHtml(p.name)} (0–${p.max})</label>
      <input type="number" min="0" max="${p.max}" class="promInput" data-name="${escapeAttr(p.name)}" value="${cycleState.proms[p.name]??''}">
    </div>`).join('')}</div>` : ''}

  <div class="field" style="margin:14px 0;"><label>Clinical notes</label><textarea id="cycleNoteInput" rows="3">${escapeHtml(cycleState.note)}</textarea></div>
  <button class="btn" id="saveCycleBtn" style="margin-bottom:24px;">Save entry</button>

  <div class="section-label">Logged entries</div>
  ${cycleEntries.length===0 ? '<div class="emptystate">Nothing logged yet.</div>' : cycleEntries.map(e=>`
    <div class="card">
      <div class="histdate">${formatAU(e.date)}${e.cycle_day?` · CD${e.cycle_day}`:''}${e.resolved_phase?` · ${e.resolved_phase.toUpperCase()}`:''}</div>
      <div style="font-family:var(--font-display);font-weight:600;font-size:14px;color:${e.nil_symptoms?'var(--sage)':'var(--text)'};">${e.nil_symptoms?'Nil symptoms':(e.flow&&e.flow!=='None'?'Flow: '+e.flow:'Logged')}</div>
      <button class="editCycleBtn" data-date="${e.date}" style="background:none;border:none;color:var(--brass);font-family:var(--font-mono);font-size:11px;margin-top:6px;">EDIT ENTRY</button>
    </div>
  `).join('')}
  </div>`;

  main.innerHTML = html;
  wireCycleView(main);
}
function wireCycleView(main){
  document.getElementById('cycleDateInput').onchange = e=>{ loadCycleStateForDate(e.target.value); renderCycle(main); };
  document.getElementById('periodStartBtn').onclick = ()=>{ cycleState.periodStart = !cycleState.periodStart; renderCycle(main); };
  document.getElementById('followUpBtn').onclick = ()=>{ cycleState.followUp24h = !cycleState.followUp24h; renderCycle(main); };
  document.getElementById('provocationInput').oninput = e=>cycleState.provocation = e.target.value;
  document.getElementById('cycleNoteInput').oninput = e=>cycleState.note = e.target.value;
  document.getElementById('togglePromsBtn').onclick = ()=>{ showProms = !showProms; renderCycle(main); };
  main.querySelectorAll('.flowchip').forEach(b=>b.onclick=()=>{ cycleState.flow=b.dataset.val; renderCycle(main); });
  main.querySelectorAll('.phasechip').forEach(b=>b.onclick=()=>{ cycleState.phaseOverride=b.dataset.val; renderCycle(main); });
  main.querySelectorAll('.menstrualChip').forEach(b=>b.onclick=()=>{
    const v = b.dataset.val;
    cycleState.menstrualSymptoms = cycleState.menstrualSymptoms.includes(v) ? cycleState.menstrualSymptoms.filter(x=>x!==v) : [...cycleState.menstrualSymptoms, v];
    renderCycle(main);
  });
  main.querySelectorAll('.domainChip').forEach(b=>b.onclick=()=>{
    const d = ensureDomain(b.dataset.domain), v = b.dataset.val;
    d.selected = d.selected.includes(v) ? d.selected.filter(x=>x!==v) : [...d.selected, v];
    renderCycle(main);
  });
  main.querySelectorAll('.domainNrsInput').forEach(inp=>inp.oninput = ()=>{ cycleState.nrs[inp.dataset.domain] = inp.value===''?null:parseInt(inp.value,10); });
  main.querySelectorAll('.domainTimingSelect').forEach(sel=>sel.onchange = ()=>{ cycleState.timing[sel.dataset.domain] = sel.value; });
  main.querySelectorAll('.domainNotesInput').forEach(ta=>ta.oninput = ()=>{ ensureDomain(ta.dataset.domain).notes = ta.value; });
  main.querySelectorAll('.settlingChip').forEach(b=>b.onclick=()=>{ cycleState.settling=b.dataset.val; renderCycle(main); });
  main.querySelectorAll('.toleranceChip').forEach(b=>b.onclick=()=>{ cycleState.tolerance=b.dataset.val; renderCycle(main); });
  main.querySelectorAll('.breathChip').forEach(b=>b.onclick=()=>{
    const v = b.dataset.val;
    cycleState.breath = cycleState.breath.includes(v) ? cycleState.breath.filter(x=>x!==v) : [...cycleState.breath, v];
    renderCycle(main);
  });
  main.querySelectorAll('.promInput').forEach(inp=>inp.oninput = ()=>{ cycleState.proms[inp.dataset.name] = inp.value===''?null:parseInt(inp.value,10); });
  main.querySelectorAll('.editCycleBtn').forEach(b=>{
    b.onclick = ()=>{ loadCycleStateForDate(b.dataset.date); renderCycle(main); window.scrollTo({top:0, behavior:'smooth'}); };
  });
  document.getElementById('saveCycleBtn').onclick = async ()=>{
    const cycleDay = getCycleDayFor(cycleState.date);
    const effectivePhase = cycleState.phaseOverride==='Auto' ? derivePhase(cycleDay) : cycleState.phaseOverride;
    const anySymptoms = cycleState.menstrualSymptoms.length>0 || Object.values(cycleState.domains).some(d=>d.selected.length>0 || (d.notes&&d.notes.trim()));
    const row = {
      client_id: activeClientId, date: cycleState.date, flow: cycleState.flow, period_start: cycleState.periodStart,
      phase_override: cycleState.phaseOverride, resolved_phase: effectivePhase, cycle_day: cycleDay,
      menstrual_symptoms: cycleState.menstrualSymptoms, domains: cycleState.domains, nrs: cycleState.nrs, timing: cycleState.timing,
      settling: cycleState.settling || null, tolerance: cycleState.tolerance || null, follow_up_24h: cycleState.followUp24h,
      provocation: cycleState.provocation || null, breath: cycleState.breath, proms: cycleState.proms, note: cycleState.note || null,
      nil_symptoms: !anySymptoms,
    };
    const { error } = await supabaseClient.from('cycle_entries').upsert(row, { onConflict: 'client_id,date' });
    if(error){ showToast("Couldn't save — " + error.message); return; }
    showToast('Cycle entry saved');
    await loadCycleEntries();
    renderCycle(main);
  };
}

// ============================================================
// CORRELATE VIEW
// ============================================================
function heroLoadsForSession(session){
  if(!session) return null;
  const heroes = (session.exercises||[]).filter(ex=>ex.hero);
  if(!heroes.length) return null;
  return heroes.map(ex=>{ const w = topWeight(ex); return w!==null ? `${ex.name} ${w}kg` : ex.name; }).join(' · ');
}
let correlateCategory = 'all';
function renderCorrelate(main){
  const CATEGORIES = SYMPTOM_DOMAINS.map(d=>({ key: d.key, label: d.label, color: d.color }));
  const rows = [...cycleEntries]
    .map(e=>{
      const session = sessions.find(s=>s.date===e.date) || null;
      const domainNotes = CATEGORIES.map(c=>({ cat:c, entry: (e.domains||{})[c.key] })).filter(n=>n.entry && (n.entry.selected?.length || (n.entry.notes||'').trim()));
      return { entry:e, session, domainNotes };
    })
    .filter(r=>r.domainNotes.length>0 || r.entry.provocation)
    .filter(r=>correlateCategory==='all' || r.domainNotes.some(n=>n.cat.key===correlateCategory));

  const totalLogged = cycleEntries.length;
  const symptomatic = cycleEntries.filter(e=>!e.nil_symptoms).length;
  const pct = totalLogged ? Math.round((symptomatic/totalLogged)*100) : null;

  let html = `<div style="padding:16px 18px;">
  <div style="display:flex;gap:10px;margin-bottom:16px;">
    <div class="card" style="flex:1;"><div class="eyebrow">Days logged</div><div style="font-family:var(--font-display);font-weight:700;font-size:18px;">${totalLogged}</div></div>
    <div class="card" style="flex:1;"><div class="eyebrow">Symptomatic</div><div style="font-family:var(--font-display);font-weight:700;font-size:18px;color:var(--brass);">${symptomatic}${pct!==null?` <span style="font-size:11px;color:var(--text-faint);">· ${pct}%</span>`:''}</div></div>
  </div>
  <div class="section-label">Filter by domain</div>
  <div style="margin-bottom:16px;">
    ${chipBtn('corrFilterChip', 'All', correlateCategory==='all', 'var(--brass)', 'data-val="all"')}
    ${CATEGORIES.map(c=>chipBtn('corrFilterChip', c.label, correlateCategory===c.key, c.color, `data-val="${c.key}"`)).join('')}
  </div>`;

  if(rows.length===0){
    html += `<div class="emptystate">No symptom entries to correlate yet. Log symptoms in the Cycle tab and they'll appear here alongside whatever you trained that day.</div>`;
  } else {
    rows.forEach(r=>{
      const loads = heroLoadsForSession(r.session);
      html += `<div class="card">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
          <span style="font-family:var(--font-mono);font-size:11px;color:var(--brass);">${formatAU(r.entry.date)}${r.entry.cycle_day?` · CD${r.entry.cycle_day}`:''}</span>
          ${r.entry.resolved_phase?`<span style="font-family:var(--font-mono);font-size:10px;color:#6E93AC;">${r.entry.resolved_phase.toUpperCase()}</span>`:''}
        </div>
        ${r.domainNotes.map(n=>`<div style="margin-bottom:6px;"><div class="eyebrow" style="color:${n.cat.color};">${n.cat.label}</div><div style="font-size:13px;">${(n.entry.selected||[]).map(escapeHtml).join(', ')}${n.entry.notes?` — ${escapeHtml(n.entry.notes)}`:''}</div></div>`).join('')}
        ${r.entry.provocation?`<div style="font-size:12px;margin-bottom:6px;">⚑ ${escapeHtml(r.entry.provocation)}</div>`:''}
        <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-top:4px;">
          <div class="eyebrow" style="margin-bottom:2px;">TRAINING THAT DAY</div>
          ${r.session ? `<div style="font-size:12px;">${escapeHtml(r.session.day_label||r.session.day_key||'')}</div>${loads?`<div style="font-family:var(--font-mono);font-size:11px;color:var(--brass);margin-top:2px;">${escapeHtml(loads)}</div>`:''}` : `<div style="font-size:12px;color:var(--text-faint);">No session logged</div>`}
        </div>
        ${(r.entry.settling||r.entry.tolerance||r.entry.follow_up_24h)?`<div style="font-family:var(--font-mono);font-size:10px;margin-top:8px;color:${r.entry.tolerance==='Worse than usual'?'var(--rust)':'var(--text-faint)'};">${[r.entry.settling,r.entry.tolerance].filter(Boolean).join(' · ').toUpperCase()}${r.entry.follow_up_24h?'  ⚑ 24H REVIEW':''}</div>`:''}
      </div>`;
    });
  }
  html += `</div>`;
  main.innerHTML = html;
  main.querySelectorAll('.corrFilterChip').forEach(b=>b.onclick=()=>{ correlateCategory = b.dataset.val; renderCorrelate(main); });
}

// ============================================================
// CLINICIAN PROGRAM EDITOR — build/edit a client's plan_data
// ============================================================
const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

async function saveClinicianPlan(){
  const { error } = await supabaseClient.from('plans').upsert(
    { client_id: activeClientId, plan_data: plan },
    { onConflict: 'client_id' }
  );
  if(error){ showToast("Couldn't save — " + error.message); return false; }
  return true;
}
function ensureClinicianDay(dayKey){
  if(!plan[dayKey]) plan[dayKey] = { type:'rest', label: dayKey, desc:'', exercises:[] };
  return plan[dayKey];
}

function renderProgramEditor(main){
  DAY_ORDER.forEach(ensureClinicianDay);
  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <div class="section-label" style="margin:0;">Edit program</div>
    <button id="doneEditingBtn" class="btn" style="width:auto;padding:8px 16px;">Done</button>
  </div>`;
  DAY_ORDER.forEach(k=>{
    const d = plan[k];
    html += `<div class="card">
      <div class="section-label">${k.toUpperCase()}</div>
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        <div class="field" style="flex:1;"><label>Type</label>
          <select class="dayTypeSelect" data-day="${k}" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px;font-size:13px;">
            <option value="rest" ${d.type==='rest'?'selected':''}>Rest</option>
            <option value="cardio" ${d.type==='cardio'?'selected':''}>Cardio</option>
            <option value="lift" ${d.type==='lift'?'selected':''}>Lift</option>
          </select>
        </div>
        <div class="field" style="flex:1;"><label>Label</label><input type="text" class="dayLabelInput" data-day="${k}" value="${escapeAttr(d.label)}"></div>
      </div>`;
    if(d.type !== 'lift'){
      html += `<div class="field"><label>Description</label><input type="text" class="dayDescInput" data-day="${k}" value="${escapeAttr(d.desc||'')}" placeholder="e.g. easy 5k, rest, mobility"></div>`;
    } else {
      html += `<div class="eyebrow" style="margin:10px 0 6px;">EXERCISES</div>`;
      (d.exercises||[]).forEach((ex,i)=>{
        html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <input class="exNameEdit" data-day="${k}" data-exidx="${i}" value="${escapeAttr(ex.name)}" placeholder="Exercise name" style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 8px;font-size:13px;">
          <input class="exTargetEdit" data-day="${k}" data-exidx="${i}" value="${escapeAttr(ex.target||'')}" placeholder="3x8-10" style="width:66px;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 6px;font-size:12px;font-family:var(--font-mono);">
          <button class="heroToggleEdit" data-day="${k}" data-exidx="${i}" style="background:none;border:1px solid ${ex.hero?'var(--rust)':'var(--border)'};color:${ex.hero?'var(--rust)':'var(--text-faint)'};border-radius:6px;padding:6px 7px;font-size:10px;font-family:var(--font-mono);flex-shrink:0;">HERO</button>
          <button class="removeExEdit" data-day="${k}" data-exidx="${i}" style="background:none;border:none;color:var(--text-faint);font-size:15px;flex-shrink:0;">&times;</button>
        </div>`;
      });
      html += `<div style="display:flex;gap:14px;margin-top:4px;">
        <button class="addExEdit" data-day="${k}" style="background:none;border:none;color:#6E93AC;font-family:var(--font-mono);font-size:11px;">+ Add custom</button>
        <button class="browseLibEdit" data-day="${k}" style="background:none;border:none;color:var(--brass);font-family:var(--font-mono);font-size:11px;">+ Browse library</button>
      </div>`;
    }
    html += `</div>`;
  });
  main.innerHTML = html;
  wireProgramEditor(main);
}

function wireProgramEditor(main){
  document.getElementById('doneEditingBtn').onclick = async ()=>{
    const ok = await saveClinicianPlan();
    if(ok){ showToast('Program saved'); renderProgram(main); }
  };
  main.querySelectorAll('.dayTypeSelect').forEach(sel=>{
    sel.onchange = e=>{
      const d = ensureClinicianDay(sel.dataset.day);
      d.type = e.target.value;
      if(e.target.value==='lift' && !d.exercises) d.exercises = [];
      renderProgramEditor(main);
    };
  });
  main.querySelectorAll('.dayLabelInput').forEach(inp=>{ inp.oninput = e=>{ ensureClinicianDay(inp.dataset.day).label = e.target.value; }; });
  main.querySelectorAll('.dayDescInput').forEach(inp=>{ inp.oninput = e=>{ ensureClinicianDay(inp.dataset.day).desc = e.target.value; }; });
  main.querySelectorAll('.exNameEdit').forEach(inp=>{ inp.oninput = e=>{ plan[inp.dataset.day].exercises[inp.dataset.exidx].name = e.target.value; }; });
  main.querySelectorAll('.exTargetEdit').forEach(inp=>{ inp.oninput = e=>{ plan[inp.dataset.day].exercises[inp.dataset.exidx].target = e.target.value; }; });
  main.querySelectorAll('.heroToggleEdit').forEach(btn=>{
    btn.onclick = ()=>{
      const day = btn.dataset.day, idx = btn.dataset.exidx;
      plan[day].exercises[idx].hero = !plan[day].exercises[idx].hero;
      renderProgramEditor(main);
    };
  });
  main.querySelectorAll('.removeExEdit').forEach(btn=>{
    btn.onclick = ()=>{
      const day = btn.dataset.day, idx = parseInt(btn.dataset.exidx);
      plan[day].exercises.splice(idx,1);
      renderProgramEditor(main);
    };
  });
  main.querySelectorAll('.addExEdit').forEach(btn=>{
    btn.onclick = ()=>{
      const d = ensureClinicianDay(btn.dataset.day);
      if(!d.exercises) d.exercises = [];
      d.exercises.push({ name:'', target:'', hero:false });
      renderProgramEditor(main);
    };
  });
  main.querySelectorAll('.browseLibEdit').forEach(btn=>{
    btn.onclick = ()=>{
      const day = btn.dataset.day;
      const d = ensureClinicianDay(day);
      if(!d.exercises) d.exercises = [];
      renderClinicianLibraryPicker(main, day);
    };
  });
}

function renderClinicianLibraryPicker(main, dayKey){
  const cats = Object.keys(EXERCISE_LIBRARY);
  main.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <div class="section-label" style="margin:0;">Exercise library</div>
    <button id="closeClinLibBtn" style="background:none;border:none;color:var(--text-faint);font-family:var(--font-mono);font-size:11px;">Close</button>
  </div>
  <input type="text" id="clinLibSearchInput" placeholder="Search exercises…" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:10px;font-size:14px;margin-bottom:14px;">
  <div id="clinLibResults"></div>`;
  function renderResults(filter){
    const q = (filter||'').trim().toLowerCase();
    const resultsEl = document.getElementById('clinLibResults');
    let rhtml = '';
    cats.forEach(cat=>{
      const items = EXERCISE_LIBRARY[cat].filter(name=>!q || name.toLowerCase().includes(q));
      if(items.length === 0) return;
      rhtml += `<div class="eyebrow" style="margin-top:10px;margin-bottom:6px;">${escapeHtml(cat)}</div><div style="display:flex;flex-wrap:wrap;gap:6px;">`;
      items.forEach(name=>{
        rhtml += `<button class="clinLibExerciseBtn" data-name="${escapeAttr(name)}" style="background:var(--surface-2);border:1px solid var(--border);color:var(--text-dim);font-size:12px;padding:6px 12px;border-radius:20px;">${escapeHtml(name)}</button>`;
      });
      rhtml += `</div>`;
    });
    resultsEl.innerHTML = rhtml || `<div class="emptystate">No matches — close this and add it as a custom exercise instead.</div>`;
    resultsEl.querySelectorAll('.clinLibExerciseBtn').forEach(b=>{
      b.onclick = ()=>{
        plan[dayKey].exercises.push({ name: b.dataset.name, target:'', hero:false });
        renderProgramEditor(main);
      };
    });
  }
  renderResults('');
  document.getElementById('closeClinLibBtn').onclick = ()=>renderProgramEditor(main);
  document.getElementById('clinLibSearchInput').oninput = e=>renderResults(e.target.value);
}

// ---------- IMPORT PROGRAM FROM NOTES ----------
let programImportPreview = [];
function guessDayKeyFromTitle(title){
  const low = title.toLowerCase();
  return DAY_ORDER.find(d=>low.includes(d.toLowerCase())) || null;
}
function parseProgramExerciseLine(line){
  const clean = line.replace(/^[-•*]\s*/, '').trim();
  if(!clean) return null;
  const targetRe = /(\d+\s*[x×]\s*[\d\-–]+(?:\s*reps?)?)/i;
  const tm = targetRe.exec(clean);
  let name, target = '';
  if(tm){
    target = tm[0].replace(/\s+/g,'').replace('×','x');
    name = (clean.slice(0,tm.index) + clean.slice(tm.index+tm[0].length)).replace(/^[-:,\s]+|[-:,\s]+$/g,'').trim();
  } else {
    name = clean;
  }
  if(!name) return null;
  return { name, target, hero:false };
}
function parseProgramText(text){
  const blocks = text.split(/\n\s*\n/);
  const results = [];
  blocks.forEach(block=>{
    const lines = block.split('\n').map(l=>l.trim()).filter(Boolean);
    if(lines.length === 0) return;
    const title = lines[0];
    const exercises = lines.slice(1).map(parseProgramExerciseLine).filter(Boolean);
    if(exercises.length === 0) return;
    results.push({ id: uid(), title, dayKey: guessDayKeyFromTitle(title), exercises, skip:false });
  });
  return results;
}
function renderProgramImportForm(main){
  main.innerHTML = `
    <div class="section-label">Import program from notes</div>
    <div style="font-size:12px;color:var(--text-dim);line-height:1.5;margin-bottom:12px;">
      Paste a program from somewhere else. Start each day with a title on its own line (a day name helps but isn't required, e.g. "Monday — Upper" or just "Upper"), then list exercises underneath, one per line. Separate days with a blank line.
    </div>
    <textarea id="programImportTextarea" rows="12" placeholder="Monday — Upper
Bench press 3x8-10
Lat pulldown 3x10-12

Wednesday — Lower
Squat 4x6-8
Leg curl 3x10-12" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:10px;font-family:var(--font-mono);font-size:13px;margin-bottom:12px;box-sizing:border-box;"></textarea>
    <div style="display:flex;gap:10px;">
      <button id="cancelProgramImportBtn" class="btn secondary" style="flex:1;">Cancel</button>
      <button id="parseProgramImportBtn" class="btn" style="flex:1;">Parse notes</button>
    </div>
  `;
  document.getElementById('cancelProgramImportBtn').onclick = ()=>renderProgram(main);
  document.getElementById('parseProgramImportBtn').onclick = ()=>{
    const text = document.getElementById('programImportTextarea').value;
    programImportPreview = parseProgramText(text);
    renderProgramImportPreview(main);
  };
}
function renderProgramImportPreview(main){
  DAY_ORDER.forEach(ensureClinicianDay);
  if(programImportPreview.length === 0){
    main.innerHTML = `<div class="emptystate">Couldn't find any days with exercises in that text. Make sure each day has a title line followed by exercise lines, with a blank line between days.</div>
      <button id="backToProgramImportBtn" class="btn" style="margin-top:12px;">Try again</button>`;
    document.getElementById('backToProgramImportBtn').onclick = ()=>renderProgramImportForm(main);
    return;
  }
  let html = `<div class="section-label">Found ${programImportPreview.length} day${programImportPreview.length>1?'s':''}</div>
    <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">Assign each to a day of the week. Importing will replace that day's current exercise list — set to "Don't import" to skip one.</div>`;
  programImportPreview.forEach((blk,i)=>{
    html += `<div class="card">
      <div style="font-family:var(--font-display);font-weight:600;font-size:14px;margin-bottom:6px;">${escapeHtml(blk.title)}</div>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">${blk.exercises.map(e=>escapeHtml(e.name)+(e.target?` (${escapeHtml(e.target)})`:'')).join(', ')}</div>
      <div class="field" style="max-width:260px;"><label>Import into</label>
        <select class="programImportDaySelect" data-idx="${i}" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px;font-size:13px;">
          <option value="" ${!blk.dayKey?'selected':''}>Don't import</option>
          ${DAY_ORDER.map(d=>`<option value="${d}" ${blk.dayKey===d?'selected':''}>${d} — currently: ${escapeAttr(plan[d].label)}</option>`).join('')}
        </select>
      </div>
    </div>`;
  });
  const assignedDays = programImportPreview.filter(b=>b.dayKey).map(b=>b.dayKey);
  const dupes = assignedDays.filter((d,i)=>assignedDays.indexOf(d)!==i);
  if(dupes.length){
    html += `<div style="background:var(--rust-dim);border:1px solid var(--rust-dim);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:var(--rust);">
      More than one day is assigned to the same slot (${[...new Set(dupes)].join(', ')}) — only the last one will be kept.
    </div>`;
  }
  const includeCount = new Set(assignedDays).size;
  html += `<div style="display:flex;gap:10px;margin-top:4px;">
    <button id="cancelProgramImportBtn2" class="btn secondary" style="flex:1;">Cancel</button>
    <button id="commitProgramImportBtn" class="btn" style="flex:1;">Import ${includeCount} day${includeCount!==1?'s':''}</button>
  </div>`;
  main.innerHTML = html;
  main.querySelectorAll('.programImportDaySelect').forEach(sel=>{
    sel.onchange = e=>{ programImportPreview[+sel.dataset.idx].dayKey = e.target.value || null; };
  });
  document.getElementById('cancelProgramImportBtn2').onclick = ()=>renderProgram(main);
  document.getElementById('commitProgramImportBtn').onclick = async ()=>{
    programImportPreview.forEach(blk=>{
      if(!blk.dayKey) return;
      plan[blk.dayKey] = { type:'lift', label: blk.title, exercises: blk.exercises };
    });
    const ok = await saveClinicianPlan();
    if(ok){ showToast('Program imported'); renderProgram(main); }
  };
}

// ============================================================
init();
