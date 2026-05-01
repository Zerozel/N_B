const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage, sendListMessage } = require('../utils/whatsapp');
const { triggerMatchmaker } = require('../utils/matchmaker');

const CUSTOMER_SERVICE_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171'; 

async function handleAgentFlow(profile, payload, isButton) {
  const from = profile.phone_number;
  const command = typeof payload === 'string' ? payload.trim().toUpperCase() : '';

  // --- 1. PROXY INITIATION ---
  if (command === 'NEXA' || command.includes('PROXY_BOOK') || command === 'CMD_PROXY_BOOK') {
    await supabase.from('profiles').update({ current_status: 'PROXY_PHONE' }).eq('phone_number', from);
    await sendMessage(from, '📱 *Agent Proxy Initiated*\n\nPlease reply with the WhatsApp number of the client you are booking for (e.g., 08012345678):');
    return true; 
  }

  // --- 2. CAPTURE CLIENT PHONE & SHOW CATEGORIES ---
  if (profile.current_status === 'PROXY_PHONE') {
    if (isButton) return true;

    // 🚨 FIX: Auto-Format Phone Numbers to ensure API delivery (080 -> 23480)
    let targetPhone = payload.replace(/\D/g, '');
    if (targetPhone.startsWith('0')) {
      targetPhone = '234' + targetPhone.slice(1);
    }

    if (targetPhone.length < 12) {
      await sendMessage(from, '❌ Invalid format. Please enter a valid WhatsApp number (e.g., 080...).');
      return true; 
    }

    await supabase.from('profiles').upsert({ phone_number: targetPhone, user_type: 'CLIENT' }, { onConflict: 'phone_number', ignoreDuplicates: true });

    const { data: job, error } = await supabase.from('jobs').insert([{
      client_phone: targetPhone,
      status: 'PROXY_DRAFT',
      referred_artisan: from 
    }]).select().single();

    if (error) throw error;
    
    await supabase.from('profiles').update({ current_status: 'PROXY_CATEGORY' }).eq('phone_number', from);
    await sendButtonMessage(from, `✅ *Target Client:* +${targetPhone}\n\nWhat service does this client require?`, [
        { id: `AG_CAT_ELECTRICAL`, title: 'Electrical' },
        { id: `AG_CAT_PLUMBING`, title: 'Plumbing' },
        { id: `AG_CAT_CARPENTRY`, title: 'Carpentry' }
    ]);
    return true; 
  }

  // --- 3. SHOW ZONES ---
  if (profile.current_status === 'PROXY_CATEGORY') {
    let category = '';
    if (command.includes('ELECTRICAL')) category = 'Electrical';
    else if (command.includes('PLUMBING')) category = 'Plumbing';
    else if (command.includes('CARPENTRY')) category = 'Carpentry';
    else {
      await sendMessage(from, '❌ Please select a valid category (e.g., Plumbing).');
      return true;
    }

    const { data: job } = await supabase.from('jobs').select('job_id').eq('status', 'PROXY_DRAFT').eq('referred_artisan', from).order('created_at', { ascending: false }).limit(1).single();
    if (!job) return true;

    await supabase.from('jobs').update({ category: category }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'PROXY_ZONE' }).eq('phone_number', from);

    const zones = [{ title: "Operational Zones", rows: [{ id: `AG_ZONE_GIDAN_KWANO`, title: "Gidan Kwano" }, { id: `AG_ZONE_BOSSO`, title: "Bosso" }, { id: `AG_ZONE_MINNA_TOWN`, title: "Minna Town" }] }];
    await sendListMessage(from, `✅ *${category}* selected.\n\nSelect the client's location zone:`, "Select Zone", zones);
    return true; 
  }

  // --- 4. CAPTURE ZONE & ASK FOR DESCRIPTION ---
  if (profile.current_status === 'PROXY_ZONE') {
    let zone = '';
    if (command.includes('GIDAN KWANO')) zone = 'Gidan Kwano';
    else if (command.includes('BOSSO')) zone = 'Bosso';
    else if (command.includes('MINNA TOWN') || command.includes('MINNA')) zone = 'Minna Town';
    else {
      await sendMessage(from, '❌ Please select a valid zone (e.g., Bosso).');
      return true;
    }

    const { data: job } = await supabase.from('jobs').select('job_id').eq('status', 'PROXY_DRAFT').eq('referred_artisan', from).order('created_at', { ascending: false }).limit(1).single();
    if (!job) return true;

    await supabase.from('jobs').update({ zone: zone }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'PROXY_DESC' }).eq('phone_number', from);

    await sendMessage(from, `📍 *Zone:* ${zone}.\n\nBriefly describe the exact complaint (e.g., "Main switch tripping"):`);
    return true; 
  }

 // --- 5. FINALIZE & AUTO-START WATERFALL ---
  if (profile.current_status === 'PROXY_DESC') {
    if (isButton) return true;

    const { data: job } = await supabase.from('jobs').select('*').eq('status', 'PROXY_DRAFT').eq('referred_artisan', from).order('created_at', { ascending: false }).limit(1).single();
    if (!job) return true;

    const description = `${payload} (Proxy via Agent +${from})`;

    await supabase.from('jobs').update({ problem_description: description, status: 'SEARCHING_T1', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    
    await sendMessage(from, `✅ *Proxy Booking Confirmed!*\n\nTarget Client: +${job.client_phone}\nThe Matchmaker has been triggered and is finding an artisan now.`);
    
    await sendMessage(job.client_phone, `👋 *Hello from Nexa!*\n\nAn agent has just booked a *${job.category}* service on your behalf for an issue in *${job.zone}*.\n\n⚙️ We are currently matching you with a verified artisan. Please keep this chat open for updates!`);

    triggerMatchmaker(job.job_id);
    return true; 
  }

  // ==========================================
  // 🚨 PROXY LIFECYCLE (Agent Controls Job)
  // ==========================================

  // --- 6. AGENT APPROVES ARTISAN ---
  if (profile.current_status === 'APPROVING_ARTISAN') {
    if (command.includes('ACCEPT') || command.includes('YES')) {
      const { data: job } = await supabase.from('jobs').select('*').eq('referred_artisan', from).eq('status', 'CLIENT_REVIEW').single();
      if (!job) return true;

      await supabase.from('jobs').update({ status: 'PENDING_ON_SITE', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
      await supabase.from('profiles').update({ current_status: 'TRACKING_ARTISAN' }).eq('phone_number', from);

      await sendMessage(from, `✅ *Artisan Confirmed for Target Client!*\n\nThey are being dispatched now.`);
      await sendMessage(job.client_phone, `✅ Your agent has confirmed the artisan. They are currently being dispatched to your location!`);

      await supabase.from('profiles').update({ current_status: 'ACTIVE_JOB' }).eq('phone_number', job.assigned_artisan);
      await sendButtonMessage(job.assigned_artisan, `✅ *Agent Approved!*\n\n*Agent:* +${from}\n*Client:* +${job.client_phone}\n*Zone:* ${job.zone}\n*Issue:* ${job.problem_description}\n\n📞 Call the agent or client to coordinate. Tap below when you arrive:`, [{ id: `ARRIVED_${job.job_id}`, title: '📍 I Have Arrived' }]);
      return true;
    }

    if (command.includes('REJECT') || command.includes('NO') || command.includes('SOMEONE ELSE')) {
      const { data: job } = await supabase.from('jobs').select('*').eq('referred_artisan', from).eq('status', 'CLIENT_REVIEW').single();
      if (!job) return true;

      if (job.assigned_artisan) {
        await supabase.from('artisan_meta').update({ is_available: true }).eq('phone_number', job.assigned_artisan);
        await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.assigned_artisan);
        await sendMessage(job.assigned_artisan, '❌ The agent opted to find someone else. You are back in the active pool.');
      }

      await supabase.from('jobs').update({ assigned_artisan: null, status: 'SEARCHING_T1', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
      await sendMessage(from, '⚙️ Understood. Restarting the search for a new artisan...');

      triggerMatchmaker(job.job_id);
      return true;
    }
    return true; // Keep locked
  }

  // --- 7. AGENT VERIFIES PRICE ---
  if (profile.current_status === 'VERIFYING_PRICE') {
    if (command.includes('YES') || command.includes('CORRECT') || command.includes('ACCEPT')) {
      const { data: job } = await supabase.from('jobs').select('*').eq('referred_artisan', from).eq('status', 'VERIFYING_PRICE').order('updated_at', { ascending: false }).limit(1).single();
      if (!job) return true;

      const commission = job.quoted_price * 0.15; 
      await supabase.from('ledger').insert([{ job_id: job.job_id, artisan_phone: job.assigned_artisan, total_job_value: job.quoted_price, commission_owed: commission }]);
      await supabase.from('jobs').update({ status: 'COMPLETED' }).eq('job_id', job.job_id);
      
      await supabase.from('artisan_meta').update({ is_available: true }).eq('phone_number', job.assigned_artisan);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.assigned_artisan);
      await supabase.from('profiles').update({ current_status: 'AWAITING_RATING' }).eq('phone_number', from);
      
      await sendMessage(job.assigned_artisan, `✅ *Payment Verified!*\nCommission of ₦${commission.toFixed(2)} logged. You are now available for new jobs.`);
      await sendMessage(job.client_phone, `✅ Your agent has verified the final payment of ₦${job.quoted_price.toLocaleString()}. The job is now complete. Thank you for using Nexa!`);

      const ratingRows = [1, 2, 3, 4, 5].map(s => ({ id: `RATE_${job.job_id}_${s}`, title: `${"⭐".repeat(s)}`, description: `Rate ${s} Stars` }));
      await sendListMessage(from, "✅ *Job Completed!*\n\nPlease rate the service provided on behalf of the client:", "Rate Artisan", [{ title: "Rating", rows: ratingRows }]);
      return true; 
    }

    if (command.includes('DISPUTE') || command.includes('NO') || command.includes('WRONG')) {
      const { data: job } = await supabase.from('jobs').select('*').eq('referred_artisan', from).eq('status', 'VERIFYING_PRICE').order('updated_at', { ascending: false }).limit(1).single();
      if (!job) return true;

      await supabase.from('jobs').update({ status: 'DISPUTED' }).eq('job_id', job.job_id);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);

      await sendMessage(from, `⚠️ Dispute logged. An admin will contact you shortly.`);
      await sendMessage(job.client_phone, `⚠️ Your agent has disputed the final price. A Nexa admin is reviewing the case.`);
      await sendMessage(CUSTOMER_SERVICE_NUMBER, `🚨 *DISPUTE (PROXY)* | Client: +${job.client_phone} | Agent: +${from} | Amount: ₦${job.quoted_price}`);
      return true;
    }
    return true; 
  }

  // --- 8. AGENT SUBMITS RATING ---
  if (profile.current_status === 'AWAITING_RATING') {
    let score = 0;
    if (command.startsWith('RATE_')) score = parseInt(command.split('_')[2]);
    else if (command.includes('5')) score = 5;
    else if (command.includes('4')) score = 4;
    else if (command.includes('3')) score = 3;
    else if (command.includes('2')) score = 2;
    else if (command.includes('1')) score = 1;
    else {
      await sendMessage(from, 'Please select a rating from 1 to 5.');
      return true;
    }
    
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendButtonMessage(from, `🌟 Thanks! You rated this service ${score} stars.`, [{ id: 'CMD_PROXY_BOOK', title: 'New Proxy Booking' }]);
    return true; 
  }

  return false;
}

module.exports = { handleAgentFlow };
