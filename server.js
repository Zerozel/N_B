require('dotenv').config();
const express = require('express');
const { processIncomingMessage } = require('./flows/webhookHandler');
const supabase = require('./config/supabase'); // Needed for the cron job

const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'nexa_secure_launch_2026';

// --- WEBHOOK VERIFICATION (GET) ---
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

// --- THE CORE RECEIVER (POST) ---
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Instantly acknowledge receipt to Meta

  try {
    const body = req.body;
    
    if (body.object === 'whatsapp_business_account') {
      const value = body.entry[0].changes[0].value;

      if (value.messages && value.messages[0]) {
        if (value.messages[0].type !== 'text') return; // Ignore audio/images for now
        
        const from = value.messages[0].from;
        const text = value.messages[0].text.body;

        // Hand the data off to the Traffic Cop
        await processIncomingMessage(from, text);
      }
    }
  } catch (err) {
    console.error('❌ CRITICAL WEBHOOK ERROR:', err);
  }
});

// --- THE 5-MINUTE CRON JOB ENDPOINT ---
// You will set up cron-job.org to ping https://your-app.onrender.com/cron every 1 minute
app.get('/cron', async (req, res) => {
  try {
    // 1. Find jobs that are PENDING_PREFERRED_ARTISAN and older than 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
    
    const { data: expiredJobs } = await supabase
      .from('job_tickets')
      .select('*')
      .eq('status', 'PENDING_PREFERRED_ARTISAN')
      .lte('created_at', fiveMinutesAgo);

    if (expiredJobs && expiredJobs.length > 0) {
      for (const job of expiredJobs) {
        // 2. Change status to BROADCASTED
        await supabase.from('job_tickets').update({ status: 'BROADCASTED' }).eq('job_id', job.job_id);
        
        // 3. Blast to the general pool (Logic to be expanded here or in utils)
        console.log(`⏰ Time expired for Job #${job.job_id}. Blasting to general pool.`);
        // Note: You will inject the sendMessage broadcast loop here to alert 3 random artisans.
      }
    }
    
    res.status(200).send('Cron check complete.');
  } catch (err) {
    console.error('❌ CRON JOB ERROR:', err);
    res.status(500).send('Error running cron check.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Nexa Production Architecture is Online (Port ${PORT})`);
});
