const supabase = require('../config/supabase');
const { triggerMatchmaker } = require('../utils/matchmaker');
const { sendMessage, sendButtonMessage, sendListMessage } = require('../utils/whatsapp');

// Admin alert number for enquiries and disputes
const CUSTOMER_SERVICE_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171'; 

/**
 * Handles all Client-side interactions including service requests and payment verification.
 */
async function handleClientFlow(profile, payload, isButton, referredBy) {
  const from = profile.phone_number;
  
  // 🚨 THE FIX: Normalize the payload to UPPERCASE so template buttons never fail on case-sensitivity
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
    if (command === 'CMD_REQ_SERVICE') {
      await supabase.from('profiles').update({ current_status: 'AWAITING_CATEGORY' }).eq('phone_number', from);
      await sendButtonMessage(
        from,
        '🛠️ What type of artisan do you need right now?',
        [
          { id: 'CAT_ELECTRICAL', title: 'Electrical' },
          { id: 'CAT_PLUMBING', title: 'Plumbing' },
          { id: 'CAT_CARPENTRY', title: 'Carpentry' }
        ]
      );
      return true; 
    }
    
    if (command === 'CMD_ENQUIRY') {
      await supabase.from('profiles').update({ current_status: 'ENQUIRY_MODE' }).eq('phone_number', from);
      await sendMessage(from, 'Please type your enquiry below. A Nexa agent will review it shortly.');
      return true;
    }

    await sendButtonMessage(
      from,
      'Welcome to *Nexa*! 🛠️\n\nHow can we help you today?',
      [
        { id: 'CMD_REQ_SERVICE', title: 'Request Service' },
        { id: 'CMD_ENQUIRY', title: 'Make Enquiry' }
      ]
    );
    return true; 
  }

  // --- 3. CATEGORY SELECTION ---
  if (profile.current_status === 'AWAITING_CATEGORY') {
    if (!isButton || !command.startsWith('CAT_')) {
      await sendMessage(from, '❌ Please use the buttons to select a category.');
      return true;
    }

    // Use the original payload to preserve title casing for the database
    const category = payload.split('_')[1].charAt(0) + payload.split('_')[1].slice(1).toLowerCase();
    
    const { data: job, error } = await supabase.from('jobs').insert([{
      client_phone: from,
      category: category,
      status: 'DRAFT'
    }]).select().single();

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
    if (!isButton || !command.startsWith('ZONE_')) return true;

    const { data: job } = await supabase.from('jobs')
      .select('job_id')
      .eq('client_phone', from)
      .eq('status', 'DRAFT')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!job) return true;

    // Use original payload to preserve spacing and casing
    const zone = payload.replace('ZONE_', '').replace('_', ' ');

    await supabase.from('jobs').update({ zone: zone }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'AWAITING_DESC' }).eq('phone_number', from);

    await sendMessage(from, `📍 Zone set to *${zone}*.\n\nFinally, briefly describe the issue (e.g., "Burst pipe in kitchen"):`);
    return true;
  }

  // --- 5. DESCRIPTION & MATCHMAKING ---
  if (profile.current_status === 'AWAITING_DESC') {
    if (isButton) return true;

    const { data: job } = await supabase.from('jobs')
      .select('job_id')
      .eq('client_phone', from)
      .eq('status', 'DRAFT')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!job) return true;
    
    await supabase.from('jobs').update({ 
      problem_description: payload, // Preserve original casing for description
      status: 'SEARCHING_T1',
      updated_at: new Date().toISOString()
    }).eq('job_id', job.job_id);

    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendMessage(from, '⚙️ *Request received!* We are currently matching you with the best verified artisans nearby. Please stay tuned for an update.');

    triggerMatchmaker(job.job_id);
    return true;
  }
  
  // --- 5.5 PROXY BOOKING CONFIRMATION ---
  // 🚨 THE FIX: Uppercase fuzzy matching for Meta Template buttons
  if (isButton && command.includes('YES, FIND ARTISAN')) {
    const { data: job } = await supabase.from('jobs')
      .select('*')
      .eq('client_phone', from)
      .eq('status', 'PENDING_CLIENT_CONFIRM')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (!job) return true;

    await supabase.from('jobs').update({ 
      status: 'SEARCHING_T1',
      updated_at: new Date().toISOString()
    }).eq('job_id', job.job_id);

    await sendMessage(from, '⚙️ *Confirmed!* We are now matching you with the best verified artisans nearby. Please stay tuned.');
    
    triggerMatchmaker(job.job_id);
    return true;
  }

  if (isButton && command.includes('CANCEL BOOKING')) {
    const { data: job } = await supabase.from('jobs')
      .select('job_id')
      .eq('client_phone', from)
      .eq('status', 'PENDING_CLIENT_CONFIRM')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
      
    if (job) {
      await supabase.from('jobs').update({ status: 'CANCELLED_BY_CLIENT' }).eq('job_id', job.job_id);
    }
    
    await sendMessage(from, '🛑 Booking cancelled. No artisan will be dispatched. Tap "Menu" if you need anything else.');
    return true; 
  }

  // --- 5.6 CLIENT APPROVES OR REJECTS ARTISAN ---
  if (profile.current_status === 'APPROVING_ARTISAN') {
    if (!isButton) return true;

    if (command.startsWith('CLIENT_ACCEPT_')) {
      const jobId = command.replace('CLIENT_ACCEPT_', '');
      
      const { data: job } = await supabase.from('jobs').select('assigned_artisan, zone, problem_description, client_phone').eq('job_id', jobId).single();

      if (!job) return true;

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

    if (command.startsWith('CLIENT_REJECT_')) {
      const jobId = command.replace('CLIENT_REJECT_', '');
      const { data: job } = await supabase.from('jobs').select('assigned_artisan').eq('job_id', jobId).single();

      if (job && job.assigned_artisan) {
        await supabase.from('artisan_meta').update({ is_available: true }).eq('phone_number', job.assigned_artisan);
        await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.assigned_artisan);
        await sendMessage(job.assigned_artisan, '❌ The client opted to find someone else. You are back in the active pool.');
      }

      await supabase.from('jobs').update({ 
        assigned_artisan: null, 
        status: 'SEARCHING_T1', 
        updated_at: new Date().toISOString() 
      }).eq('job_id', jobId);

      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
      await sendMessage(from, '⚙️ Understood. Restarting the search for a new artisan...');

      triggerMatchmaker(jobId);
      return true;
    }
  }

  // --- 6. ANTI-LEAKAGE: PRICE VERIFICATION ---
  // 🚨 THE FIX: Synchronized with State Machine and Uppercase fuzzy matching
  if (profile.current_status === 'VERIFYING_PRICE' && isButton && command.includes('YES, CORRECT')) {
    const { data: job } = await supabase.from('jobs')
      .select('*')
      .eq('client_phone', from)
      .eq('status', 'VERIFYING_PRICE')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    
    if (!job) return true;

    const jobId = job.job_id;
    const commission = job.quoted_price * 0.15; 

    await supabase.from('ledger').insert([{
      job_id: jobId,
      artisan_phone: job.assigned_artisan,
      total_job_value: job.quoted_price,
      commission_owed: commission
    }]);

    await supabase.from('jobs').update({ status: 'COMPLETED' }).eq('job_id', jobId);
    await supabase.from('artisan_meta').update({ is_available: true }).eq('phone_number', job.assigned_artisan);
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.assigned_artisan);

    await supabase.from('profiles').update({ current_status: 'AWAITING_RATING' }).eq('phone_number', from);
    
    await sendMessage(job.assigned_artisan, `✅ *Payment Verified!*\nCommission of ₦${commission.toFixed(2)} logged. You are now available for new jobs.`);

    const ratingRows = [1, 2, 3, 4, 5].map(s => ({ id: `RATE_${jobId}_${s}`, title: `${"⭐".repeat(s)}`, description: `Rate ${s} Stars` }));
    await sendListMessage(from, "✅ *Job Completed!*\n\nPlease rate the service provided:", "Rate Artisan", [{ title: "Rating", rows: ratingRows }]);
    return true; 
  }

  // --- 7. PRICE DISPUTE ---
  // 🚨 THE FIX: Synchronized with State Machine and Uppercase fuzzy matching
  if (profile.current_status === 'VERIFYING_PRICE' && isButton && command.includes('DISPUTED')) {
    const { data: job } = await supabase.from('jobs')
      .select('*')
      .eq('client_phone', from)
      .eq('status', 'VERIFYING_PRICE')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (!job) return true;

    const jobId = job.job_id;

    await supabase.from('jobs').update({ status: 'DISPUTED' }).eq('job_id', jobId);
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);

    await sendMessage(from, `⚠️ Dispute logged. An agent will contact you shortly.`);
    await sendMessage(CUSTOMER_SERVICE_NUMBER, `🚨 *DISPUTE* | Job #${jobId.slice(0,8)} | Client: +${from} | Amount: ₦${job.quoted_price}`);
    return true;
  }

  // --- 8. RATING SUBMISSION ---
  if (profile.current_status === 'AWAITING_RATING' && isButton && command.startsWith('RATE_')) {
    const [, jobId, score] = command.split('_');
    
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    
    await sendButtonMessage(
      from, 
      `🌟 Thanks! You rated this service ${score} stars.`,
      [{ id: 'CMD_REQ_SERVICE', title: 'New Request' }]
    );
    return true; 
  }

  return false;
}

module.exports = { handleClientFlow };
