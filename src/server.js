import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { apiRouter } from './routes/api.js';
import { runSync } from './jobs/sync.js';
import { query } from './db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Healthcheck for Railway
app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.use('/api', apiRouter);

// Auto-init the schema on first boot (idempotent)
async function ensureSchema() {
  try {
    // Check if a key table exists
    const r = await query(`
      SELECT to_regclass('public.mctb_events') AS exists
    `);
    if (!r.rows[0].exists) {
      console.log('Schema not found, initializing...');
      const initModule = await import('./db/init.js');
      // init.js exports nothing useful, but importing it doesn't auto-run because
      // the auto-run guard checks process.argv. We need to call its logic directly.
      const schemaPath = path.join(__dirname, 'db', 'init.js');
      const fs = await import('fs/promises');
      const initSrc = await fs.readFile(schemaPath, 'utf-8');
      const schemaMatch = initSrc.match(/const schema = `([\s\S]+?)`;/);
      if (schemaMatch) {
        await query(schemaMatch[1]);
        console.log('✓ Schema initialized');
      }
    } else {
      // Run schema anyway (CREATE TABLE IF NOT EXISTS is idempotent) to catch new tables
      const fs = await import('fs/promises');
      const initSrc = await fs.readFile(path.join(__dirname, 'db', 'init.js'), 'utf-8');
      const schemaMatch = initSrc.match(/const schema = `([\s\S]+?)`;/);
      if (schemaMatch) {
        await query(schemaMatch[1]);
      }
    }
  } catch (err) {
    console.error('Schema ensure failed:', err.message);
  }
}

// Schedule auto-sync every 3 days at 3 AM
if (process.env.AUTO_SYNC_ENABLED !== 'false') {
  const cronExpr = process.env.AUTO_SYNC_CRON || '0 3 */3 * *';
  if (cron.validate(cronExpr)) {
    cron.schedule(cronExpr, () => {
      console.log('[cron] Auto-sync triggered');
      runSync({ triggeredBy: 'cron' }).catch(err => {
        console.error('[cron] Sync failed:', err);
      });
    });
    console.log(`✓ Auto-sync scheduled: ${cronExpr}`);
  } else {
    console.warn(`Invalid cron expression: ${cronExpr}`);
  }
}

app.listen(PORT, async () => {
  console.log(`\n🚀 Drip AI Attribution running on port ${PORT}`);
  console.log(`   Location: ${process.env.LOCATION_NAME || 'Drip Plumbing'}`);
  console.log(`   GHL Location ID: ${process.env.GHL_LOCATION_ID || '(not set)'}`);
  console.log(`   Attribution window: ${process.env.ATTRIBUTION_WINDOW_DAYS || 30} days`);
  await ensureSchema();
  console.log('\nReady. Visit / for the dashboard.\n');
});
