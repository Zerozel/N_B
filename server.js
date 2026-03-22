require('dotenv').config();
const express = require('express');
const { processIncomingMessage } = require('./flows/webhookHandler');
const supabase = require('./config/supabase'); // Needed for the cron job
const { sendMessage } = require('./utils/whatsapp');

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
// --- THE 5-MINUTE CRON JOB ENDPOINT ---
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
        console.log(`⏰ Time expired for Job #${job.job_id}. Blasting to general pool.`);
        
        // 2. Find 3 available artisans in that category to take over
        const { data: backupArtisans } = await supabase
          .from('artisans')
          .select('phone_number')
          .eq('category', job.category)
          .eq('is_available', true)
          .limit(3);

        if (!backupArtisans || backupArtisans.length === 0) {
          await supabase.from('job_tickets').update({ status: 'FAILED_NO_ARTISANS' }).eq('job_id', job.job_id);
          await sendMessage(job.client_phone, '⚠️ The requested artisan didn\'t respond, and no backups are currently available. Please reply "menu" to try again later.');
          continue; // Move to the next expired job if this one fails
        }

        const backupNumbers = backupArtisans.map(a => a.phone_number);
        
        // 3. Update the ticket to show it's now a general broadcast
        await supabase.from('job_tickets').update({ 
          status: 'BROADCASTED', 
          notified_artisans: backupNumbers 
        }).eq('job_id', job.job_id);
        
        // 4. Alert the client that we are widening the search
        await sendMessage(job.client_phone, '⏳ The requested artisan is currently unavailable. We are now broadcasting your request to other verified artisans nearby...');

        // 5. Blast the backups
        for (const phone of backupNumbers) {
          await sendMessage(phone, `🚨 *FAST MATCH ALERT!* 🚨\n\n*Job ID:* #${job.job_id}\n*Category:* ${job.category}\n*Location:* ${job.location}\n*Issue:* ${job.description}\n\n*(First to accept gets the client)*\nReply *ACCEPT ${job.job_id}* to claim this job.`);
        }
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
