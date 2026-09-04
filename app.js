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
          <input id="authEmail" type="email" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false">
        </div>
        <div class="field">
          <label>Password</label>
          <div style="position:relative;">
            <input id="authPassword" type="password" autocomplete="${authMode==='login'?'current-password':'new-password'}" autocapitalize="off" autocorrect="off" spellcheck="false" style="padding-right:56px;">
            <button type="button" id="togglePasswordBtn" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-faint);font-family:var(--font-mono);font-size:11px;padding:6px;">SHOW</button>
          </div>
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
  document.getElementById('togglePasswordBtn').onclick = ()=>{
    const pw = document.getElementById('authPassword');
    const btn = document.getElementById('togglePasswordBtn');
    if(pw.type === 'password'){ pw.type = 'text'; btn.textContent = 'HIDE'; }
    else { pw.type = 'password'; btn.textContent = 'SHOW'; }
  };
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
  await Promise.all([loadPlan(), loadSessions(), loadGoals(), loadLifestyleLogs(), loadSettings(), loadCycleEntries(), loadMeasurements()]);
  renderClientNav();
  renderClientView();
}

function renderClientNav(){
  let tabs = [
    {id:'log', label:'Log', ic:'&#9998;'},
    {id:'checkin', label:'Check-in', ic:'&#127775;'},
    {id:'schedule', label:'Schedule', ic:'&#128197;'},
    {id:'history', label:'History', ic:'&#128337;'},
    {id:'progress', label:'Progress', ic:'&#128200;'},
    {id:'biglifts', label:'Big lifts', ic:'&#127942;'},
    {id:'measure', label:'Measure', ic:'&#128207;'},
    {id:'library', label:'Library', ic:'&#128218;'},
    {id:'program', label:'Program', ic:'&#128203;'},
    {id:'goals', label:'Goals', ic:'&#127942;'},
    {id:'lifestyle', label:'Lifestyle', ic:'&#128202;'},
    {id:'cycle', label:'Cycle', ic:'&#128167;'},
    {id:'correlate', label:'Correlate', ic:'&#128260;'},
  ];
  if(!settings.trackCycle){
    tabs = tabs.filter(t=>t.id!=='cycle' && t.id!=='correlate');
    if(view==='cycle' || view==='correlate') view = 'log';
  }
  document.getElementById('navbar').innerHTML = `<div style="display:flex;overflow-x:auto;width:100%;">` + tabs.map(t=>
    `<button class="navbtn ${view===t.id?'active':''}" data-view="${t.id}" style="flex:0 0 auto;min-width:60px;"><span class="ic">${t.ic}</span>${t.label}</button>`
  ).join('') + `</div>`;
  document.querySelectorAll('.navbtn').forEach(b=>{
    b.onclick = ()=>{
      view = b.dataset.view;
      document.querySelectorAll('.navbtn').forEach(btn=>btn.classList.toggle('active', btn.dataset.view===view));
      renderClientView();
    };
  });
}

function renderClientView(){
  const main = document.getElementById('mainContent');
  if(view === 'log') renderLog(main);
  else if(view === 'checkin') renderCheckin(main);
  else if(view === 'schedule') renderSchedule(main);
  else if(view === 'history') renderHistory(main);
  else if(view === 'progress') renderProgress(main);
  else if(view === 'biglifts') renderBigLifts(main);
  else if(view === 'measure') renderMeasure(main);
  else if(view === 'library') renderLibraryTab(main);
  else if(view === 'program') renderProgram(main);
  else if(view === 'goals') renderGoals(main);
  else if(view === 'lifestyle') renderLifestyle(main);
  else if(view === 'cycle') renderCycle(main);
  else if(view === 'correlate') renderCorrelate(main);
  const saveBar = document.getElementById('saveBar');
  if(saveBar) saveBar.style.display = view === 'log' ? 'block' : 'none';
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
// Parses the leading set count from a target string, e.g. "4x4-6" -> 4,
// "3-4x4-6" (a range of sets) -> 3 (lower bound). Falls back to 0 (no
// pre-filled rows) for anything unparseable.
function parseSetCountFromTarget(target){
  if(!target) return 0;
  const m = /^(\d+)(?:\s*[-–]\s*\d+)?\s*[x×]/i.exec(target.trim());
  return m ? parseInt(m[1],10) : 0;
}
function presetSets(count){
  return Array.from({ length: count }, ()=>({ weight:'', reps:'' }));
}
function emptyExercisesForToday(){
  const day = plan[logState.dayKey];
  if(!day || day.type !== 'lift') return [];
  return (day.exercises||[]).map(e => ({ id: uid(), name: e.name, target: e.target, videoUrl: e.videoUrl||'', sets: presetSets(parseSetCountFromTarget(e.target)) }));
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
function targetForExerciseName(name){
  const key = canonicalKey(name);
  for(const d of Object.values(plan)){
    const match = (d.exercises||[]).find(e=>canonicalKey(e.name)===key);
    if(match && match.target) return match.target;
  }
  return '';
}

function renderLog(main){
  if(!logState._initedForPlan){
    logState.exercises = emptyExercisesForToday();
    logState._initedForPlan = true;
  }
  const day = plan[logState.dayKey];
  const liftDayKeys = Object.keys(plan).filter(k=>plan[k].type==='lift');
  const { week: weekNum } = getWeekAndPhase(logState.date);
  const weekLabel = settings.startDate ? `Week ${Math.min(weekNum,12)}/12` : '';
  main.innerHTML = `
    <div style="padding:16px 18px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      ${weekLabel ? `<span class="eyebrow" style="color:var(--brass);">${weekLabel}</span>` : `<span></span>`}
    </div>
    <div id="restTimerBar" style="margin-bottom:14px;"></div>
    <div style="display:flex;gap:10px;margin-bottom:14px;">
      <div class="field" style="flex:1;margin-bottom:0;"><label>Date</label><input type="date" id="logDateInput" value="${logState.date}"></div>
      <div class="field" style="flex:1;margin-bottom:0;"><label>Logging as</label>
        <button type="button" id="logDayPickerBtn" style="width:100%;text-align:left;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:11px;font-size:15px;font-family:var(--font-body);display:flex;justify-content:space-between;align-items:center;">
          <span>${liftDayKeys.length===0 ? escapeHtml(logState.dayKey)+' (no program set)' : escapeHtml(plan[logState.dayKey] ? (plan[logState.dayKey].label||logState.dayKey) : logState.dayKey)}</span>
          <span style="color:var(--text-faint);font-size:11px;">&#9662;</span>
        </button>
      </div>
    </div>
    ${!day ? `<div class="emptystate">No program set for this day yet — check with your clinician, or log a custom session below.</div>` : ''}
    <div class="field"><label>Warm-up</label><input type="text" id="logWarmupInput" placeholder="Optional" value="${escapeAttr(logState.warmup||'')}"></div>
    <div class="section-label" style="margin-top:10px;">Exercises</div>
    <div id="logSaveErr" class="err" style="display:none;"></div>
    <div id="logExerciseList"></div>
    <button class="btn secondary" id="addCustomExBtn" style="margin-top:6px;">+ Add exercise</button>
    <div class="field" style="margin-top:16px;">
      <label>Session note</label>
      <input id="logNoteInput" type="text" value="${escapeAttr(logState.note)}">
    </div>
    </div>
  `;
  document.getElementById('logDateInput').onchange = e=>{
    logState.date = e.target.value;
    renderLog(main);
  };
  document.getElementById('logDayPickerBtn').onclick = ()=>openLogDayPicker(main, liftDayKeys);
  document.getElementById('logWarmupInput').oninput = e=>{ logState.warmup = e.target.value; };
  document.getElementById('logNoteInput').oninput = e=>{ logState.note = e.target.value; };
  renderLogExerciseList();
  document.getElementById('addCustomExBtn').onclick = openAddExerciseFlow;
  ensureLogSaveBar();
  renderRestTimerBar();
}

// ---------- LAST TIME REFERENCE (projected weights) ----------
function getLastLoggedExercise(name){
  const sorted = [...sessions].sort((a,b)=>b.date.localeCompare(a.date));
  const key = canonicalKey(name);
  for(const s of sorted){
    const ex = (s.exercises||[]).find(e=>canonicalKey(e.name)===key);
    if(ex && ex.sets && ex.sets.length) return { date: s.date, sets: ex.sets };
  }
  return null;
}
function lastTimeReference(name){
  const last = getLastLoggedExercise(name);
  if(!last) return null;
  const text = last.sets.map(s=>`${s.weight||'–'}kg × ${s.reps||'–'}`).join(', ');
  return { date: last.date, text };
}

// ---------- REST TIMER (device-local, not synced) ----------
const REST_TIMER_KEY = 'cfm-resttimer';
let restTimerInterval = null;
function saveRestTimerState(state){
  try{ if(state) localStorage.setItem(REST_TIMER_KEY, JSON.stringify(state)); else localStorage.removeItem(REST_TIMER_KEY); }catch(e){}
}
function loadRestTimerState(){
  try{ const raw = localStorage.getItem(REST_TIMER_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
}
function playRestTimerBeep(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start(); osc.stop(ctx.currentTime + 0.5);
    osc.onended = ()=>ctx.close();
  }catch(e){}
  if(navigator.vibrate) navigator.vibrate([200,100,200]);
}
function restTimerTick(){
  const state = loadRestTimerState();
  if(!state) return;
  const remaining = Math.round((state.endTime - Date.now())/1000);
  const display = document.getElementById('restTimeDisplay');
  if(remaining > 0){
    if(display){ const mm = Math.floor(remaining/60), ss = remaining%60; display.textContent = `${mm}:${String(ss).padStart(2,'0')}`; }
  } else {
    if(display) display.textContent = "Rest's up!";
    if(!state.beeped){ state.beeped = true; saveRestTimerState(state); playRestTimerBeep(); setTimeout(()=>stopRestTimer(), 4000); }
  }
}
function startRestTimer(seconds){ saveRestTimerState({ endTime: Date.now() + seconds*1000, beeped:false }); renderRestTimerBar(); }
function adjustRestTimer(deltaSeconds){
  const state = loadRestTimerState();
  if(!state) return;
  state.endTime += deltaSeconds*1000; state.beeped = false;
  saveRestTimerState(state); restTimerTick();
}
function stopRestTimer(){ saveRestTimerState(null); renderRestTimerBar(); }
function renderRestTimerBar(){
  const bar = document.getElementById('restTimerBar');
  if(!bar){ if(restTimerInterval){ clearInterval(restTimerInterval); restTimerInterval = null; } return; }
  const state = loadRestTimerState();
  if(state){
    bar.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--brass);border-radius:10px;padding:10px 14px;">
      <button id="restMinusBtn" style="background:rgba(10,31,26,0.15);border:none;color:#0A1F1A;border-radius:8px;padding:9px 13px;font-family:var(--font-mono);font-weight:600;font-size:13px;">-15</button>
      <div style="flex:1;text-align:center;">
        <div id="restTimeDisplay" style="font-family:var(--font-display);font-weight:700;font-size:26px;color:#0A1F1A;"></div>
        <div style="font-size:10px;color:#0A1F1A;opacity:0.7;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.06em;">Rest</div>
      </div>
      <button id="restPlusBtn" style="background:rgba(10,31,26,0.15);border:none;color:#0A1F1A;border-radius:8px;padding:9px 13px;font-family:var(--font-mono);font-weight:600;font-size:13px;">+15</button>
      <button id="restStopBtn" style="background:none;border:none;color:#0A1F1A;font-size:20px;padding:4px 8px;font-weight:700;">&times;</button>
    </div>`;
    document.getElementById('restMinusBtn').onclick = ()=>adjustRestTimer(-15);
    document.getElementById('restPlusBtn').onclick = ()=>adjustRestTimer(15);
    document.getElementById('restStopBtn').onclick = ()=>stopRestTimer();
    restTimerTick();
    if(!restTimerInterval) restTimerInterval = setInterval(restTimerTick, 500);
  } else {
    if(restTimerInterval){ clearInterval(restTimerInterval); restTimerInterval = null; }
    bar.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;background:var(--brass);border-radius:10px;padding:10px 14px;">
      <span style="font-size:11px;color:#0A1F1A;opacity:0.75;font-family:var(--font-mono);font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-right:2px;">&#9201; Rest</span>
      ${[60,90,120,180].map(s=>`<button class="restPresetBtn" data-s="${s}" style="background:rgba(10,31,26,0.15);border:none;color:#0A1F1A;border-radius:8px;padding:8px 14px;font-family:var(--font-mono);font-weight:600;font-size:13px;">${s}s</button>`).join('')}
    </div>`;
    bar.querySelectorAll('.restPresetBtn').forEach(b=>{ b.onclick = ()=>startRestTimer(parseInt(b.dataset.s,10)); });
  }
}

function openLogDayPicker(main, liftDayKeys){
  let ov = document.getElementById('logDayPickerOverlay');
  if(ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'logDayPickerOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;z-index:200;';
  const options = liftDayKeys.length ? liftDayKeys : [logState.dayKey];
  ov.innerHTML = `
    <div style="background:var(--surface);border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:480px;max-height:70vh;overflow-y:auto;">
      <div style="font-family:var(--font-display);font-weight:600;font-size:16px;margin-bottom:14px;">Logging as</div>
      ${options.map(k=>{
        const label = (plan[k] && plan[k].label) ? plan[k].label : k;
        const active = k === logState.dayKey;
        return `<button class="logDayOption" data-key="${escapeAttr(k)}" style="width:100%;text-align:left;background:${active?'var(--brass)':'var(--surface-2)'};border:1px solid ${active?'var(--brass)':'var(--border)'};color:${active?'#0A1F1A':'var(--text)'};border-radius:8px;padding:12px 14px;margin-bottom:8px;font-family:var(--font-display);font-weight:600;font-size:14px;">${escapeHtml(label)}${liftDayKeys.length===0?' (no program set)':''}</button>`;
      }).join('')}
      <button id="logDayPickerCancelBtn" style="width:100%;padding:11px;border-radius:9px;border:1px solid var(--border);background:none;color:var(--text-faint);font-family:var(--font-display);font-weight:600;font-size:13px;margin-top:6px;">Cancel</button>
    </div>
  `;
  document.body.appendChild(ov);
  ov.querySelectorAll('.logDayOption').forEach(b=>{
    b.onclick = ()=>{
      logState.dayKey = b.dataset.key;
      logState._initedForPlan = false;
      ov.remove();
      renderLog(main);
    };
  });
  document.getElementById('logDayPickerCancelBtn').onclick = ()=>ov.remove();
}

function renderLogExerciseList(){
  const el = document.getElementById('logExerciseList');
  if(!el) return;
  if(logState.exercises.length === 0){
    el.innerHTML = `<div class="emptystate">No exercises yet. Tap "Add exercise" to start logging.</div>`;
    return;
  }
  el.innerHTML = logState.exercises.map((ex, exIdx)=>{
    const lastTime = ex.name && ex.name.trim() ? lastTimeReference(ex.name) : null;
    return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
        <div>
          <div style="font-family:var(--font-display);font-weight:600;font-size:15px;">${escapeHtml(ex.name)}</div>
          ${ex.target ? `<div class="eyebrow">${escapeHtml(ex.target)}</div>` : ''}
          ${ex.videoUrl ? `<a class="videoLink" href="${escapeAttr(ex.videoUrl)}" target="_blank" rel="noopener">&#9654; Watch demo</a>` : ''}
        </div>
        <button class="removeExBtn" data-idx="${exIdx}" style="background:none;border:none;color:var(--text-faint);font-size:16px;">&times;</button>
      </div>
      ${lastTime ? `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12px;color:var(--brass);line-height:1.4;">
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.04em;">Last time · ${formatAU(lastTime.date)}</span><br>
        ${escapeHtml(lastTime.text)}
      </div>` : ''}
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
  `;}).join('');

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
        const target = targetForExerciseName(name);
        logState.exercises.push({ id: uid(), name, target, videoUrl: videoUrlForExerciseName(name), sets: presetSets(parseSetCountFromTarget(target)) });
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
  const errEl = document.getElementById('logSaveErr');
  if(exercisesToSave.length === 0){
    if(errEl){
      errEl.textContent = "Nothing saved — enter at least a weight or reps for one exercise, then tap Save session again.";
      errEl.style.display = 'block';
      errEl.scrollIntoView({ behavior:'smooth', block:'center' });
    }
    showToast('Log at least one set before saving');
    return;
  }
  if(errEl) errEl.style.display = 'none';
  // CONFIRMED: sessions(client_id, date, day_key, day_label, exercises jsonb, note)
  const dayInfo = plan[logState.dayKey];
  const { error } = await supabaseClient.from('sessions').upsert({
    client_id: activeClientId,
    date: logState.date,
    day_key: logState.dayKey,
    day_label: (dayInfo && dayInfo.label) || logState.dayKey,
    exercises: exercisesToSave,
    warmup: logState.warmup || null,
    note: logState.note,
  }, { onConflict: 'client_id,date' });
  if(error){
    if(errEl){ errEl.textContent = "Couldn't save — " + error.message; errEl.style.display = 'block'; }
    showToast("Couldn't save — " + error.message);
    return;
  }
  showToast('Session saved');
  await loadSessions();
  if(view === 'history') renderClientView();
}

// ---------- HISTORY VIEW ----------
// ---------- HISTORY VIEW (grouped: year > month > ISO week) ----------
let expandedHistory = {};
let expandedGroups = {};
function isoWeekInfo(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(),0,4);
  const diff = target - firstThursday;
  const week = 1 + Math.round(diff / (7*24*3600*1000));
  return { isoYear: target.getFullYear(), week };
}
function groupHeaderHtml(key, label, count, level){
  const open = !!expandedGroups[key];
  const pad = level * 10;
  const size = level===0 ? '15px' : level===1 ? '14px' : '13px';
  return `<button class="grouphead" data-key="${key}" style="width:100%;display:flex;justify-content:space-between;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:10px 14px;margin-left:${pad}px;margin-bottom:6px;">
    <span style="font-family:var(--font-display);font-weight:600;font-size:${size};">${escapeHtml(label)}</span>
    <span style="display:flex;align-items:center;gap:8px;">
      <span class="eyebrow">${count} session${count!==1?'s':''}</span>
      <span style="color:var(--text-faint);">${open?'&#9650;':'&#9660;'}</span>
    </span>
  </button>`;
}
function renderSessionCardHtml(s){
  const open = !!expandedHistory[s.id];
  let body = '';
  if(open){
    if(s.warmup) body += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">Warm-up: ${escapeHtml(s.warmup)}</div>`;
    (s.exercises||[]).forEach(ex=>{
      body += `<div style="font-family:var(--font-display);font-weight:600;font-size:14px;margin-top:6px;">${escapeHtml(ex.name)}</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">`;
      (ex.sets||[]).forEach(st=>{ body += `<span class="chip">${escapeHtml(st.weight)||'–'}kg × ${escapeHtml(st.reps)||'–'}</span>`; });
      body += `</div>`;
    });
    if(s.note) body += `<div style="font-size:12px;color:var(--text-dim);margin-top:10px;">Notes: ${escapeHtml(s.note)}</div>`;
    body += `<div style="display:flex;gap:14px;margin-top:12px;"><button class="editSessionBtn" data-id="${s.id}" style="background:none;border:none;color:var(--brass);font-family:var(--font-mono);font-size:11px;">EDIT</button><button class="deleteSessionBtn" data-id="${s.id}" style="background:none;border:none;color:var(--rust);font-family:var(--font-mono);font-size:11px;">DELETE</button></div>`;
  }
  return `<div class="card" style="margin-left:14px;">
    <button class="histhead" data-id="${s.id}" style="width:100%;display:flex;justify-content:space-between;align-items:center;background:none;border:none;padding:0;color:inherit;text-align:left;">
      <div><div class="histdate">${formatAU(s.date)}</div><div class="histlabel">${escapeHtml(s.day_label||s.day_key||'')}</div></div>
      <span style="color:var(--text-faint);">${open?'&#9650;':'&#9660;'}</span>
    </button>
    ${open ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">${body}</div>` : ''}
  </div>`;
}
function renderHistory(main){
  const sorted = [...sessions].sort((a,b)=>b.date.localeCompare(a.date));
  if(sorted.length === 0){
    main.innerHTML = `<div style="padding:16px 18px;"><div class="emptystate">No sessions logged yet. Head to Log to add your first one.</div></div>`;
    return;
  }
  const years = {};
  sorted.forEach(s=>{
    const y = s.date.slice(0,4);
    const monthIdx = parseInt(s.date.slice(5,7),10) - 1;
    const { week } = isoWeekInfo(s.date);
    years[y] = years[y] || {};
    years[y][monthIdx] = years[y][monthIdx] || {};
    years[y][monthIdx][week] = years[y][monthIdx][week] || [];
    years[y][monthIdx][week].push(s);
  });
  let html = `<div style="padding:16px 18px;">`;
  Object.keys(years).sort((a,b)=>b.localeCompare(a)).forEach(y=>{
    const yearKey = `y-${y}`;
    const yearCount = Object.values(years[y]).reduce((a,m)=>a+Object.values(m).reduce((a2,w)=>a2+w.length,0),0);
    html += groupHeaderHtml(yearKey, y, yearCount, 0);
    if(expandedGroups[yearKey]){
      Object.keys(years[y]).sort((a,b)=>b-a).forEach(m=>{
        const monthKey = `${yearKey}-m-${m}`;
        const monthCount = Object.values(years[y][m]).reduce((a,w)=>a+w.length,0);
        html += groupHeaderHtml(monthKey, MONTH_NAMES[m], monthCount, 1);
        if(expandedGroups[monthKey]){
          Object.keys(years[y][m]).sort((a,b)=>b-a).forEach(w=>{
            const weekKey = `${monthKey}-w-${w}`;
            const weekSessions = years[y][m][w];
            html += groupHeaderHtml(weekKey, `Week ${w}`, weekSessions.length, 2);
            if(expandedGroups[weekKey]){
              weekSessions.forEach(s=>{ html += renderSessionCardHtml(s); });
            }
          });
        }
      });
    }
  });
  html += `</div>`;
  main.innerHTML = html;
  main.querySelectorAll('.grouphead').forEach(b=>{
    b.onclick = ()=>{ expandedGroups[b.dataset.key] = !expandedGroups[b.dataset.key]; renderHistory(main); };
  });
  main.querySelectorAll('.histhead').forEach(b=>{
    b.onclick = ()=>{ expandedHistory[b.dataset.id] = !expandedHistory[b.dataset.id]; renderHistory(main); };
  });
  main.querySelectorAll('.deleteSessionBtn').forEach(b=>{
    b.onclick = async ()=>{
      const { error } = await supabaseClient.from('sessions').delete().eq('id', b.dataset.id);
      if(error){ showToast("Couldn't delete — " + error.message); return; }
      await loadSessions();
      renderHistory(main);
    };
  });
  main.querySelectorAll('.editSessionBtn').forEach(b=>{
    b.onclick = ()=>{
      const s = sessions.find(x=>x.id===b.dataset.id);
      if(!s) return;
      goToLogForDate(s.date, s.day_key || todayDayName());
      showToast('Editing session — save to update');
    };
  });
}

// ---------- PROGRAM VIEW ----------
function renderProgram(main){
  const days = Object.keys(plan);
  const clinicianToolbar = `<div style="display:flex;gap:10px;margin-bottom:14px;">
    <button id="editFullProgramBtn" class="btn secondary" style="flex:1;">Edit full program</button>
    <button id="importNotesBtn" class="btn secondary" style="flex:1;">Import from notes</button>
  </div>`;
  const configuredDays = days.filter(dayKey=>plan[dayKey].type);
  if(configuredDays.length === 0){
    main.innerHTML = `<div style="padding:16px 18px;">${clinicianToolbar}<div class="emptystate">No program set yet — tap "Edit full program" to build your own, or check with your clinician.</div></div>`;
    document.getElementById('editFullProgramBtn').onclick = ()=>renderProgramEditor(main);
    document.getElementById('importNotesBtn').onclick = ()=>renderProgramImportForm(main);
    return;
  }
  main.innerHTML = `<div style="padding:16px 18px;">` + clinicianToolbar + days.filter(dayKey=>plan[dayKey].type).map(dayKey=>{
    const day = plan[dayKey];
    if(day.type !== 'lift') return `<div class="card"><div class="section-label">${escapeHtml(dayKey)}</div><div style="font-size:13px;color:var(--text-dim);">${escapeHtml(day.desc||day.label||(day.type==='rest'?'Rest':'Cardio'))}</div></div>`;
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

  document.getElementById('editFullProgramBtn').onclick = ()=>renderProgramEditor(main);
  document.getElementById('importNotesBtn').onclick = ()=>renderProgramImportForm(main);
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

// ---------- CHECK-IN VIEW (sleep/energy/calm/mood) ----------
const CHECKIN_FIELDS = [
  {key:'sleep_rating', label:'Sleep', lo:'Poor', hi:'Great'},
  {key:'energy_rating', label:'Energy', lo:'Drained', hi:'Energised'},
  {key:'calm_rating', label:'Calm', lo:'Stressed', hi:'Calm'},
  {key:'mood_rating', label:'Mood', lo:'Low', hi:'Great'},
];
function checkinScore(entry){
  const vals = CHECKIN_FIELDS.map(f=>entry[f.key]).filter(v=>v>0);
  if(vals.length < 4) return null;
  return Math.round((vals.reduce((a,b)=>a+b,0)/vals.length) * 20);
}
function renderCheckin(main){
  const today = todayISO();
  const entry = lifestyleLogs.find(l=>l.date===today) || {};
  const score = checkinScore(entry);
  const rows = CHECKIN_FIELDS.map(f=>{
    const chips = [1,2,3,4,5].map(r=>{
      const on = entry[f.key]===r;
      return `<button class="checkinChip" data-field="${f.key}" data-val="${r}" style="flex:1;padding:9px 0;border-radius:6px;border:1px solid ${on?'var(--brass)':'var(--border)'};background:${on?'var(--brass)':'var(--surface-2)'};color:${on?'#0A1F1A':'var(--text-dim)'};font-family:var(--font-mono);font-size:13px;">${r}</button>`;
    }).join('');
    return `<div style="margin-bottom:16px;">
      <div style="font-size:12px;color:var(--text-faint);font-family:var(--font-mono);text-transform:uppercase;margin-bottom:6px;">${f.label}</div>
      <div style="display:flex;gap:4px;">${chips}</div>
      <div style="display:flex;justify-content:space-between;margin-top:3px;">
        <span style="font-size:10px;color:var(--text-faint);font-family:var(--font-mono);">${f.lo}</span>
        <span style="font-size:10px;color:var(--text-faint);font-family:var(--font-mono);">${f.hi}</span>
      </div>
    </div>`;
  }).join('');
  main.innerHTML = `<div style="padding:16px 18px;">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div class="section-label" style="margin:0;">How are you feeling today?</div>
        ${score!==null ? `<div style="font-family:var(--font-display);font-weight:700;font-size:16px;color:${score>=70?'var(--sage)':score>=50?'var(--brass)':'var(--rust)'};">${score}/100</div>` : ''}
      </div>
      ${rows}
    </div>
    <div class="section-label" style="margin-top:18px;">Recent</div>
    ${lifestyleLogs.filter(l=>CHECKIN_FIELDS.some(f=>l[f.key]>0)).slice(0,14).map(l=>{
      const s = checkinScore(l);
      return `<div class="card" style="display:flex;justify-content:space-between;align-items:center;">
        <span class="histdate">${formatAU(l.date)}</span>
        ${s!==null ? `<span style="font-family:var(--font-display);font-weight:600;font-size:14px;color:${s>=70?'var(--sage)':s>=50?'var(--brass)':'var(--rust)'};">${s}/100</span>` : `<span style="font-size:11px;color:var(--text-faint);">Partial</span>`}
      </div>`;
    }).join('') || '<div class="emptystate">Nothing logged yet.</div>'}
  </div>`;
  main.querySelectorAll('.checkinChip').forEach(btn=>{
    btn.onclick = async ()=>{
      const field = btn.dataset.field, val = parseInt(btn.dataset.val,10);
      const current = entry[field] === val ? null : val; // tap again to clear
      const row = {
        client_id: activeClientId, date: today,
        steps: entry.steps ?? null, sleep_hours: entry.sleep_hours ?? null, sleep_quality: entry.sleep_quality ?? null,
        nutrition_note: entry.nutrition_note ?? null, other_note: entry.other_note ?? null,
        sleep_rating: entry.sleep_rating ?? null, energy_rating: entry.energy_rating ?? null,
        calm_rating: entry.calm_rating ?? null, mood_rating: entry.mood_rating ?? null,
      };
      row[field] = current;
      const { error } = await supabaseClient.from('lifestyle_logs').upsert(row, { onConflict: 'client_id,date' });
      if(error){ showToast("Couldn't save — " + error.message); return; }
      await loadLifestyleLogs();
      renderCheckin(main);
    };
  });
}

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
let settings = { startDate: null, trackCycle: true };

async function loadSettings(){
  const { data, error } = await supabaseClient.from('settings').select('*').eq('client_id', activeClientId).maybeSingle();
  if(error || !data){ settings.startDate = todayISO(); settings.trackCycle = true; return; }
  settings.startDate = data.start_date || todayISO();
  settings.trackCycle = data.track_cycle !== false;
}
async function saveStartDate(newDate){
  const { error } = await supabaseClient.from('settings').upsert({ client_id: activeClientId, start_date: newDate, track_cycle: settings.trackCycle }, { onConflict: 'client_id' });
  if(error){ showToast("Couldn't save — " + error.message); return; }
  settings.startDate = newDate;
  showToast('Start date updated');
}
async function saveTrackCycle(newValue){
  const { error } = await supabaseClient.from('settings').upsert({ client_id: activeClientId, start_date: settings.startDate, track_cycle: newValue }, { onConflict: 'client_id' });
  if(error){ showToast("Couldn't save — " + error.message); return; }
  settings.trackCycle = newValue;
  renderClientNav();
  renderSchedule(document.getElementById('mainContent'));
  showToast(newValue ? 'Cycle tracking turned on' : 'Cycle tracking turned off');
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
let scheduleViewMode = 'list';
let calendarCursor = null;
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function ymOf(iso){ return iso.slice(0,7); }
function daysInMonth(ym){ const [y,m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function shiftMonth(ym, delta){
  let [y,m] = ym.split('-').map(Number);
  m += delta;
  while(m<1){ m+=12; y--; }
  while(m>12){ m-=12; y++; }
  return `${y}-${String(m).padStart(2,'0')}`;
}
function weekdayIndexMonToSun(iso){ const d = new Date(iso+'T12:00:00').getDay(); return (d+6)%7; }

function goToLogForDate(iso, dayName){
  logState.date = iso;
  logState.dayKey = dayName;
  logState._initedForPlan = false;
  const existing = sessions.find(s=>s.date===iso);
  if(existing){
    logState.exercises = (existing.exercises||[]).map(e=>({ id: uid(), name: e.name, target: e.target||'', videoUrl: videoUrlForExerciseName(e.name), sets: (e.sets||[]).map(s=>({...s})) }));
    logState.note = existing.note || '';
    logState.warmup = existing.warmup || '';
    logState._initedForPlan = true;
  }
  view = 'log';
  renderClientNav(); renderClientView();
}

function renderSchedule(main){
  const today = todayISO();
  const { week: currentWeek, phase: currentPhase } = getWeekAndPhase(today);
  main.innerHTML = `
    <div style="padding:16px 18px;">
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
      <div><div class="eyebrow">Week</div><div style="font-family:var(--font-display);font-weight:700;font-size:20px;">${currentPhase==='Complete'?`${currentWeek} · Done`:`${Math.min(currentWeek,12)} / 12`}</div></div>
      <div class="eyebrow" style="color:var(--brass);">${escapeHtml(currentPhase)}</div>
    </div>
    <div class="card" style="margin-top:10px;">
      <div class="field" style="margin-bottom:0;"><label>Block start date</label>
        <input type="date" id="startDateInput" value="${settings.startDate}" style="width:auto;max-width:200px;">
      </div>
    </div>
    ${viewingAsClinician ? `<div class="card" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-family:var(--font-display);font-weight:600;font-size:14px;">Cycle tracking</div>
        <div style="font-size:12px;color:var(--text-faint);">Shows or hides the Cycle and Correlate tabs for this client.</div>
      </div>
      <button id="trackCycleToggle" style="background:none;border:1px solid ${settings.trackCycle?'var(--brass)':'var(--border)'};color:${settings.trackCycle?'var(--brass)':'var(--text-faint)'};border-radius:20px;padding:7px 14px;font-family:var(--font-mono);font-size:11px;flex-shrink:0;">${settings.trackCycle?'ON':'OFF'}</button>
    </div>` : ''}
    <div style="display:flex;gap:8px;margin:16px 0 10px;">
      <button id="scheduleListBtn" class="chip" style="cursor:pointer;background:${scheduleViewMode==='list'?'var(--brass)':'var(--surface-2)'};color:${scheduleViewMode==='list'?'#0A1F1A':'var(--text-dim)'};border-color:${scheduleViewMode==='list'?'var(--brass)':'var(--border)'};">List</button>
      <button id="scheduleCalBtn" class="chip" style="cursor:pointer;background:${scheduleViewMode==='calendar'?'var(--brass)':'var(--surface-2)'};color:${scheduleViewMode==='calendar'?'#0A1F1A':'var(--text-dim)'};border-color:${scheduleViewMode==='calendar'?'var(--brass)':'var(--border)'};">Calendar</button>
    </div>
    <div id="scheduleBody"></div>
    </div>
  `;
  document.getElementById('startDateInput').onchange = e=>saveStartDate(e.target.value);
  const trackCycleBtn = document.getElementById('trackCycleToggle');
  if(trackCycleBtn){ trackCycleBtn.onclick = ()=>saveTrackCycle(!settings.trackCycle); }
  document.getElementById('scheduleListBtn').onclick = ()=>{ scheduleViewMode = 'list'; renderSchedule(main); };
  document.getElementById('scheduleCalBtn').onclick = ()=>{ scheduleViewMode = 'calendar'; renderSchedule(main); };
  const body = document.getElementById('scheduleBody');
  if(scheduleViewMode === 'calendar') renderScheduleCalendarBody(body);
  else renderScheduleListBody(body);
}

function renderScheduleListBody(body){
  const today = todayISO();
  let html = `<div class="section-label">Next 14 days</div>`;
  for(let i=0;i<14;i++){
    const iso = addDaysISO(today, i);
    const dayName = weekdayForISO(iso);
    const rawDay = plan[dayName];
    const day = (rawDay && rawDay.type) ? rawDay : null;
    const { deload } = getWeekAndPhase(iso);
    const isToday = i === 0;
    const logged = sessions.some(s=>s.date===iso);
    let exList = day ? (day.type==='lift' ? (day.exercises||[]).map(e=>e.name).join(', ') : (day.desc||'')) : 'No program set';
    html += `<div class="card" style="${isToday?'border-color:var(--brass);':''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        <div>
          <div class="eyebrow" style="color:${isToday?'var(--brass)':'var(--text-faint)'};">${isToday?'TODAY · ':''}${dayName.toUpperCase()} · ${formatAU(iso)}</div>
          <div style="font-family:var(--font-display);font-weight:600;font-size:14px;">${escapeHtml(day?day.label||dayName:'No program set')}</div>
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
  body.innerHTML = html;
  body.querySelectorAll('.scheduleLogBtn').forEach(b=>{
    b.onclick = ()=>goToLogForDate(b.dataset.date, b.dataset.day);
  });
}

function renderScheduleCalendarBody(body){
  const today = todayISO();
  if(!calendarCursor) calendarCursor = ymOf(today);
  const ym = calendarCursor;
  const [y,m] = ym.split('-').map(Number);
  const totalDays = daysInMonth(ym);
  const leadBlanks = weekdayIndexMonToSun(`${ym}-01`);
  const monthLabel = `${MONTH_NAMES[m-1]} ${y}`;

  let cells = '';
  for(let i=0;i<leadBlanks;i++) cells += `<div class="calcell calblank"></div>`;
  for(let d=1; d<=totalDays; d++){
    const iso = `${ym}-${String(d).padStart(2,'0')}`;
    const dayName = weekdayForISO(iso);
    const rawDayPlan = plan[dayName];
    const dayPlan = (rawDayPlan && rawDayPlan.type) ? rawDayPlan : null;
    const { deload } = getWeekAndPhase(iso);
    const logged = sessions.some(s=>s.date===iso);
    const isToday = iso === today;
    const isPast = iso < today;
    const typeColor = !dayPlan ? 'var(--text-faint)' : dayPlan.type === 'lift' ? 'var(--brass)' : dayPlan.type === 'cardio' ? '#6E93AC' : 'var(--text-faint)';
    let dotHtml;
    if(logged){
      dotHtml = `<div class="caldot" style="background:var(--sage);"></div>`;
    } else if(isPast && dayPlan && dayPlan.type !== 'rest'){
      dotHtml = `<div class="caldot calmissed"></div>`;
    } else if(dayPlan && dayPlan.type !== 'rest'){
      dotHtml = `<div class="caldot" style="background:${typeColor};opacity:0.5;"></div>`;
    } else {
      dotHtml = `<div class="caldot" style="background:none;"></div>`;
    }
    cells += `<button class="calcell${isToday?' caltoday':''}" data-date="${iso}" data-day="${escapeAttr(dayName)}" style="${deload?'box-shadow:inset 0 0 0 1px var(--sage);':''}">
      <div class="dnum">${d}</div>${dotHtml}
    </button>`;
  }

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <button id="calPrevBtn" style="background:none;border:none;color:var(--text-dim);font-size:18px;padding:4px 10px;">&#8249;</button>
      <div style="font-family:var(--font-display);font-weight:600;font-size:14px;">${monthLabel}</div>
      <button id="calNextBtn" style="background:none;border:none;color:var(--text-dim);font-size:18px;padding:4px 10px;">&#8250;</button>
    </div>
    <div class="calweekrow">${['M','T','W','T','F','S','S'].map(d=>`<div class="calweekday">${d}</div>`).join('')}</div>
    <div class="calgrid">${cells}</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;font-size:11px;color:var(--text-faint);">
      <span><span class="legdot" style="background:var(--sage);"></span>Logged</span>
      <span><span class="legdot calmissed"></span>Missed</span>
      <span><span class="legdot" style="background:var(--brass);opacity:0.5;"></span>Lift day</span>
      <span><span class="legdot" style="background:#6E93AC;opacity:0.5;"></span>Cardio day</span>
      <span><span class="legdot" style="box-shadow:inset 0 0 0 1px var(--sage);"></span>Deload week</span>
    </div>
    ${ym!==ymOf(today) ? `<button id="calTodayBtn" class="btn secondary" style="margin-top:12px;">Jump to today</button>` : ''}
  `;
  document.getElementById('calPrevBtn').onclick = ()=>{ calendarCursor = shiftMonth(ym,-1); renderScheduleCalendarBody(body); };
  document.getElementById('calNextBtn').onclick = ()=>{ calendarCursor = shiftMonth(ym,1); renderScheduleCalendarBody(body); };
  const todayBtn = document.getElementById('calTodayBtn');
  if(todayBtn) todayBtn.onclick = ()=>{ calendarCursor = ymOf(today); renderScheduleCalendarBody(body); };
  body.querySelectorAll('.calcell:not(.calblank)').forEach(btn=>{
    btn.onclick = ()=>goToLogForDate(btn.dataset.date, btn.dataset.day);
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
// ---------- STREAK & ADHERENCE ----------
function computeCurrentStreak(){
  let streak = 0;
  let checking = todayISO();
  const today = checking;
  for(let i=0; i<365; i++){
    const dayName = weekdayForISO(checking);
    const planDay = DAY_ORDER.includes(dayName) ? plan[dayName] : null;
    if(planDay && planDay.type && planDay.type !== 'rest'){
      const logged = sessions.some(s=>s.date===checking);
      if(logged){ streak++; }
      else if(checking !== today){ break; }
    }
    checking = addDaysISO(checking, -1);
  }
  return streak;
}
function computeWeeklyAdherence(numWeeks){
  const today = todayISO();
  const currentWeekStart = addDaysISO(today, -weekdayIndexMonToSun(today));
  const weeks = [];
  for(let w=numWeeks-1; w>=0; w--){
    const weekStart = addDaysISO(currentWeekStart, -7*w);
    let scheduled = 0, logged = 0;
    const days = [];
    for(let d=0; d<7; d++){
      const iso = addDaysISO(weekStart, d);
      if(iso > today) continue;
      const dayName = weekdayForISO(iso);
      const planDay = DAY_ORDER.includes(dayName) ? plan[dayName] : null;
      if(planDay && planDay.type && planDay.type !== 'rest'){
        scheduled++;
        const wasLogged = sessions.some(s=>s.date===iso);
        if(wasLogged) logged++;
        days.push({ iso, dayName, label: planDay.label, logged: wasLogged });
      }
    }
    weeks.push({ weekStart, scheduled, logged, days, pct: scheduled ? Math.round(logged/scheduled*100) : null });
  }
  return weeks;
}
let selectedAdherenceWeekIdx = null;
function renderAdherenceBarChart(container, weeks){
  const withData = weeks.filter(w=>w.scheduled>0);
  if(withData.length === 0){
    container.innerHTML = `<div style="text-align:center;padding:20px 0;color:var(--text-faint);font-size:12px;">No scheduled (weekday) training days in your program yet — adherence tracking needs a fixed weekly schedule.</div>`;
    return;
  }
  const w = 600, h = 160, padL = 26, padR = 10, padT = 10, padB = 22;
  const n = weeks.length;
  const slot = (w - padL - padR) / n;
  const barW = slot * 0.55;
  let bars = '', labels = '';
  weeks.forEach((wk, i)=>{
    const x = padL + i*slot + (slot - barW)/2;
    const pct = wk.pct === null ? 0 : wk.pct;
    const barH = wk.pct === null ? 0 : Math.max(2, (pct/100) * (h - padT - padB));
    const y = h - padB - barH;
    const color = wk.pct === null ? '#3a3a3a' : wk.pct >= 80 ? '#4CA893' : wk.pct >= 50 ? '#C49A45' : '#C15C33';
    bars += `<rect class="adherenceHit" data-idx="${i}" x="${x.toFixed(1)}" y="${padT}" width="${barW.toFixed(1)}" height="${(h-padT-padB).toFixed(1)}" fill="transparent" style="cursor:${wk.scheduled>0?'pointer':'default'};"/>`;
    bars += `<rect data-idx="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="${color}" style="pointer-events:none;${selectedAdherenceWeekIdx===i?'opacity:1;':'opacity:0.88;'}"/>`;
    if(selectedAdherenceWeekIdx===i){
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="none" stroke="#fff" stroke-width="1.5" style="pointer-events:none;"/>`;
    }
    if(wk.pct !== null){
      bars += `<text x="${(x+barW/2).toFixed(1)}" y="${(y-4).toFixed(1)}" fill="#67655F" font-size="9" font-family="IBM Plex Mono, monospace" text-anchor="middle" style="pointer-events:none;">${pct}%</text>`;
    }
    if(i===0 || i===weeks.length-1 || i===Math.floor(weeks.length/2)){
      labels += `<text x="${(x+barW/2).toFixed(1)}" y="${h-4}" fill="#67655F" font-size="9" font-family="IBM Plex Mono, monospace" text-anchor="middle" style="pointer-events:none;">${formatAU(wk.weekStart).slice(0,5)}</text>`;
    }
  });
  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <line x1="${padL}" y1="${h-padB}" x2="${w-padR}" y2="${h-padB}" stroke="#333438" stroke-width="1"/>
    ${bars}${labels}
  </svg>
  <div style="font-size:10px;color:var(--text-faint);text-align:center;margin-top:4px;font-family:var(--font-mono);">Tap a bar for the day-by-day breakdown</div>`;
  container.querySelectorAll('.adherenceHit').forEach(hit=>{
    hit.addEventListener('click', ()=>{
      const idx = parseInt(hit.dataset.idx, 10);
      selectedAdherenceWeekIdx = (selectedAdherenceWeekIdx === idx) ? null : idx;
      renderAdherenceBarChart(container, weeks);
      renderAdherenceDetail(weeks);
    });
  });
}
function renderAdherenceDetail(weeks){
  const detail = document.getElementById('adherenceDetail');
  if(!detail) return;
  if(selectedAdherenceWeekIdx === null){ detail.innerHTML = ''; return; }
  const wk = weeks[selectedAdherenceWeekIdx];
  if(!wk || wk.days.length === 0){ detail.innerHTML = ''; return; }
  detail.innerHTML = `
    <div style="font-size:11px;color:var(--text-faint);font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">
      Week of ${formatAU(wk.weekStart)} — ${wk.logged}/${wk.scheduled} logged
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${wk.days.map(d=>`
        <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface-2);border-radius:8px;padding:8px 10px;">
          <span style="font-size:12px;">${d.dayName} · ${formatAU(d.iso).slice(0,5)} — ${escapeHtml(d.label)}</span>
          <span style="font-size:13px;color:${d.logged?'#4CA893':'#C15C33'};">${d.logged?'✓ Logged':'✕ Missed'}</span>
        </div>
      `).join('')}
    </div>`;
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
  const streak = computeCurrentStreak();
  const currentLabel = (options.find(o=>o.key===progressGroupKey)||{}).label || '';
  const activeGoal = goals.find(g=>g.exercise_key===progressGroupKey && !g.achieved);

  let goalHtml;
  if(activeGoal && activeGoal.target_weight){
    const pct = best!==null ? Math.max(4, Math.min(100, Math.round((best/activeGoal.target_weight)*100))) : 4;
    goalHtml = `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span class="eyebrow">Goal</span>
        <button id="progressGoalEditBtn" style="background:none;border:none;color:#6E93AC;font-size:11px;font-family:var(--font-mono);">EDIT</button>
      </div>
      <div style="font-family:var(--font-display);font-weight:600;font-size:15px;margin-bottom:8px;">${activeGoal.target_weight}kg${activeGoal.target_reps?' × '+escapeHtml(activeGoal.target_reps):''}</div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--brass);"></div></div>
    </div>`;
  } else {
    goalHtml = `<button id="progressGoalEditBtn" style="width:100%;background:var(--surface-2);border:1px dashed var(--border);color:var(--text-dim);border-radius:10px;padding:12px;font-size:13px;margin-bottom:14px;">+ Set a goal for ${escapeHtml(currentLabel)}</button>`;
  }

  main.innerHTML = `<div style="padding:16px 18px;">
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span class="section-label" style="margin:0;">Streak &amp; adherence</span>
        <span style="font-family:var(--font-display);font-weight:700;font-size:15px;color:var(--brass);">&#128293; ${streak} day${streak!==1?'s':''}</span>
      </div>
      <div id="adherenceChart"></div>
      <div id="adherenceDetail" style="margin-top:10px;"></div>
    </div>
    <div class="field"><label>Lift</label>
      <button type="button" id="progressLiftPickerBtn" style="width:100%;text-align:left;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:11px;font-size:15px;font-family:var(--font-body);display:flex;justify-content:space-between;align-items:center;">
        <span>${escapeHtml(currentLabel)}</span><span style="color:var(--text-faint);font-size:11px;">&#9662;</span>
      </button>
    </div>
    <div style="display:flex;gap:10px;margin:14px 0;">
      <div class="card" style="flex:1;"><div class="eyebrow">Latest top set</div><div style="font-family:var(--font-display);font-weight:700;font-size:18px;">${latest!==null?latest+'kg':'—'}</div></div>
      <div class="card" style="flex:1;"><div class="eyebrow">Best logged</div><div style="font-family:var(--font-display);font-weight:700;font-size:18px;color:var(--brass);">${best!==null?best+'kg':'—'}</div></div>
    </div>
    ${goalHtml}
    <div id="progressChart" style="margin-top:14px;"></div>
  </div>`;
  document.getElementById('progressLiftPickerBtn').onclick = ()=>openProgressLiftPicker(main, options);
  document.getElementById('progressGoalEditBtn').onclick = ()=>openGoalForm(goals.find(g=>g.exercise_key===progressGroupKey) || { exercise_key: progressGroupKey, exercise_label: currentLabel });
  renderLineChart(document.getElementById('progressChart'), data, '#4CA893');
  const weeks = computeWeeklyAdherence(8);
  renderAdherenceBarChart(document.getElementById('adherenceChart'), weeks);
  renderAdherenceDetail(weeks);
}
function openProgressLiftPicker(main, options){
  let ov = document.getElementById('progressLiftOverlay');
  if(ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'progressLiftOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;z-index:200;';
  ov.innerHTML = `<div style="background:var(--surface);border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:480px;max-height:70vh;overflow-y:auto;">
    <div style="font-family:var(--font-display);font-weight:600;font-size:16px;margin-bottom:14px;">Choose a lift</div>
    ${options.map(o=>{
      const active = o.key === progressGroupKey;
      return `<button class="progressLiftOption" data-key="${escapeAttr(o.key)}" style="width:100%;text-align:left;background:${active?'var(--brass)':'var(--surface-2)'};border:1px solid ${active?'var(--brass)':'var(--border)'};color:${active?'#0A1F1A':'var(--text)'};border-radius:8px;padding:12px 14px;margin-bottom:8px;font-family:var(--font-display);font-weight:600;font-size:14px;">${escapeHtml(o.label)}</button>`;
    }).join('')}
    <button id="progressLiftCancelBtn" style="width:100%;padding:11px;border-radius:9px;border:1px solid var(--border);background:none;color:var(--text-faint);font-family:var(--font-display);font-weight:600;font-size:13px;margin-top:6px;">Cancel</button>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('.progressLiftOption').forEach(b=>{
    b.onclick = ()=>{ progressGroupKey = b.dataset.key; ov.remove(); renderProgress(main); };
  });
  document.getElementById('progressLiftCancelBtn').onclick = ()=>ov.remove();
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
// LIBRARY VIEW
// ============================================================
const EXERCISE_LIBRARY = {"Squat pattern":["Barbell Back Squat","Barbell Front Squat","Goblet Squat","Lunges","Bulgarian Split Squat","Hack Squats","Leg Press","Pendulum Squat"],"Hinging":["Deadlift","BB Romanian Deadlift","Barbell Hip Thrust","Kas Glute Bridge","45 Degree Extension","DB Romanian Deadlift","Glute Ham Raise"],"Isolation (lower)":["Supine Bench Hamstring Curl","Seated Calf Raises","Seated Hamstring Curl Machine","Standing Calf Raise Machine","Leg Extensions"],"Pulling":["Lat Focused Neutral Grip Pulldown","Bent over barbell row","Single arm DB Rows","Prone grip seated cable row","Chest Supported T Bar Row"],"Upper pressing":["Barbell Bench Press","DB Flat Bench Press","DB Incline Bench Press","Machine Shoulder Press","DB Seated Shoulder Press"],"Isolation (upper)":["Rear delt cable fly","Bicep Curls","Cable Lateral Raise","Cross body Tricep Extensions","DB Lateral Raise"],"Mobility & warm-up":["Banded Around the Worlds","Bottom Under Press","Lat Stretch","Thoracic Extension","Spiderman"]};
let libraryCategoryFilter = 'all';
function libraryAddTargetForName(name){
  const key = canonicalKey(name);
  for(const d of Object.values(plan)){
    const match = (d.exercises||[]).find(e=>canonicalKey(e.name)===key);
    if(match && match.target) return match.target;
  }
  return '';
}
function addExerciseFromLibrary(name){
  const target = libraryAddTargetForName(name);
  if(!logState.exercises) logState.exercises = [];
  logState.exercises.push({ id: uid(), name, target, videoUrl: videoUrlForExerciseName(name), sets: [] });
  view = 'log';
  renderClientNav();
  renderClientView();
  showToast(`Added "${name}" to today's log`);
}
// ---------- MEASURE VIEW (body measurements + progress photos) ----------
let measurements = [];
let expandedMeasure = {};
let measureDraft = null;
let measureShowMore = false;
let measurePhotoUrlCache = {};
async function loadMeasurements(){
  const { data, error } = await supabaseClient.from('measurements').select('*').eq('client_id', activeClientId).order('date', { ascending: false });
  if(error){ measurements = []; return; }
  measurements = data || [];
}
function ensureMeasureDraft(){
  if(!measureDraft) measureDraft = { date: todayISO(), weight:'', waist:'', hips:'', chest:'', thigh:'', arm:'', note:'', photoBlob:null, photoPreview:null, photoVisible:false };
  return measureDraft;
}
// Compresses/resizes a picked image client-side before upload. Returns both
// a Blob (for uploading to Storage) and a dataURL (for instant local preview).
function resizeImageFile(file, maxDim, quality){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = e=>{
      const img = new Image();
      img.onload = ()=>{
        let w = img.width, h = img.height;
        if(w >= h && w > maxDim){ h = Math.round(h * maxDim/w); w = maxDim; }
        else if(h > w && h > maxDim){ w = Math.round(w * maxDim/h); h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob=>{
          if(!blob){ reject(new Error('Could not process image')); return; }
          resolve({ blob, dataUrl: canvas.toDataURL('image/jpeg', quality) });
        }, 'image/jpeg', quality);
      };
      img.onerror = ()=>reject(new Error('Could not read image'));
      img.src = e.target.result;
    };
    reader.onerror = ()=>reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
async function getSignedPhotoUrl(path){
  if(!path) return null;
  if(measurePhotoUrlCache[path]) return measurePhotoUrlCache[path];
  const { data, error } = await supabaseClient.storage.from('progress-photos').createSignedUrl(path, 3600);
  if(error || !data) return null;
  measurePhotoUrlCache[path] = data.signedUrl;
  return data.signedUrl;
}
function renderMeasure(main){
  const d = ensureMeasureDraft();
  const sorted = [...measurements].sort((a,b)=>b.date.localeCompare(a.date));
  const weightData = sorted.filter(e=>e.weight!=null).map(e=>({date:e.date, weight:parseFloat(e.weight)})).sort((a,b)=>a.date.localeCompare(b.date));

  let html = `<div style="padding:16px 18px;">
    <div class="section-label">Body measurements</div>`;

  if(weightData.length >= 2){
    html += `<div id="weightChart" style="margin-bottom:14px;"></div>`;
  }

  html += `<div class="card" style="margin-bottom:14px;">
    <div class="section-label">Log today</div>
    <div class="field"><label>Date</label><input type="date" id="measureDate" value="${d.date}"></div>
    <div class="field"><label>Weight (kg)</label><input type="text" inputmode="decimal" id="measureWeight" autocomplete="off" value="${escapeAttr(d.weight)}"></div>
    <div class="field">
      <label>Progress photo</label>
      ${d.photoPreview ? `<img src="${d.photoPreview}" style="width:100%;border-radius:8px;border:1px solid var(--border);margin-bottom:8px;">` : ''}
      <input type="file" accept="image/*" id="measurePhotoInput" style="display:none;">
      <button id="measurePhotoBtn" class="btn secondary" style="border-style:dashed;">${d.photoPreview?'Replace photo':'+ Add photo'}</button>
      ${d.photoPreview ? `
        <button id="measurePhotoRemoveBtn" style="background:none;border:none;color:var(--rust);font-family:var(--font-mono);font-size:11px;padding:6px 0 0;display:block;">Remove photo</button>
        <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--text-dim);">
          <input type="checkbox" id="measurePhotoVisibleInput" ${d.photoVisible?'checked':''}> Share this photo with my clinician
        </label>
      ` : ''}
    </div>
    <button id="measureMoreToggleBtn" style="background:none;border:none;color:#6E93AC;font-family:var(--font-mono);font-size:11px;padding:0;margin-bottom:${measureShowMore?'10px':'0'};">${measureShowMore?'− Hide other measurements':'+ Add other measurements (waist, hips, etc.)'}</button>
    ${measureShowMore ? `
    <div style="display:flex;gap:10px;margin-top:10px;">
      <div class="field" style="flex:1;"><label>Waist (cm)</label><input type="text" inputmode="decimal" id="measureWaist" autocomplete="off" value="${escapeAttr(d.waist)}"></div>
      <div class="field" style="flex:1;"><label>Hips (cm)</label><input type="text" inputmode="decimal" id="measureHips" autocomplete="off" value="${escapeAttr(d.hips)}"></div>
    </div>
    <div style="display:flex;gap:10px;">
      <div class="field" style="flex:1;"><label>Chest (cm)</label><input type="text" inputmode="decimal" id="measureChest" autocomplete="off" value="${escapeAttr(d.chest)}"></div>
      <div class="field" style="flex:1;"><label>Thigh (cm)</label><input type="text" inputmode="decimal" id="measureThigh" autocomplete="off" value="${escapeAttr(d.thigh)}"></div>
    </div>
    <div class="field"><label>Arm (cm)</label><input type="text" inputmode="decimal" id="measureArm" autocomplete="off" value="${escapeAttr(d.arm)}"></div>
    ` : ''}
    <div class="field"><label>Note</label><input type="text" id="measureNote" autocomplete="off" placeholder="Optional" value="${escapeAttr(d.note)}"></div>
    <button id="measureSaveBtn" class="btn">Save entry</button>
  </div>`;

  html += `<div class="section-label">History</div>`;
  if(sorted.length === 0){
    html += `<div class="emptystate">No measurements logged yet.</div>`;
  } else {
    sorted.forEach(e=>{
      const open = !!expandedMeasure[e.id];
      const fields = [['weight','kg'],['waist','cm'],['hips','cm'],['chest','cm'],['thigh','cm'],['arm','cm']];
      const filled = fields.filter(([k])=>e[k]!=null);
      html += `<div class="card">
        <button class="histhead measureEntryHead" data-id="${e.id}">
          <div>
            <div class="histdate">${formatAU(e.date)}</div>
            <div class="histlabel" style="font-size:14px;">${filled.length ? filled.map(([k,u])=>`${k}: ${e[k]}${u}`).join(' · ') : (e.photo_path?'Photo only':'—')}</div>
          </div>
          <span style="color:var(--text-faint);">${open?'&#9650;':'&#9660;'}</span>
        </button>`;
      if(open){
        html += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">`;
        if(e.photo_path){
          html += `<div class="measurePhotoSlot" data-path="${escapeAttr(e.photo_path)}" style="margin-bottom:10px;">
            <div class="loading2">Loading photo…</div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;color:var(--text-dim);">
            <input type="checkbox" class="measureVisibleToggle" data-id="${e.id}" ${e.photo_visible_to_clinician?'checked':''}> Share this photo with my clinician
          </label>`;
        }
        if(filled.length) html += `<div style="font-size:13px;margin-bottom:8px;">${filled.map(([k,u])=>`${k.charAt(0).toUpperCase()+k.slice(1)}: ${e[k]}${u}`).join('<br>')}</div>`;
        if(e.note) html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">${escapeHtml(e.note)}</div>`;
        html += `<button class="deleteMeasureBtn" data-id="${e.id}" data-path="${escapeAttr(e.photo_path||'')}" style="background:none;border:none;color:var(--rust);font-family:var(--font-mono);font-size:11px;">DELETE ENTRY</button>`;
        html += `</div>`;
      }
      html += `</div>`;
    });
  }
  html += `</div>`;
  main.innerHTML = html;
  if(weightData.length >= 2){
    renderLineChart(document.getElementById('weightChart'), weightData, '#4CA893');
  }
  main.querySelectorAll('.measurePhotoSlot').forEach(async slot=>{
    const url = await getSignedPhotoUrl(slot.dataset.path);
    if(url) slot.innerHTML = `<img src="${url}" style="width:100%;border-radius:8px;border:1px solid var(--border);">`;
    else slot.innerHTML = `<div style="font-size:12px;color:var(--text-faint);">Couldn't load photo.</div>`;
  });

  document.getElementById('measureDate').onchange = e=>{ d.date = e.target.value; };
  document.getElementById('measureMoreToggleBtn').onclick = ()=>{ measureShowMore = !measureShowMore; renderMeasure(main); };
  document.getElementById('measureWeight').oninput = e=>{ d.weight = e.target.value; };
  const mWaist = document.getElementById('measureWaist'); if(mWaist) mWaist.oninput = e=>{ d.waist = e.target.value; };
  const mHips = document.getElementById('measureHips'); if(mHips) mHips.oninput = e=>{ d.hips = e.target.value; };
  const mChest = document.getElementById('measureChest'); if(mChest) mChest.oninput = e=>{ d.chest = e.target.value; };
  const mThigh = document.getElementById('measureThigh'); if(mThigh) mThigh.oninput = e=>{ d.thigh = e.target.value; };
  const mArm = document.getElementById('measureArm'); if(mArm) mArm.oninput = e=>{ d.arm = e.target.value; };
  document.getElementById('measureNote').oninput = e=>{ d.note = e.target.value; };
  document.getElementById('measurePhotoBtn').onclick = ()=>document.getElementById('measurePhotoInput').click();
  document.getElementById('measurePhotoInput').onchange = async e=>{
    const file = e.target.files[0];
    if(!file) return;
    try{
      const { blob, dataUrl } = await resizeImageFile(file, 800, 0.6);
      d.photoBlob = blob;
      d.photoPreview = dataUrl;
      renderMeasure(main);
    }catch(err){
      showToast("Couldn't process that photo");
    }
  };
  const removeBtn = document.getElementById('measurePhotoRemoveBtn');
  if(removeBtn) removeBtn.onclick = ()=>{ d.photoBlob = null; d.photoPreview = null; d.photoVisible = false; renderMeasure(main); };
  const visInput = document.getElementById('measurePhotoVisibleInput');
  if(visInput) visInput.onchange = e=>{ d.photoVisible = e.target.checked; };
  document.getElementById('measureSaveBtn').onclick = async ()=>{
    if(!d.weight && !d.waist && !d.hips && !d.chest && !d.thigh && !d.arm && !d.photoBlob){
      showToast('Log at least one measurement or a photo');
      return;
    }
    let photoPath = null;
    if(d.photoBlob){
      const path = `${activeClientId}/${d.date}.jpg`;
      const { error: upErr } = await supabaseClient.storage.from('progress-photos').upload(path, d.photoBlob, { upsert: true, contentType: 'image/jpeg' });
      if(upErr){ showToast("Couldn't upload photo — " + upErr.message); return; }
      photoPath = path;
      delete measurePhotoUrlCache[path];
    }
    const row = {
      client_id: activeClientId, date: d.date,
      weight: d.weight ? parseFloat(d.weight) : null,
      waist: d.waist ? parseFloat(d.waist) : null,
      hips: d.hips ? parseFloat(d.hips) : null,
      chest: d.chest ? parseFloat(d.chest) : null,
      thigh: d.thigh ? parseFloat(d.thigh) : null,
      arm: d.arm ? parseFloat(d.arm) : null,
      note: d.note || null,
    };
    if(photoPath){ row.photo_path = photoPath; row.photo_visible_to_clinician = d.photoVisible; }
    const { error } = await supabaseClient.from('measurements').upsert(row, { onConflict: 'client_id,date' });
    if(error){ showToast("Couldn't save — " + error.message); return; }
    showToast('Measurement saved');
    measureDraft = null;
    await loadMeasurements();
    renderMeasure(main);
  };
  main.querySelectorAll('.measureEntryHead').forEach(b=>{
    b.onclick = ()=>{ expandedMeasure[b.dataset.id] = !expandedMeasure[b.dataset.id]; renderMeasure(main); };
  });
  main.querySelectorAll('.measureVisibleToggle').forEach(cb=>{
    cb.onchange = async ()=>{
      const { error } = await supabaseClient.from('measurements').update({ photo_visible_to_clinician: cb.checked }).eq('id', cb.dataset.id);
      if(error){ showToast("Couldn't update sharing setting"); return; }
      await loadMeasurements();
      showToast(cb.checked ? 'Photo shared with clinician' : 'Photo no longer shared');
    };
  });
  main.querySelectorAll('.deleteMeasureBtn').forEach(b=>{
    b.onclick = async ()=>{
      if(b.dataset.path) await supabaseClient.storage.from('progress-photos').remove([b.dataset.path]);
      const { error } = await supabaseClient.from('measurements').delete().eq('id', b.dataset.id);
      if(error){ showToast("Couldn't delete — " + error.message); return; }
      await loadMeasurements();
      renderMeasure(main);
    };
  });
}

function renderLibraryTab(main){
  const cats = Object.keys(EXERCISE_LIBRARY);
  main.innerHTML = `<div style="padding:16px 18px;">
    <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">Tap any exercise to add it to today's Log.</div>
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
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${items.map(name=>`<button class="libTabExerciseBtn" data-name="${escapeAttr(name)}" style="background:var(--surface-2);border:1px solid var(--border);border-radius:5px;padding:4px 10px;font-family:var(--font-mono);font-size:11px;color:var(--text);cursor:pointer;">${escapeHtml(name)}</button>`).join('')}</div>
      </div>`;
    });
    resultsEl.innerHTML = rhtml || `<div class="emptystate">No exercises match your search.</div>`;
    resultsEl.querySelectorAll('.libTabExerciseBtn').forEach(b=>{
      b.onclick = ()=>addExerciseFromLibrary(b.dataset.name);
    });
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
// PROGRAM EDITOR — build/edit a client's plan_data (client or clinician)
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
  if(!plan[dayKey]) plan[dayKey] = { type:'', label:'', desc:'', exercises:[] };
  return plan[dayKey];
}

function dayEditorCardHtml(k, d, removable){
  let html = `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div class="section-label" style="margin-bottom:0;">${escapeHtml(k.toUpperCase())}</div>
        ${removable ? `<button class="removeDayEdit" data-day="${escapeAttr(k)}" style="background:none;border:none;color:var(--rust);font-size:11px;font-family:var(--font-mono);">remove day</button>` : ''}
      </div>
      <div style="display:flex;gap:10px;margin:10px 0;">
        <div class="field" style="flex:1;"><label>Type</label>
          <select class="dayTypeSelect" data-day="${escapeAttr(k)}" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px;font-size:13px;">
            <option value="" ${!d.type?'selected':''}>— not set —</option>
            <option value="rest" ${d.type==='rest'?'selected':''}>Rest</option>
            <option value="cardio" ${d.type==='cardio'?'selected':''}>Cardio</option>
            <option value="lift" ${d.type==='lift'?'selected':''}>Lift</option>
          </select>
        </div>
        <div class="field" style="flex:1;"><label>Label</label><input type="text" class="dayLabelInput" data-day="${escapeAttr(k)}" value="${escapeAttr(d.label)}" placeholder="${escapeAttr(k)}"></div>
      </div>`;
  if(d.type === 'rest' || d.type === 'cardio'){
    html += `<div class="field"><label>Description</label><input type="text" class="dayDescInput" data-day="${escapeAttr(k)}" value="${escapeAttr(d.desc||'')}" placeholder="e.g. easy 5k, mobility"></div>`;
  } else if(d.type === 'lift'){
    html += `<div class="eyebrow" style="margin:10px 0 6px;">EXERCISES</div>`;
    (d.exercises||[]).forEach((ex,i)=>{
      html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <input class="exNameEdit" data-day="${escapeAttr(k)}" data-exidx="${i}" value="${escapeAttr(ex.name)}" placeholder="Exercise name" style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 8px;font-size:13px;">
        <input class="exTargetEdit" data-day="${escapeAttr(k)}" data-exidx="${i}" value="${escapeAttr(ex.target||'')}" placeholder="3x8-10" style="width:66px;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 6px;font-size:12px;font-family:var(--font-mono);">
        <button class="heroToggleEdit" data-day="${escapeAttr(k)}" data-exidx="${i}" style="background:none;border:1px solid ${ex.hero?'var(--rust)':'var(--border)'};color:${ex.hero?'var(--rust)':'var(--text-faint)'};border-radius:6px;padding:6px 7px;font-size:10px;font-family:var(--font-mono);flex-shrink:0;">HERO</button>
        <button class="removeExEdit" data-day="${escapeAttr(k)}" data-exidx="${i}" style="background:none;border:none;color:var(--text-faint);font-size:15px;flex-shrink:0;">&times;</button>
      </div>`;
    });
    html += `<div style="display:flex;gap:14px;margin-top:4px;">
      <button class="addExEdit" data-day="${escapeAttr(k)}" style="background:none;border:none;color:#6E93AC;font-family:var(--font-mono);font-size:11px;">+ Add custom</button>
      <button class="browseLibEdit" data-day="${escapeAttr(k)}" style="background:none;border:none;color:var(--brass);font-family:var(--font-mono);font-size:11px;">+ Browse library</button>
    </div>`;
  } else {
    html += `<div style="font-size:12px;color:var(--text-faint);">Choose a type above to configure this day.</div>`;
  }
  html += `</div>`;
  return html;
}

function renderProgramEditor(main){
  const flexibleDayKeys = Object.keys(plan).filter(k=>!DAY_ORDER.includes(k));
  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <div class="section-label" style="margin:0;">Edit program</div>
    <button id="doneEditingBtn" class="btn" style="width:auto;padding:8px 16px;">Done</button>
  </div>`;
  DAY_ORDER.forEach(k=>{ html += dayEditorCardHtml(k, plan[k] || { type:'', label:'', desc:'', exercises:[] }, false); });

  html += `<div class="section-label" style="margin-top:20px;">Flexible / isolated training days</div>
    <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">Not tied to a day of the week — pick one of these when logging, whatever day you actually train.</div>`;
  flexibleDayKeys.forEach(k=>{ html += dayEditorCardHtml(k, plan[k], true); });
  html += `<button id="addFlexibleDayBtn" class="btn secondary" style="margin-bottom:24px;">+ Add flexible day</button>`;

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
  const addFlexBtn = document.getElementById('addFlexibleDayBtn');
  if(addFlexBtn){
    addFlexBtn.onclick = ()=>{
      const name = prompt('Name this day (e.g. "Day 1", "Upper A")');
      if(!name || !name.trim()) return;
      const key = name.trim();
      if(plan[key]){ showToast('A day with that name already exists'); return; }
      plan[key] = { type:'lift', label: key, exercises: [] };
      renderProgramEditor(main);
    };
  }
  main.querySelectorAll('.removeDayEdit').forEach(btn=>{
    btn.onclick = ()=>{
      delete plan[btn.dataset.day];
      renderProgramEditor(main);
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
async function extractTextFromFile(file){
  const name = file.name.toLowerCase();
  const arrayBuffer = await file.arrayBuffer();
  if(name.endsWith('.pdf')){
    if(!window.pdfjsLib.GlobalWorkerOptions.workerSrc){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = '';
    for(let i=1;i<=pdf.numPages;i++){
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item=>item.str).join(' ') + '\n\n';
    }
    return text.trim();
  } else if(name.endsWith('.docx') || name.endsWith('.doc')){
    const result = await window.mammoth.extractRawText({ arrayBuffer });
    return result.value.trim();
  }
  throw new Error('Unsupported file type');
}
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
      Upload a PDF or Word doc, or paste text directly below. Start each day with a title on its own line (a day name helps but isn't required, e.g. "Monday — Upper" or just "Upper"), then list exercises underneath, one per line. Separate days with a blank line.
    </div>
    <div class="card" style="padding:14px;">
      <label style="display:block;font-size:11px;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;font-family:var(--font-mono);">Upload a file (PDF or Word)</label>
      <input type="file" id="programImportFile" accept=".pdf,.doc,.docx" style="width:100%;color:var(--text-dim);font-size:13px;">
      <div id="programImportFileStatus" style="font-size:12px;color:var(--text-faint);margin-top:8px;"></div>
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
  document.getElementById('programImportFile').onchange = async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const statusEl = document.getElementById('programImportFileStatus');
    statusEl.textContent = 'Reading file…';
    try{
      const extractedText = await extractTextFromFile(file);
      document.getElementById('programImportTextarea').value = extractedText;
      statusEl.textContent = `Loaded "${file.name}" — review the text below, then tap Parse notes.`;
    } catch(err){
      statusEl.textContent = "Couldn't read that file — try pasting the text in manually instead.";
      showToast("Couldn't extract text from that file");
    }
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
