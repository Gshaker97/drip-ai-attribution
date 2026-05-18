import { Router } from 'express';
import { query } from '../db/pool.js';
import { runSync } from '../jobs/sync.js';

export const apiRouter = Router();

// Summary metrics for the dashboard
apiRouter.get('/summary', async (req, res) => {
  try {
    const [events, replied, attributions, lastSync] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM mctb_events`),
      query(`SELECT COUNT(*)::int AS n FROM mctb_events WHERE lead_replied = TRUE`),
      query(`
        SELECT
          attribution_type,
          COUNT(*)::int AS count,
          COALESCE(SUM(first_job_amount), 0)::numeric AS first_job_revenue,
          COALESCE(SUM(total_revenue_in_window), 0)::numeric AS total_revenue,
          COUNT(*) FILTER (WHERE is_recurring)::int AS recurring_count
        FROM attributions
        GROUP BY attribution_type
      `),
      query(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1`),
    ]);

    const newAcq = attributions.rows.find(r => r.attribution_type === 'new_acquisition') || {};
    const reactivation = attributions.rows.find(r => r.attribution_type === 'reactivation') || {};

    const totalMctb = events.rows[0].n;
    const totalReplied = replied.rows[0].n;
    const totalConverted = (newAcq.count || 0) + (reactivation.count || 0);

    res.json({
      mctb_sent: totalMctb,
      leads_saved: totalReplied,
      save_rate: totalMctb > 0 ? (totalReplied / totalMctb) : 0,
      converted: totalConverted,
      conversion_rate: totalReplied > 0 ? (totalConverted / totalReplied) : 0,
      new_acquisition: {
        count: newAcq.count || 0,
        first_job_revenue: parseFloat(newAcq.first_job_revenue || 0),
        total_revenue: parseFloat(newAcq.total_revenue || 0),
        recurring_count: newAcq.recurring_count || 0,
      },
      reactivation: {
        count: reactivation.count || 0,
        first_job_revenue: parseFloat(reactivation.first_job_revenue || 0),
        total_revenue: parseFloat(reactivation.total_revenue || 0),
        recurring_count: reactivation.recurring_count || 0,
      },
      total_first_job_revenue: parseFloat(newAcq.first_job_revenue || 0) + parseFloat(reactivation.first_job_revenue || 0),
      total_revenue: parseFloat(newAcq.total_revenue || 0) + parseFloat(reactivation.total_revenue || 0),
      last_sync: lastSync.rows[0] || null,
    });
  } catch (err) {
    console.error('GET /summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Detailed list of attributed leads
apiRouter.get('/attributions', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        a.id,
        a.attribution_type,
        a.first_job_amount,
        a.first_job_date,
        a.is_recurring,
        a.total_jobs_in_window,
        a.total_revenue_in_window,
        a.match_method,
        a.match_confidence,
        e.contact_name,
        e.contact_phone,
        e.mctb_sent_at,
        e.first_reply_at,
        c.first_name AS hcp_first_name,
        c.last_name AS hcp_last_name
      FROM attributions a
      JOIN mctb_events e ON e.id = a.mctb_event_id
      LEFT JOIN hcp_customers c ON c.hcp_customer_id = a.hcp_customer_id
      ORDER BY a.first_job_date DESC NULLS LAST
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /attributions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// All MCTB events (whether attributed or not)
apiRouter.get('/mctb-events', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        e.id,
        e.contact_name,
        e.contact_phone,
        e.contact_email,
        e.mctb_sent_at,
        e.lead_replied,
        e.first_reply_at,
        e.message_count,
        a.attribution_type,
        a.first_job_amount,
        a.is_recurring
      FROM mctb_events e
      LEFT JOIN attributions a ON a.mctb_event_id = e.id
      ORDER BY e.mctb_sent_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /mctb-events error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manual sync trigger
apiRouter.post('/sync', async (req, res) => {
  try {
    const days = req.body?.days ? parseInt(req.body.days, 10) : undefined;
    // Run in background, return immediately
    runSync({ triggeredBy: 'manual', daysBack: days }).catch(err => {
      console.error('Background sync failed:', err);
    });
    res.json({ status: 'started', message: 'Sync started in background' });
  } catch (err) {
    console.error('POST /sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Recent sync runs (for status display)
apiRouter.get('/sync-runs', async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 10
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /sync-runs error:', err);
    res.status(500).json({ error: err.message });
  }
});
