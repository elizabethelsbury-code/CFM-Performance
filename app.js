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

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;
let currentProfile = null;
let authMode = 'login'; // 'login' | 'signup'

function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function loadProfile(){
  const { data, error } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
  if(error){ currentProfile = null; return; }
  currentProfile = data;
}

async function init(){
  try{
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if(sessionError) throw sessionError;
    if(session){
      currentUser = session.user;
      await loadProfile();
    }
    renderApp();

    supabase.auth.onAuthStateChange(async (event, session)=>{
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
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if(error){ showAuthError(error.message); return; }
  // onAuthStateChange will fire and re-render
}

async function handleSignup(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const fullName = document.getElementById('authName').value.trim();
  if(!email || !password){ showAuthError('Enter your email and password.'); return; }
  if(password.length < 6){ showAuthError('Password needs to be at least 6 characters.'); return; }
  const { error } = await supabase.auth.signUp({
    email, password,
    options: { data: { full_name: fullName } }
  });
  if(error){ showAuthError(error.message); return; }
  showAuthError('Account created — check your email to confirm, then log in.');
}

async function handleLogout(){
  await supabase.auth.signOut();
}

// ---------- CLIENT DASHBOARD (placeholder — full features coming next) ----------
function renderClientDashboard(){
  app.innerHTML = `
    <header>
      <div class="brand" style="margin:0;text-align:left;">HI, <span>${escapeHtml(currentProfile.full_name || 'THERE')}</span></div>
      <button class="btn danger" id="logoutBtn" style="width:auto;padding:9px 16px;font-size:12px;">Log out</button>
    </header>
    <main>
      <div class="card">
        <div class="eyebrow">Client account</div>
        <p style="color:var(--text-dim);font-size:14px;line-height:1.5;">
          You're logged in and connected to the database. The full Log, Schedule, History, Progress, and Cycle tabs
          get built on top of this next — this confirms your account and login are working correctly.
        </p>
      </div>
    </main>
  `;
  document.getElementById('logoutBtn').onclick = handleLogout;
}

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

  const { data: clientRows, error: clientErr } = await supabase
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
  const { data: profileRows } = await supabase.from('profiles').select('id, full_name').in('id', ids);
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
