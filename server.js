require('dotenv').config(); // Must be first line
const express = require('express');
const supabase = require('./config/supabase');
const { processIncomingMessage } = require('./flows/webhookHandler');
const { triggerMatchmaker } = require('./utils/matchmaker');
const { sendMessage } = require('./utils/whatsapp');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
if (!VERIFY_TOKEN) throw new Error('❌ FATAL: VERIFY_TOKEN is not set in environment.');

// --- 1. WEBHOOK VERIFICATION (GET) ---
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK VERIFIED!');
    res.status(200).send(challenge);
  } else {
    console.warn(`⚠️  Webhook verify failed. Got token: "${token}"`);
    res.sendStatus(403);
  }
});

// --- 2. THE CORE RECEIVER (POST) ---
app.post('/webhook', async (req, res) => {
  // Acknowledge immediately — Meta will retry if we don't respond within 20s
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    // Ignore status updates (delivered/read receipts) — only process actual messages
    if (value.statuses) return;

    const messageObj = value?.messages?.[0];
    if (!messageObj) return;

    if (messageObj.type !== 'text' && messageObj.type !== 'interactive') {
      console.log(`⚠️  Ignoring unsupported message type: ${messageObj.type}`);
      return;
    }

    const from = messageObj.from;
    console.log(`\n📩 Incoming from ${from} [${messageObj.type}]`);

    await processIncomingMessage(from, messageObj);

  } catch (err) {
    console.error('❌ CRITICAL WEBHOOK ERROR:', err);
  }
});

// --- 3. WATERFALL CRON (GET) ---
// Hit this endpoint every 60 seconds from an external cron service (e.g. cron-job.org).
// It acts as a safety net: if the server restarted and lost its in-memory setTimeout,
// the cron rescues any jobs that got stuck mid-waterfall.
app.get('/cron', async (req, res) => {
  try {
    // 10-minute threshold — matches the in-memory timer in matchmaker.js
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    // Rescue stalled Referred searches → drop to public T1
    const { data: stalledRef } = await supabase
      .from('jobs').select('job_id').eq('status', 'SEARCHING_REFERRED').lte('updated_at', tenMinutesAgo);

    for (const job of (stalledRef || [])) {
      console.log(`⏰ Referred timeout → T1 for Job #${job.job_id}`);
      await supabase.from('jobs').update({
        status: 'SEARCHING_T1',
        referred_artisan: null,
        updated_at: new Date().toISOString()
      }).eq('job_id', job.job_id);
      triggerMatchmaker(job.job_id);
    }

    // Cascade T1 → T2
    const { data: stalledT1 } = await supabase
      .from('jobs').select('job_id').eq('status', 'SEARCHING_T1').lte('updated_at', tenMinutesAgo);

    for (const job of (stalledT1 || [])) {
      console.log(`⏰ T1 Expired → T2 for Job #${job.job_id}`);
      await supabase.from('jobs').update({ status: 'SEARCHING_T2', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
      triggerMatchmaker(job.job_id);
    }

    // Cascade T2 → T3
    const { data: stalledT2 } = await supabase
      .from('jobs').select('job_id').eq('status', 'SEARCHING_T2').lte('updated_at', tenMinutesAgo);

    for (const job of (stalledT2 || [])) {
      console.log(`⏰ T2 Expired → T3 for Job #${job.job_id}`);
      await supabase.from('jobs').update({ status: 'SEARCHING_T3', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
      triggerMatchmaker(job.job_id);
    }

    // T3 timeout → FAILED
    const { data: stalledT3 } = await supabase
      .from('jobs').select('job_id, client_phone, referred_artisan').eq('status', 'SEARCHING_T3').lte('updated_at', tenMinutesAgo);

    for (const job of (stalledT3 || [])) {
      console.log(`❌ T3 Expired for Job #${job.job_id}. FAILED.`);
      await supabase.from('jobs').update({ status: 'FAILED_NO_ARTISANS', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.client_phone);
      if (job.referred_artisan && !job.referred_artisan.startsWith('NX-')) {
        await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.referred_artisan);
      }
      await sendMessage(job.client_phone, '⚠️ We are sorry, but all our verified artisans are currently busy. Please tap "Menu" to try again later.');
    }

    res.status(200).send(`✅ Cron OK | ref:${stalledRef?.length||0} t1:${stalledT1?.length||0} t2:${stalledT2?.length||0} t3:${stalledT3?.length||0}`);
  } catch (err) {
    console.error('❌ CRON JOB ERROR:', err);
    res.status(500).send('Cron error.');
  }
});

// --- 4. HEALTH CHECK ---
app.get('/health', (_, res) => res.status(200).json({ status: 'ok', version: '2.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Nexa V2 is Online → Port ${PORT}`);

  // Self-ping every 14 minutes to prevent Render free tier from sleeping.
  // Active jobs cannot afford a 30-second cold start in the middle of a dispatch.
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await axios.get(`${SELF_URL}/health`);
      console.log('💓 Self-ping OK');
    } catch (e) {
      console.warn('💔 Self-ping failed:', e.message);
    }
  }, 14 * 60 * 1000); // 14 minutes
});
