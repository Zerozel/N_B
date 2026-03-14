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
          await supabase.from('users').update({ last_message: text }).eq('phone_number', from); // Removed updated_at to rely on Supabase defaults
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

        // --- PHASE E: ARTISAN JOB COMPLETION TRACKER ---
        if (user.status.startsWith('ACTIVE_JOB_')) {
          const jobId = user.status.split('_')[2];

          if (text === '1' || text === '2') {
            const reportedStatus = text === '1' ? 'COMPLETED' : 'CANCELLED';

            await supabase.from('job_tickets').update({ status: `PENDING_VERIFICATION_${reportedStatus}` }).eq('job_id', jobId);
            
            await supabase.from('artisans').update({ is_available: true }).eq('phone_number', from);
            await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);

            await sendMessage(from, `✅ System Updated! Job #${jobId} reported as ${reportedStatus}. You are now back in the available pool for new requests.`);

            const { data: ticket } = await supabase.from('job_tickets').select('client_phone').eq('job_id', jobId).single();
            if(ticket && ticket.client_phone) {
              await supabase.from('users').update({ status: `VERIFYING_JOB_${jobId}_${reportedStatus}` }).eq('phone_number', ticket.client_phone);
              
              const actionText = reportedStatus === 'COMPLETED' ? 'COMPLETED the service' : 'CANCELLED the service';
              await sendMessage(ticket.client_phone, `🔔 *Job Verification Required!*\n\nThe artisan reported that they have *${actionText}* for Job #${jobId}.\n\nPlease verify by replying with a number:\n*1* - Yes, I confirm this.\n*2* - No, I dispute this (Report an issue).`);
            }
          } else {
            await sendMessage(from, '❌ Invalid choice.\n\n⚠️ *You cannot receive new jobs until you close this one.*\n\nPlease reply with:\n*1* - Job Completed\n*2* - Job Cancelled');
          }
          return;
        }

        // --- PHASE F: CLIENT VERIFICATION & DISPUTE ---
        if (user.status.startsWith('VERIFYING_JOB_')) {
          const parts = user.status.split('_');
          const jobId = parts[2];
          const reportedStatus = parts[3]; 

          if (text === '1') {
            await supabase.from('job_tickets').update({ status: reportedStatus }).eq('job_id', jobId);
            await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
            await sendMessage(from, '✅ Thank you for confirming! Your ticket is now officially closed. Reply "menu" anytime to request a new service.');
          } else if (text === '2') {
            await supabase.from('job_tickets').update({ status: 'DISPUTED' }).eq('job_id', jobId);
            await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
            await sendMessage(from, `⚠️ We have logged this job as DISPUTED. A Nexa Customer Service agent will review the issue and contact you shortly to resolve this.\n\n💬 *Direct support line: 09045955670*`);
          } else {
            await sendMessage(from, '❌ Invalid choice. Please reply with *1* to Confirm, or *2* to Dispute.');
          }
          return;
        }

        // --- PHASE G: ENQUIRY MODE LOOP ---
        if (user.status === 'ENQUIRY_MODE') {
          await supabase.from('users').update({ status: 'WAITING_FOR_MATCH' }).eq('phone_number', from);
          return await sendMessage(from, '✅ *Your enquiry has been received!*\n\nA human agent will review this shortly. For immediate assistance or complaints, please chat directly with Nexa Customer Service at: *09045955670*\n\n(Reply "menu" anytime to start a new request).');
        }
        
        // --- PHASE G.5: THE HOLDING ROOM ---
        if (user.status === 'WAITING_FOR_MATCH') {
          return await sendMessage(from, '⏳ We are currently contacting available artisans in your area. Please stand by!\n\n(Reply "menu" at any time to cancel this search and start over).');
        }

        // --- PHASE H: THE CLIENT INTAKE FUNNEL (State Machine) ---
        if (user.status === 'NEW' || user.status === 'IDLE') {
          await supabase.from('users').update({ status: 'AWAITING_INTAKE_TYPE' }).eq('phone_number', from);
          return await sendMessage(from, 'Welcome to *Nexa*! 🛠️\n\nAre you looking for a service or just asking a question?\nReply with a number:\n1️⃣ Service Call\n2️⃣ Make an Enquiry');
        }
        
        if (user.status === 'AWAITING_INTAKE_TYPE') {
          if (text === '1') {
            await supabase.from('users').update({ status: 'AWAITING_CATEGORY' }).eq('phone_number', from);
            return await sendMessage(from, 'Great. What type of artisan do you need right now?\n\n1️⃣ Electrical\n2️⃣ Plumbing\n3️⃣ Carpentry');
          } else if (text === '2') {
            await supabase.from('users').update({ status: 'ENQUIRY_MODE' }).eq('phone_number', from);
            return await sendMessage(from, 'Please type your enquiry below. A Nexa agent will review it shortly. (Reply "menu" at any time to go back).\n\n*Direct Customer Service: 09045955670*');
          } else {
            return await sendMessage(from, '❌ Invalid choice. Please reply with just the number *1* or *2*.');
          }
        }
        
        if (user.status === 'AWAITING_CATEGORY') {
          const categories = { '1': 'Electrical', '2': 'Plumbing', '3': 'Carpentry' };
          if (categories[text]) {
            await supabase.from('users').update({ status: `AWAITING_LOCATION_${categories[text]}` }).eq('phone_number', from);
            return await sendMessage(from, `✅ You selected *${categories[text]}*.\n\nPlease reply with your exact location/address (e.g., Block A, Campus Hostel).`);
          } else {
            return await sendMessage(from, '❌ Invalid choice. Please reply with *1*, *2*, or *3*.');
          }
        }
        
        if (user.status.startsWith('AWAITING_LOCATION_')) {
          const category = user.status.split('_')[2];
          await supabase.from('users').update({ status: `AWAITING_DESC_${category}_${text}` }).eq('phone_number', from);
          return await sendMessage(from, '📍 Location saved.\n\nFinally, please briefly describe the issue (e.g., "Sparking wall socket" or "Broken pipe").');
        }
        
        if (user.status.startsWith('AWAITING_DESC_')) {
          const parts = user.status.split('_');
          const category = parts[2];
          const location = parts.slice(3).join('_'); 
          const description = text;
          
          const { data: job, error: jobError } = await supabase.from('job_tickets').insert([{
            client_phone: from,
            category: category,
            location: location,
            description: description,
            status: 'SEARCHING'
          }]).select().single();
          
          if (jobError) throw jobError;
          
          await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
          await sendMessage(from, '⚙️ *Request received!* Processing your ticket...\nSearching for available artisans nearby. We will notify you once a match is found.');
          
          console.log(`🚨 INITIATING BROADCAST FOR JOB #${job.job_id} | Category: ${category}`);
          
          const { data: artisans } = await supabase
            .from('artisans')
            .select('*')
            .eq('category', category)
            .eq('is_available', true)
            .limit(3);
          
          if (!artisans || artisans.length === 0) {
            await supabase.from('job_tickets').update({ status: 'FAILED_NO_ARTISANS' }).eq('job_id', job.job_id);
            return await sendMessage(from, '⚠️ We are sorry, but there are no available artisans in that category right now. Please try again later.\n\n💬 *For further assistance, chat with Nexa Customer Service: 09045955670*');
          }
          
          const artisanNumbers = artisans.map(a => a.phone_number);
          
          await supabase.from('job_tickets').update({
            status: 'BROADCASTED',
            notified_artisans: artisanNumbers
          }).eq('job_id', job.job_id);
          
          // Fire the Broadcast
          for (const phone of artisanNumbers) {
            await sendMessage(
              phone,
              `🚨 *FAST MATCH ALERT!* 🚨\n\n*Job ID:* #${job.job_id}\n*Category:* ${category}\n*Location:* ${location}\n*Issue:* ${description}\n\n*(First to accept gets the client)*\nReply *ACCEPT ${job.job_id}* to claim this job.`
            );
          }
          return;
        }
        
      }
    }
  } catch (err) {
    console.error('❌ CRITICAL SYSTEM ERROR:', err);
    // Attempting a fail-safe message if 'from' is known, but usually best just to log it to prevent infinite loops
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Nexa Core is Online (Port ${PORT})`);
});
