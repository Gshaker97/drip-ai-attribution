import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

const schema = `
-- GHL conversations where the Missed Call Text Back was sent
CREATE TABLE IF NOT EXISTS mctb_events (
  id SERIAL PRIMARY KEY,
  ghl_conversation_id TEXT UNIQUE NOT NULL,
  ghl_contact_id TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT NOT NULL,
  contact_phone_normalized TEXT NOT NULL,
  contact_email TEXT,
  mctb_sent_at TIMESTAMPTZ NOT NULL,
  lead_replied BOOLEAN DEFAULT FALSE,
  first_reply_at TIMESTAMPTZ,
  message_count INTEGER DEFAULT 1,
  ghl_contact_created_at TIMESTAMPTZ,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mctb_phone ON mctb_events(contact_phone_normalized);
CREATE INDEX IF NOT EXISTS idx_mctb_sent ON mctb_events(mctb_sent_at);
CREATE INDEX IF NOT EXISTS idx_mctb_replied ON mctb_events(lead_replied);

-- HCP customers (cached for matching)
CREATE TABLE IF NOT EXISTS hcp_customers (
  id SERIAL PRIMARY KEY,
  hcp_customer_id TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  phone_normalized TEXT,
  mobile_number TEXT,
  mobile_number_normalized TEXT,
  hcp_created_at TIMESTAMPTZ,
  raw_data JSONB,
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hcp_phone ON hcp_customers(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_hcp_mobile ON hcp_customers(mobile_number_normalized);
CREATE INDEX IF NOT EXISTS idx_hcp_email ON hcp_customers(email);

-- HCP jobs (cached)
CREATE TABLE IF NOT EXISTS hcp_jobs (
  id SERIAL PRIMARY KEY,
  hcp_job_id TEXT UNIQUE NOT NULL,
  hcp_customer_id TEXT NOT NULL,
  job_status TEXT,
  total_amount NUMERIC(12, 2),
  outstanding_balance NUMERIC(12, 2),
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  hcp_created_at TIMESTAMPTZ,
  invoice_number TEXT,
  raw_data JSONB,
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hcp_jobs_customer ON hcp_jobs(hcp_customer_id);
CREATE INDEX IF NOT EXISTS idx_hcp_jobs_created ON hcp_jobs(hcp_created_at);

-- The actual attribution results
CREATE TABLE IF NOT EXISTS attributions (
  id SERIAL PRIMARY KEY,
  mctb_event_id INTEGER REFERENCES mctb_events(id) ON DELETE CASCADE,
  hcp_customer_id TEXT NOT NULL,
  attribution_type TEXT NOT NULL CHECK (attribution_type IN ('new_acquisition', 'reactivation')),
  first_job_id TEXT,
  first_job_amount NUMERIC(12, 2),
  first_job_date TIMESTAMPTZ,
  is_recurring BOOLEAN DEFAULT FALSE,
  total_jobs_in_window INTEGER DEFAULT 0,
  total_revenue_in_window NUMERIC(12, 2) DEFAULT 0,
  match_method TEXT,
  match_confidence TEXT,
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(mctb_event_id, hcp_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_attr_type ON attributions(attribution_type);
CREATE INDEX IF NOT EXISTS idx_attr_event ON attributions(mctb_event_id);

-- Sync run log
CREATE TABLE IF NOT EXISTS sync_runs (
  id SERIAL PRIMARY KEY,
  triggered_by TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  date_range_start TIMESTAMPTZ,
  date_range_end TIMESTAMPTZ,
  mctb_events_found INTEGER DEFAULT 0,
  hcp_customers_synced INTEGER DEFAULT 0,
  hcp_jobs_synced INTEGER DEFAULT 0,
  attributions_created INTEGER DEFAULT 0,
  error_message TEXT,
  notes JSONB
);

CREATE INDEX IF NOT EXISTS idx_sync_started ON sync_runs(started_at DESC);
`;

async function init() {
  console.log('Initializing database schema...');
  try {
    await pool.query(schema);
    console.log('✓ Database schema initialized successfully');
  } catch (err) {
    console.error('✗ Database init failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  init();
}

export { pool };
