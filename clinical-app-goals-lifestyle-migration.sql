-- ============================================================
-- Migration: Goals, Lifestyle tracking, and Exercise video links
-- Paste into Supabase SQL Editor and run.
-- ============================================================

-- ---------- GOALS ----------
-- A client's target for a specific lift, e.g. "Hip thrust, 190kg".
-- exercise_key is a normalised name (lowercase, trimmed) so it can be
-- matched against however the exercise is actually logged.

create table goals (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references clients(id) not null,
  exercise_key text not null,
  exercise_label text not null,      -- the display name, e.g. "Hip thrust"
  target_weight numeric,
  target_reps text,
  target_date date,                  -- optional deadline
  achieved boolean default false,
  achieved_date date,
  note text,
  created_at timestamptz default now(),
  unique (client_id, exercise_key)
);

alter table goals enable row level security;

create policy "Clients can manage their own goals"
  on goals for all
  using (client_id = auth.uid())
  with check (client_id = auth.uid());

create policy "Clinicians can view their clients' goals"
  on goals for select
  using (client_id in (select id from clients where clinician_id = auth.uid()));


-- ---------- LIFESTYLE LOGS ----------
-- Daily lifestyle variables that might affect training: steps, sleep,
-- nutrition, plus a general note. One row per client per day.

create table lifestyle_logs (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references clients(id) not null,
  date date not null,
  steps int,
  sleep_hours numeric,
  sleep_quality text,               -- e.g. 'poor' / 'okay' / 'good'
  nutrition_note text,
  other_note text,
  created_at timestamptz default now(),
  unique (client_id, date)
);

alter table lifestyle_logs enable row level security;

create policy "Clients can manage their own lifestyle logs"
  on lifestyle_logs for all
  using (client_id = auth.uid())
  with check (client_id = auth.uid());

create policy "Clinicians can view their clients' lifestyle logs"
  on lifestyle_logs for select
  using (client_id in (select id from clients where clinician_id = auth.uid()));


-- ============================================================
-- Note on video links: no schema change needed for these.
-- Each exercise inside a client's `plans.plan_data` (jsonb) can simply
-- carry an extra "videoUrl" field, e.g.:
--   {"name": "Hip thrust", "target": "4x5-8", "hero": true,
--    "videoUrl": "https://youtube.com/..."}
-- The existing plans table already stores this as flexible JSON.
--
-- Note on "log an exercise not in the program": this is just a normal
-- session entry with a custom exercise name — no schema change needed,
-- the sessions.exercises jsonb column already allows any exercise name.
-- ============================================================
