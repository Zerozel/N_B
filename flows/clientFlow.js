const supabase = require('../config/supabase');
const { triggerMatchmaker } = require('../utils/matchmaker');
const { sendMessage, sendButtonMessage, sendListMessage } = require('../utils/whatsapp');

const CUSTOMER_SERVICE_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171'; 

async function handleClientFlow(profile, payload, isButton, referredBy) {
  const from = profile.phone_number;
  
  // Normalize payload so fuzzy text matching (like 'Yes' or 'Correct') works flawlessly
  const command = typeof payload === 'string' ? payload.toUpperCase() : '';

  // --- 1. ENQUIRY MODE ---
  if (profile.current_status === 'ENQUIRY_MODE') {
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendMessage(CUSTOMER_SERVICE_NUMBER, `🚨 *NEW NEXA ENQUIRY*\n*From:* +${from}\n*Message:* "${payload}"`);
    await sendMessage(from, '✅ *Your enquiry has been received!*\n\nA human agent will review this shortly. For immediate assistance, chat with us at: 2347079722171');
    return true;
  }

  // --- 1.5. V2 DEEP-LINK FAST-TRACK ---
  if (referredBy && (profile.current_status === 'NEW' || profile.current_status === 'IDLE')) {
    const catMatch = payload.match(/need a (\w+) service/i);
    const category = catMatch ? catMatch[1].charAt(0).toUpperCase() + catMatch[1].slice(1).toLowerCase() : 'Unknown';

    const { data: job, error } = await supabase.from('jobs').insert([{
      client_phone: from,
      category: category,
      status: 'DRAFT',
      referred_artisan: referredBy 
    }]).select().single();

    if (error) throw error;

    await supabase.from('profiles').update({ current_status: 'AWAITING_ZONE' }).eq('phone_number', from);

    const zones = [
      { title: "Campus", rows: [{ id: "ZONE_GIDAN_KWANO", title: "Gidan Kwano" }, { id: "ZONE_BOSSO", title: "Bosso" }] },
      { title: "Town", rows: [{ id: "ZONE_MINNA_TOWN", title: "Minna Town" }] }
    ];

    await sendListMessage(from, `👋 *Welcome to Nexa!*\n\nWe see you were referred by a verified *${category}* artisan.\n\nTo finalize your request, please select your location:`, "Select Zone", zones);
    return true; 
  }

  // --- 2. ENTRY POINT / MAIN MENU ---
  if (profile.current_status === 'NEW' || profile.current_status === 'IDLE') {
    if (command === 'CMD_REQ_SERVICE' || command.includes('REQUEST')) {
      await supabase.from('profiles').update({ current_status: 'AWAITING_CATEGORY' }).eq('phone_number', from);
      await sendButtonMessage(from, '🛠️ What type of artisan do you need right now?', [
        { id: 'CAT_ELECTRICAL', title: 'Electrical' },
        { id: 'CAT_PLUMBING', title: 'Plumbing' },
        { id: 'CAT_CARPENTRY', title: 'Carpentry' }
      ]);
      return true; 
    }
    
    if (command === 'CMD_ENQUIRY' || command.includes('ENQUIRY')) {
      await supabase.from('profiles').update({ current_status: 'ENQUIRY_MODE' }).eq('phone_number', from);
      await sendMessage(from, 'Please type your enquiry below. A Nexa agent will review it shortly.');
      return true;
    }

    await sendButtonMessage(from, 'Welcome to *Nexa*! 🛠️\n\nHow can we help you today?', [
      { id: 'CMD_REQ_SERVICE', title: 'Request Service' },
      { id: 'CMD_ENQUIRY', title: 'Make Enquiry' }
    ]);
    return true; 
  }

  // --- 3. CATEGORY SELECTION ---
  if (profile.current_status === 'AWAITING_CATEGORY') {
    let category = '';
    if (command.includes('ELECTRICAL')) category = 'Electrical';
    else if (command.includes('PLUMBING')) category = 'Plumbing';
    else if (command.includes('CARPENTRY')) category = 'Carpentry';
    else {
      await sendMessage(from, '❌ Please select a valid category (e.g., Plumbing).');
      return true;
    }
    
    const { data: job, error } = await supabase.from('jobs').insert([{ client_phone: from, category: category, status: 'DRAFT' }]).select().single();
    if (error) throw error;

    await supabase.from('profiles').update({ current_status: 'AWAITING_ZONE' }).eq('phone_number', from);

    const zones = [
      { title: "Campus", rows: [{ id: "ZONE_GIDAN_KWANO", title: "Gidan Kwano" }, { id: "ZONE_BOSSO", title: "Bosso" }] },
      { title: "Town", rows: [{ id: "ZONE_MINNA_TOWN", title: "Minna Town" }] }
    ];

    await sendListMessage(from, `✅ *${category}* selected.\n\nWhere is the location?`, "Select Zone", zones);
    return true; 
  }

  // --- 4. ZONE SELECTION ---
  if (profile.current_status === 'AWAITING_ZONE') {
    const cleanCommand = command.replace(/_/g, ' ');

    let zone = '';
    if (cleanCommand.includes('GIDAN KWANO')) zone = 'Gidan Kwano';
    else if (cleanCommand.includes('BOSSO')) zone = 'Bosso';
    else if (cleanCommand.includes('MINNA TOWN') || cleanCommand.includes('MINNA')) zone = 'Minna Town';
    else {
      await sendMessage(from, '❌ Please select a valid zone from the list or type it (e.g., Bosso).');
      return true;
    }

    const { data: job } = await supabase.from('jobs').select('job_id').eq('client_phone', from).eq('status', 'DRAFT').order('created_at', { ascending: false }).limit(1).single();
    if (!job) return true;

    await supabase.from('jobs').update({ zone: zone }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'AWAITING_DESC' }).eq('phone_number', from);

    await sendMessage(from, `📍 Zone set to *${zone}*.\n\nFinally, briefly describe the issue (e.g., "Burst pipe in kitchen"):`);
    return true;
  }

  // --- 5. DESCRIPTION & MATCHMAKING ---
  if (profile.current_status === 'AWAITING_DESC') {
    if (isButton) return true; 

    const { data: job } = await supabase.from('jobs').select('job_id').eq('client_phone', from).eq('status', 'DRAFT').order('created_at', { ascending: false }).limit(1).single();
    if (!job) return true;
    
    await supabase.from('jobs').update({ problem_description: payload, status: 'SEARCHING_T1', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendMessage(from, '⚙️ *Request received!* We are currently matching you with the best verified artisans nearby. Please stay tuned for an update.');

    triggerMatchmaker(job.job_id);
    return true;
  }
  
  // --- 5.5 PROXY BOOKING CONFIRMATION ---
  if (command.includes('YES, FIND ARTISAN')) {
    const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'PENDING_CLIENT_CONFIRM').order('created_at', { ascending: false }).limit(1).single();
    if (!job) return true;

    await supabase.from('jobs').update({ status: 'SEARCHING_T1', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
    await sendMessage(from, '⚙️ *Confirmed!* We are now matching you with the best verified artisans nearby. Please stay tuned.');
    
    triggerMatchmaker(job.job_id);
    return true;
  }

  if (command.includes('CANCEL BOOKING')) {
    const { data: job } = await supabase.from('jobs').select('job_id').eq('client_phone', from).eq('status', 'PENDING_CLIENT_CONFIRM').order('created_at', { ascending: false }).limit(1).single();
    if (job) await supabase.from('jobs').update({ status: 'CANCELLED_BY_CLIENT' }).eq('job_id', job.job_id);
    await sendMessage(from, '🛑 Booking cancelled. No artisan will be dispatched. Tap "Menu" if you need anything else.');
    return true; 
  }

  // --- 5.6 CLIENT APPROVES OR REJECTS ARTISAN ---
  if (profile.current_status === 'APPROVING_ARTISAN') {
    if (command.includes('ACCEPT') || command.includes('YES')) {
      
      // 🚨 THE FIX: Added order() and limit(1) to prevent multi-row crashes from abandoned tests!
      const { data: job } = await supabase.from('jobs')
        .select('job_id, assigned_artisan, zone, problem_description, client_phone')
        .eq('client_phone', from)
        .eq('status', 'CLIENT_REVIEW')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
        
      if (!job) return true;

      const jobId = job.job_id;
      await supabase.from('jobs').update({ status: 'PENDING_ON_SITE', updated_at: new Date().toISOString() }).eq('job_id', jobId);
      await supabase.from('profiles').update({ current_status: 'TRACKING_ARTISAN' }).eq('phone_number', from);

      await sendMessage(from, `✅ *Artisan Confirmed!*\n\nThey are being dispatched now. Please keep your line open.`);

      await supabase.from('profiles').update({ current_status: 'ACTIVE_JOB' }).eq('phone_number', job.assigned_artisan);
      await sendButtonMessage(
        job.assigned_artisan,
        `✅ *Client Approved!*\n\n*Client:* +${job.client_phone}\n*Zone:* ${job.zone}\n*Issue:* ${job.problem_description}\n\n📞 Call the client immediately to coordinate. Tap below when you arrive:`,
        [{ id: `ARRIVED_${jobId}`, title: '📍 I Have Arrived' }]
      );
      return true;
    }

    if (command.includes('REJECT') || command.includes('NO') || command.includes('SOMEONE ELSE')) {
      
      // 🚨 THE FIX: Same safety net added here
      const { data: job } = await supabase.from('jobs')
        .select('job_id, assigned_artisan')
        .eq('client_phone', from)
        .eq('status', 'CLIENT_REVIEW')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
        
      if (!job) return true;

      const jobId = job.job_id;
      if (job.assigned_artisan) {
        await supabase.from('artisan_meta').update({ is_available: true }).eq('phone_number', job.assigned_artisan);
        await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.assigned_artisan);
        await sendMessage(job.assigned_artisan, '❌ The client opted to find someone else. You are back in the active pool.');
      }

      await supabase.from('jobs').update({ assigned_artisan: null, status: 'SEARCHING_T1', updated_at: new Date().toISOString() }).eq('job_id', jobId);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
      await sendMessage(from, '⚙️ Understood. Restarting the search for a new artisan...');

      triggerMatchmaker(jobId);
      return true;
    }
    
    return true; 
  }

  // --- 6 & 7. PRICE VERIFICATION & DISPUTE ---
  if (profile.current_status === 'VERIFYING_PRICE') {
    if (command.includes('YES') || command.includes('CORRECT') || command.includes('ACCEPT')) {
      const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'VERIFYING_PRICE').order('updated_at', { ascending: false }).limit(1).single();
      if (!job) return true;

      const jobId = job.job_id;
      const commission = job.quoted_price * 0.15; 

      await supabase.from('ledger').insert([{ job_id: jobId, artisan_phone: job.assigned_artisan, total_job_value: job.quoted_price, commission_owed: commission }]);
      await supabase.from('jobs').update({ status: 'COMPLETED' }).eq('job_id', jobId);
      await supabase.from('artisan_meta').update({ is_available: true }).eq('phone_number', job.assigned_artisan);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.assigned_artisan);

      await supabase.from('profiles').update({ current_status: 'AWAITING_RATING' }).eq('phone_number', from);
      
      await sendMessage(job.assigned_artisan, `✅ *Payment Verified!*\nCommission of ₦${commission.toFixed(2)} logged. You are now available for new jobs.`);

      const ratingRows = [1, 2, 3, 4, 5].map(s => ({ id: `RATE_${jobId}_${s}`, title: `${"⭐".repeat(s)}`, description: `Rate ${s} Stars` }));
      await sendListMessage(from, "✅ *Job Completed!*\n\nPlease rate the service provided:", "Rate Artisan", [{ title: "Rating", rows: ratingRows }]);
      return true; 
    }

    if (command.includes('DISPUTE') || command.includes('NO') || command.includes('WRONG')) {
      const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'VERIFYING_PRICE').order('updated_at', { ascending: false }).limit(1).single();
      if (!job) return true;

      const jobId = job.job_id;
      await supabase.from('jobs').update({ status: 'DISPUTED' }).eq('job_id', jobId);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);

      await sendMessage(from, `⚠️ Dispute logged. An agent will contact you shortly.`);
      await sendMessage(CUSTOMER_SERVICE_NUMBER, `🚨 *DISPUTE* | Job #${jobId.slice(0,8)} | Client: +${from} | Amount: ₦${job.quoted_price}`);
      return true;
    }

    return true; 
  }

  // --- 8. RATING SUBMISSION ---
  if (profile.current_status === 'AWAITING_RATING') {
    let score = 0;
    if (command.startsWith('RATE_')) {
        score = parseInt(command.split('_')[2]);
    } else if (command.includes('5')) score = 5;
    else if (command.includes('4')) score = 4;
    else if (command.includes('3')) score = 3;
    else if (command.includes('2')) score = 2;
    else if (command.includes('1')) score = 1;
    else {
      await sendMessage(from, 'Please select a rating from 1 to 5.');
      return true;
    }
    
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendButtonMessage(from, `🌟 Thanks! You rated this service ${score} stars.`, [{ id: 'CMD_REQ_SERVICE', title: 'New Request' }]);
    return true; 
  }

  return false;
}

module.exports = { handleClientFlow };
