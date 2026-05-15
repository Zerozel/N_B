// flows/clientFlow.js
const supabase = require('../config/supabase');
const { triggerMatchmaker } = require('../utils/matchmaker');
const { sendMessage, sendButtonMessage, sendListMessage } = require('../utils/whatsapp');
const { incrementArtisanJobCount, applyRatingToArtisan } = require('../utils/jobUtils');

const CS_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171';

async function handleClientFlow(profile, payload, isButton, referredBy) {
  const from = profile.phone_number;
  const command = typeof payload === 'string' ? payload.toUpperCase() : '';

  // --- 1. ENQUIRY MODE ---
  if (profile.current_status === 'ENQUIRY_MODE') {
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendMessage(CS_NUMBER, `🚨 *NEW NEXA ENQUIRY*\n*From:* +${from}\n*Message:* "${payload}"`);
    await sendMessage(from, '✅ *Enquiry received!*\n\nA human agent will review this shortly. For immediate help: +${CS_NUMBER}');
    return true;
  }

  // --- 1.5. DEEP-LINK FAST-TRACK (Ref: NX-...) ---
  if (referredBy && (profile.current_status === 'NEW' || profile.current_status === 'IDLE')) {
    const catMatch = payload.match(/need a (\w+) service/i);
    const category = catMatch
      ? catMatch[1].charAt(0).toUpperCase() + catMatch[1].slice(1).toLowerCase()
      : 'Unknown';

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
      { title: "Town",   rows: [{ id: "ZONE_MINNA_TOWN",  title: "Minna Town"  }] }
    ];
    await sendListMessage(from,
      `👋 *Welcome to Nexa!*\n\nYou were referred by a verified *${category}* artisan.\n\nSelect your location to continue:`,
      'Select Zone', zones
    );
    return true;
  }

  // --- 2. ENTRY POINT / MAIN MENU ---
  if (profile.current_status === 'NEW' || profile.current_status === 'IDLE') {
    if (command === 'CMD_REQ_SERVICE' || command.includes('REQUEST')) {
      await supabase.from('profiles').update({ current_status: 'AWAITING_CATEGORY' }).eq('phone_number', from);
      await sendButtonMessage(from, '🛠️ What type of artisan do you need right now?', [
        { id: 'CAT_ELECTRICAL', title: 'Electrical' },
        { id: 'CAT_PLUMBING',   title: 'Plumbing'   },
        { id: 'CAT_CARPENTRY',  title: 'Carpentry'  }
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
      { id: 'CMD_ENQUIRY',     title: 'Make Enquiry'    }
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
      await sendMessage(from, '❌ Please select a category using the buttons.');
      return true;
    }

    const { data: job, error } = await supabase.from('jobs').insert([{
      client_phone: from,
      category: category,
      status: 'DRAFT'
    }]).select().single();
    if (error) throw error;

    await supabase.from('profiles').update({ current_status: 'AWAITING_ZONE' }).eq('phone_number', from);

    const zones = [
      { title: "Campus", rows: [{ id: "ZONE_GIDAN_KWANO", title: "Gidan Kwano" }, { id: "ZONE_BOSSO", title: "Bosso" }] },
      { title: "Town",   rows: [{ id: "ZONE_MINNA_TOWN",  title: "Minna Town"  }] }
    ];
    await sendListMessage(from, `✅ *${category}* selected.\n\nWhere is the location?`, 'Select Zone', zones);
    return true;
  }

  // --- 4. ZONE SELECTION ---
  if (profile.current_status === 'AWAITING_ZONE') {
    const cleanCommand = command.replace(/_/g, ' ');
    let zone = '';
    if (cleanCommand.includes('GIDAN KWANO')) zone = 'Gidan Kwano';
    else if (cleanCommand.includes('BOSSO'))  zone = 'Bosso';
    else if (cleanCommand.includes('MINNA'))  zone = 'Minna Town';
    else {
      await sendMessage(from, '❌ Please select a zone from the list.');
      return true;
    }

    const { data: job } = await supabase.from('jobs')
      .select('job_id')
      .eq('client_phone', from)
      .eq('status', 'DRAFT')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (!job) return true;

    await supabase.from('jobs').update({ zone: zone }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'AWAITING_DESC' }).eq('phone_number', from);
    await sendMessage(from, `📍 Zone set to *${zone}*.\n\nBriefly describe the issue (e.g., "Burst pipe in kitchen"):`);
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
      problem_description: payload,
      status: 'SEARCHING_T1',
      updated_at: new Date().toISOString()
    }).eq('job_id', job.job_id);

    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendMessage(from, '⚙️ *Request received!* We are matching you with verified artisans nearby. Stay tuned!');

    triggerMatchmaker(job.job_id);
    return true;
  }

  // --- 5.5. PROXY BOOKING CONFIRMATION (Client confirms agent-created booking) ---
  if (command.includes('YES, FIND ARTISAN')) {
    const { data: job } = await supabase.from('jobs')
      .select('*')
      .eq('client_phone', from)
      .eq('status', 'PENDING_CLIENT_CONFIRM')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (!job) return true;

    await supabase.from('jobs').update({ status: 'SEARCHING_T1', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
    await sendMessage(from, '⚙️ *Confirmed!* Matching you with the best artisans nearby...');
    triggerMatchmaker(job.job_id);
    return true;
  }

  if (command.includes('CANCEL BOOKING')) {
    const { data: job } = await supabase.from('jobs')
      .select('job_id')
      .eq('client_phone', from)
      .eq('status', 'PENDING_CLIENT_CONFIRM')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (job) await supabase.from('jobs').update({ status: 'CANCELLED_BY_CLIENT' }).eq('job_id', job.job_id);
    await sendMessage(from, '🛑 Booking cancelled. Tap "Menu" if you need anything else.');
    return true;
  }

  // --- 6. CLIENT APPROVES / REJECTS ARTISAN ---
  if (profile.current_status === 'APPROVING_ARTISAN') {
    if (command.includes('ACCEPT') || command.includes('YES')) {
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
        `✅ *Client Approved!*\n\n*Client:* +${job.client_phone}\n*Zone:* ${job.zone}\n*Issue:* ${job.problem_description}\n\n📞 Call the client to coordinate. Tap below when you arrive:`,
        [{ id: `ARRIVED_${jobId}`, title: '📍 I Have Arrived' }]
      );
      return true;
    }

    if (command.includes('REJECT') || command.includes('NO') || command.includes('SOMEONE ELSE')) {
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
      await sendMessage(from, '⚙️ Understood. Restarting the search...');

      triggerMatchmaker(jobId);
      return true;
    }

    return true; // Stay locked in APPROVING_ARTISAN
  }

  // --- 7. PRICE VERIFICATION ---
  if (profile.current_status === 'VERIFYING_PRICE') {
    if (command.includes('YES') || command.includes('CORRECT') || command.includes('ACCEPT')) {
      const { data: job } = await supabase.from('jobs').select('*').eq('client_phone', from).eq('status', 'VERIFYING_PRICE').order('updated_at', { ascending: false }).limit(1).single();
      if (!job) return true;

      const jobId = job.job_id;
      const commission = job.quoted_price * 0.15; 

      // 1. Log the commission in the ledger
      await supabase.from('ledger').insert([{ job_id: jobId, artisan_phone: job.assigned_artisan, total_job_value: job.quoted_price, commission_owed: commission }]);
      
      // 2. Complete the job, but DO NOT free the artisan yet
      await supabase.from('jobs').update({ status: 'COMPLETED' }).eq('job_id', jobId);
      
      // 3. Lock the Artisan into the payment phase
      await supabase.from('profiles').update({ current_status: 'AWAITING_COMMISSION_PAYMENT' }).eq('phone_number', job.assigned_artisan);
      
      // 4. Move Client to rating
      await supabase.from('profiles').update({ current_status: 'AWAITING_RATING' }).eq('phone_number', from);
      
      // 5. Send Bank Details to Artisan (UPDATE THESE DETAILS)
      const bankMessage = `✅ *Payment Verified by Client!*\n\nYour 15% commission owed to Nexa is: *₦${commission.toFixed(2)}*.\n\nTo unlock your account for new jobs, please transfer this amount to:\n🏦 *Bank:* Paystack-Titan\n👤 *Name:* Chippercash/Emiala Destinny\n🔢 *Acct:* 9713786473\n\nOnce you have transferred the money, reply to this chat with the exact word *"SENT"*.`;
      await sendMessage(job.assigned_artisan, bankMessage);

      const ratingRows = [1, 2, 3, 4, 5].map(s => ({ id: `RATE_${jobId}_${s}`, title: `${"⭐".repeat(s)}`, description: `Rate ${s} Stars` }));
      await sendListMessage(from, "✅ *Job Completed!*\n\nPlease rate the service provided:", "Rate Artisan", [{ title: "Rating", rows: ratingRows }]);
      return true; 
    }

    if (command.includes('DISPUTE') || command.includes('WRONG') || command.includes('NO')) {
      const { data: job } = await supabase.from('jobs')
        .select('*')
        .eq('client_phone', from)
        .eq('status', 'VERIFYING_PRICE')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
      if (!job) return true;

      await supabase.from('jobs').update({ status: 'DISPUTED' }).eq('job_id', job.job_id);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);

      await sendMessage(from, '⚠️ Dispute logged. An agent will contact you shortly.');
      await sendMessage(CS_NUMBER, `🚨 *DISPUTE* | Job #${job.job_id.slice(0, 8)} | Client: +${from} | Amount: ₦${job.quoted_price}`);
      return true;
    }

    return true; // Stay locked
  }

  // --- 8. RATING SUBMISSION ---
  if (profile.current_status === 'AWAITING_RATING') {
    let score = 0;

    if (command.startsWith('RATE_')) {
      // BUG FIX #9: Use .pop() instead of [2] — safe regardless of UUID format
      const parts = command.split('_');
      score = parseInt(parts[parts.length - 1]);
    } else if (command.includes('5')) score = 5;
    else if (command.includes('4')) score = 4;
    else if (command.includes('3')) score = 3;
    else if (command.includes('2')) score = 2;
    else if (command.includes('1')) score = 1;
    else {
      await sendMessage(from, 'Please select a rating from 1 to 5 stars.');
      return true;
    }

    if (score < 1 || score > 5 || isNaN(score)) score = 5; // Default to 5 if parse fails

    // Extract jobId from the RATE_ command and update trust score
    if (command.startsWith('RATE_')) {
      const parts = command.split('_');
      // Format: RATE_{UUID_WITH_DASHES}_{SCORE} — UUID has 4 dash-groups
      // We take everything between RATE_ and the last underscore as the job id
      const jobId = parts.slice(1, parts.length - 1).join('-').toLowerCase();
      if (jobId) await applyRatingToArtisan(jobId, score);
    }

    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendButtonMessage(from, `🌟 Thanks! You rated this service *${score} star${score !== 1 ? 's' : ''}*.`, [
      { id: 'CMD_REQ_SERVICE', title: 'New Request' }
    ]);
    return true;
  }

  return false;
}

module.exports = { handleClientFlow };
