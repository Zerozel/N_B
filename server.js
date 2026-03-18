// ============================================================================
// NEXA DISPATCH BOT - PRODUCTION ENGINE (V2.0 - META CLOUD API)
// Architecture: Node.js + Express + Meta Graph API + Supabase
// Design Pattern: Finite State Machine & Broadcast-Claim Dispatch
// ============================================================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// --- SYSTEM INITIALIZATION ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const VERIFY_TOKEN = 'nexa_secure_launch_2026';

// --- META API SEND ENGINE (AXIOS + LEGACY SCRUBBER) ---
async function sendMessage(toPhoneNumber, messageText) {
  // 🛡️ THE FIX: Automatically clean old database tags (@c.us) before sending
  const cleanNumber = String(toPhoneNumber).replace('@c.us', '');
  
  const url = `https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`;
  
  const payload = {
    messaging_product: 'whatsapp',
    to: cleanNumber,
    type: 'text',
    text: { body: messageText }
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    if (err.response) {
      console.error(`❌ META REJECTED PAYLOAD TO ${cleanNumber}:`, JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('❌ NETWORK DROP:', err.message);
    }
  }
}

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

// --- THE CORE MESSAGE ROUTER & STATE MACHINE (POST) ---
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // 1. Instantly acknowledge receipt to Meta

  try {
    const body = req.body;
    
    if (body.object === 'whatsapp_business_account') {
      const value = body.entry[0].changes[0].value;

      if (value.messages && value.messages[0]) {
        if (value.messages[0].type !== 'text') {
          // Defense: Handle non-text messages smoothly
          await sendMessage(value.messages[0].from, '⚠️ Please send a text message. I cannot process images, audio, or stickers right now.');
          return;
        }

        const from = value.messages[0].from; // Clean number directly from Meta (e.g., 23490...)
        const text = value.messages[0].text.body.trim();

        console.log(`\n📩 INCOMING [${from}]: ${text}`);

        // --- PHASE A: USER STATE MANAGEMENT ---
        let { data: user } = await supabase.from('users').select('*').eq('phone_number', from).single();
        
        if (!user) {
          const { data: newUser } = await supabase
            .from('users')
            .insert([{ phone_number: from, status: 'NEW', user_type: 'CLIENT' }])
            .select().single();
          user = newUser;
        } else {
          await supabase.from('users').update({ last_message: text }).eq('phone_number', from); 
        }

        // --- PHASE B: GLOBAL COMMANDS ---
        if (text.toLowerCase() === 'menu' || text.toLowerCase() === 'cancel') {
          await supabase.from('users').update({ status: 'AWAITING_INTAKE_TYPE' }).eq('phone_number', from);
          return await sendMessage(from, '🔄 *Main Menu* 🛠️\n\nReply with a number:\n1️⃣ Service Call\n2️⃣ Make an Enquiry');
        }

        // --- PHASE C: ARTISAN FASTEST-FINGER CLAIM SYSTEM ---
        const cleanText = text.replace(/\*/g, '').toUpperCase();
        
        if (cleanText.startsWith('ACCEPT ')) {
          const jobId = cleanText.split(' ')[1]; 
          
          const { data: ticket } = await supabase.from('job_tickets').select('*').eq('job_id', jobId).single();
          
          if (!ticket) return await sendMessage(from, '❌ Invalid Job ID.');
          if (ticket.status !== 'BROADCASTED') return await sendMessage(from, '🔒 Sorry, this job has already been claimed by another artisan or cancelled.');
          
          await supabase.from('job_tickets').update({
            status: 'PENDING_CLIENT_APPROVAL',
            awarded_artisan: from
          }).eq('job_id', jobId);
          
          await sendMessage(from, '✅ *Job Claimed!* \n\nWe are asking the client for final approval. Please stand by, we will send you their contact shortly.');
          
          const { data: artisanProfile } = await supabase
            .from('artisans')
            .select('name, rating')
            .eq('phone_number', from)
            .limit(1)
            .single();
          
          await supabase.from('users').update({ status: `AWAITING_APPROVAL_${jobId}` }).eq('phone_number', ticket.client_phone);
          
          return await sendMessage(
            ticket.client_phone,
            `🔔 *Good news! We found an available ${ticket.category}.*\n\n🧑‍🔧 *Personnel:* ${artisanProfile.name}\n⭐ *Rating:* ${artisanProfile.rating}/5.0\n✅ *Nexa Verified*\n\nReply *YES* to approve and receive their contact details, or *NO* to cancel.`
          );
        }

        // --- PHASE D: CLIENT DOUBLE-OPT-IN APPROVAL ---
        if (user.status.startsWith('AWAITING_APPROVAL_')) {
          const jobId = user.status.split('_')[2];
          
          if (cleanText === 'YES') {
            const { data: ticket } = await supabase.from('job_tickets').select('*').eq('job_id', jobId).single();
            
            await supabase.from('job_tickets').update({ status: 'MATCHED' }).eq('job_id', jobId);
            await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
            
            await supabase.from('artisans').update({ is_available: false }).eq('phone_number', ticket.awarded_artisan);
            await supabase.from('users').update({ status: `ACTIVE_JOB_${jobId}` }).eq('phone_number', ticket.awarded_artisan);
            
            await sendMessage(from, `✅ *Match Confirmed!*\n\nYour artisan is ready. Please call or message them now:\n📞 *WhatsApp:* +${ticket.awarded_artisan}\n\n💬 *Need help? Chat with Nexa Customer Service: 09045955670*`);
            
            await sendMessage(
              ticket.awarded_artisan,
              `✅ *Job #${jobId} Approved!*\n\nThe client is expecting you. Reach out to them immediately to arrange pricing and timing:\n📞 *Client Number:* +${ticket.client_phone}\n📍 *Location:* ${ticket.location}\n📝 *Issue:* ${ticket.description}\n\n⚠️ *IMPORTANT: You will NOT receive any new job alerts until this ticket is closed.*\n\nReply to this chat with:\n*1* - Job Completed\n*2* - Job Cancelled`
            );
          } else {
            await sendMessage(from, '❌ Approval cancelled. The job has been aborted. Reply "menu" to start a new search.');
            await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
          }
          return;
        }

        //
