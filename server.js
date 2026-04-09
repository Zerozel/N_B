require('dotenv').config();
const express = require('express');
const supabase = require('./config/supabase');
const { processIncomingMessage } = require('./flows/webhookHandler');
const { triggerMatchmaker } = require('./utils/matchmaker'); // V2: Needed for cron cascading
const { sendMessage } = require('./utils/whatsapp'); // Needed for failure alerts

const app = express();
app.use(express.json());

// Recommended: Move this to your Render environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'nexa_secure_launch_2026';

// --- 1. WEBHOOK VERIFICATION (GET) ---
// Meta uses this endpoint to verify your server is authentic
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK VERIFIED!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- 2. THE CORE RECEIVER (POST) ---
// All incoming messages from WhatsApp hit this endpoint
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // V2: Instantly acknowledge receipt to Meta to prevent timeout loops

  try {
    const body = req.body;
    
    if (body.object === 'whatsapp_business_account') {
      const value = body.entry[0].changes[0].value;

      if (value.messages && value.messages[0]) {
        const messageObj = value.messages[0];
        
        // V2 UPGRADE: Accept both 'text' and 'interactive' (buttons/lists)
        if (messageObj.type !== 'text' && messageObj.type !== 'interactive') {
            return; // Ignore audio, images, location pins for now
        }
        
        const from = messageObj.from;

        // V2 UPGRADE: Hand the ENTIRE message object to the Traffic Cop
        // so it can parse button IDs vs typed text
        await processIncomingMessage(from, messageObj);
      }
    }
  } catch (err) {
    console.error('❌ CRITICAL WEBHOOK ERROR:', err);
  }
});

// --- 3. THE V2 WATERFALL CRON (GET) ---
// Runs every 60 seconds (pinged via a cron service)
app.get('/cron', async (req, res) => {
  try {
    const sixtySecondsAgo = new Date(Date.now() - 60000).toISOString();
    
    // --- CASCADE TIER 1 TO TIER 2 ---
    const { data: stalledT1 } = await supabase
      .from('jobs')
      .select('job_id')
      .eq('status', 'SEARCHING_T1')
      .lte('updated_at', sixtySecondsAgo);

    if (stalledT1 && stalledT1.length > 0) {
      for (const job of stalledT1) {
        console.log(`⏰ T1 Expired for Job #${job.job_id}. Cascading to Tier 2.`);
        await supabase.from('jobs').update({ status: 'SEARCHING_T2', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
        triggerMatchmaker(job.job_id); // Ping T2 artisans
      }
    }

    // --- CASCADE TIER 2 TO TIER 3 ---
    const { data: stalledT2 } = await supabase
      .from('jobs')
      .select('job_id')
      .eq('status', 'SEARCHING_T2')
      .lte('updated_at', sixtySecondsAgo);

    if (stalledT2 && stalledT2.length > 0) {
      for (const job of stalledT2) {
        console.log(`⏰ T2 Expired for Job #${job.job_id}. Cascading to Tier 3.`);
        await supabase.from('jobs').update({ status: 'SEARCHING_T3', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
        triggerMatchmaker(job.job_id); // Ping T3 artisans
      }
    }

    // --- TIER 3 TIMEOUT (FAILURE) ---
    const { data: stalledT3 } = await supabase
      .from('jobs')
      .select('job_id, client_phone') 
      .eq('status', 'SEARCHING_T3')
      .lte('updated_at', sixtySecondsAgo);

    if (stalledT3 && stalledT3.length > 0) {
      for (const job of stalledT3) {
        console.log(`❌ T3 Expired for Job #${job.job_id}. FAILED.`);
        
        await supabase.from('jobs').update({ status: 'FAILED_NO_ARTISANS', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
        await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.client_phone);
        
        await sendMessage(job.client_phone, '⚠️ We are sorry, but all our verified artisans are currently busy. Please tap "Menu" to try again later.');
      }
    }

    res.status(200).send('✅ Waterfall check complete.');
  } catch (err) {
    console.error('❌ CRON JOB ERROR:', err);
    res.status(500).send('Error running cron check.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Nexa V2 Architecture is Online (Port ${PORT})`);
});
