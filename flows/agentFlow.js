// flows/agentFlow.js
const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage, sendListMessage } = require('../utils/whatsapp');
const { triggerMatchmaker } = require('../utils/matchmaker');
const { incrementArtisanJobCount, applyRatingToArtisan } = require('../utils/jobUtils');

const CS_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171';

async function handleAgentFlow(profile, payload, isButton) {
  const from = profile.phone_number;
  const command = typeof payload === 'string' ? payload.trim().toUpperCase() : '';

  // --- 1. PROXY INITIATION ---
  if (command === 'NEXA' || command.includes('PROXY_BOOK') || command === 'CMD_PROXY_BOOK') {
    await supabase.from('profiles').update({ current_status: 'PROXY_PHONE' }).eq('phone_number', from);
    await sendMessage(from, '📱 *Agent Proxy Initiated*\n\nReply with the client\'s WhatsApp number (e.g., 08012345678):');
    return true;
  }

  // --- 2. CAPTURE CLIENT PHONE ---
  if (profile.current_status === 'PROXY_PHONE') {
    if (isButton) return true;

    let targetPhone = payload.replace(/\D/g, '');
    if (targetPhone.startsWith('0')) targetPhone = '234' + targetPhone.slice(1);

    if (targetPhone.length < 12) {
      await sendMessage(from, '❌ Invalid format. Use 23480... or 080...');
      return true;
    }

    const { data: job, error } = await supabase.from('jobs').insert([{
      client_phone: targetPhone,
      status: 'PROXY_DRAFT',
      referred_artisan: from // 🚨 THE BROKER TAG
    }]).select().single();

    if (error) throw error;

    await supabase.from('profiles').update({ current_status: 'PROXY_CATEGORY' }).eq('phone_number', from);
    await sendButtonMessage(from, '🛠️ Select the required service for this client:', [
      { id: 'AG_CAT_ELEC', title: 'Electrical' },
      { id: 'AG_CAT_PLUM', title: 'Plumbing' },
      { id: 'AG_CAT_CARP', title: 'Carpentry' }
    ]);
    return true;
  }

  // --- 3. CAPTURE CATEGORY ---
  if (profile.current_status === 'PROXY_CATEGORY') {
    let category = '';
    if (command.includes('ELEC')) category = 'Electrical';
    else if (command.includes('PLUM')) category = 'Plumbing';
    else if (command.includes('CARP')) category = 'Carpentry';
    else {
      await sendMessage(from, '❌ Please select a valid category.');
      return true;
    }

    const { data: job } = await supabase.from('jobs').select('job_id').eq('referred_artisan', from).eq('status', 'PROXY_DRAFT').order('created_at', { ascending: false }).limit(1).single();
    if (!job) return true;

    await supabase.from('jobs').update({ category: category }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'PROXY_ZONE' }).eq('phone_number', from);

    const zones = [
      { title: "Campus", rows: [{ id: "AG_ZONE_GIDAN_KWANO", title: "Gidan Kwano" }, { id: "AG_ZONE_BOSSO", title: "Bosso" }] },
      { title: "Town", rows: [{ id: "AG_ZONE_MINNA", title: "Minna Town" }] }
    ];
    await sendListMessage(from, `✅ *${category}* selected.\n\nWhere is the client located?`, "Select Zone", zones);
    return true;
  }

  // --- 4. CAPTURE ZONE ---
  if (profile.current_status === 'PROXY_ZONE') {
    const cleanCommand = command.replace(/_/g, ' ');
    let zone = '';
    if (cleanCommand.includes('GIDAN KWANO')) zone = 'Gidan Kwano';
    else if (cleanCommand.includes('BOSSO')) zone = 'Bosso';
    else if (cleanCommand.includes('MINNA')) zone = 'Minna Town';
    else {
      await sendMessage(from, '❌ Please select a valid zone.');
      return true;
    }

    const { data: job } = await supabase.from('jobs').select('job_id').eq('referred_artisan', from).eq('status', 'PROXY_DRAFT').order('created_at', { ascending: false }).limit(1).single();
    if (!job) return true;

    await supabase.from('jobs').update({ zone: zone }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'PROXY_DESC' }).eq('phone_number', from);

    await sendMessage(from, `📍 Zone set to *${zone}*.\n\nFinally, briefly describe the client's issue:`);
    return true;
  }

  // --- 5. CAPTURE DESCRIPTION & LAUNCH ---
  if (profile.current_status === 'PROXY_DESC') {
    if (isButton) return true;

    const { data: job } = await supabase.from('jobs').select('*').eq('referred_artisan', from).eq('status', 'PROXY_DRAFT').order('created_at', { ascending: false }).limit(1).single();
    if (!job) return true;

    await supabase.from('jobs').update({ problem_description: payload, status: 'SEARCHING_T1', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
    
    // Set agent back to IDLE while matchmaker works
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendMessage(from, `⚙️ *Proxy Request Launched!*\n\nWe are matching the client with nearby verified artisans. You will be pinged when an artisan accepts.`);

    // Send silent update to actual client
    await sendMessage(job.client_phone,
      `👋 *Hello from Nexa!*\n\nAn agent has booked a *${job.category}* service on your behalf in *${job.zone}*.\n\n` +
      `⚙️ We are matching you with a verified artisan. Keep this chat open for updates!`
    );

    triggerMatchmaker(job.job_id);
    return true;
  }

  // --- 6. AGENT APPROVES/REJECTS ARTISAN ---
  if (profile.current_status === 'APPROVING_ARTISAN') {
    if (command.includes('ACCEPT') || command.includes('YES')) {
      const { data: job } = await supabase.from('jobs').select('*').eq('referred_artisan', from).eq('status', 'CLIENT_REVIEW').order('created_at', { ascending: false }).limit(1).single();
      if (!job) return true;

      await supabase.from('jobs').update({ status: 'PENDING_ON_SITE', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
      
      // Move Agent to tracking
      await supabase.from('profiles').update({ current_status: 'TRACKING_ARTISAN' }).eq('phone_number', from);
      await sendMessage(from, `✅ *Artisan Confirmed!*\n\nThey are being dispatched to the client now. You will be notified when they submit the price.`);

      // Notify actual client
      await sendMessage(job.client_phone, `🧑‍🔧 *Artisan Dispatched!*\nYour agent has confirmed the artisan. They are on their way to your location.`);

      // Notify Artisan
      await supabase.from('profiles').update({ current_status: 'ACTIVE_JOB' }).eq('phone_number', job.assigned_artisan);
      await sendButtonMessage(
        job.assigned_artisan,
        `✅ *Agent Approved!*\n\n*Client:* +${job.client_phone}\n*Zone:* ${job.zone}\n*Issue:* ${job.problem_description}\n\n📞 Call the client to coordinate. Tap below when you arrive:`,
        [{ id: `ARRIVED_${job.job_id}`, title: '📍 I Have Arrived' }]
      );
      return true;
    }

    if (command.includes('REJECT') || command.includes('NO') || command.includes('SOMEONE ELSE')) {
      const { data: job } = await supabase.from('jobs').select('job_id, assigned_artisan, client_phone').eq('referred_artisan', from).eq('status', 'CLIENT_REVIEW').order('created_at', { ascending: false }).limit(1).single();
      if (!job) return true;

      if (job.assigned_artisan) {
        await supabase.from('artisan_meta').update({ is_available: true }).eq('phone_number', job.assigned_artisan);
        await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.assigned_artisan);
        await sendMessage(job.assigned_artisan, '❌ The agent opted to find someone else. You are back in the pool.');
      }

      await supabase.from('jobs').update({ assigned_artisan: null, status: 'SEARCHING_T1', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
      await sendMessage(from, '⚙️ Understood. Restarting the search for a new artisan...');
      
      triggerMatchmaker(job.job_id);
      return true;
    }

    return true; // Stay locked
  }

  // --- 7. AGENT VERIFIES PRICE & TRIGGERS COMMISSION LOCK ---
  if (profile.current_status === 'VERIFYING_PRICE') {
    if (command.includes('YES') || command.includes('CORRECT') || command.includes('ACCEPT')) {
      const { data: job } = await supabase.from('jobs')
        .select('*')
        .eq('referred_artisan', from)
        .eq('status', 'VERIFYING_PRICE')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
      if (!job) return true;

      const commission = job.quoted_price * 0.15;

      // 1. Log the commission in the ledger
      await supabase.from('ledger').insert([{
        job_id: job.job_id,
        artisan_phone: job.assigned_artisan,
        total_job_value: job.quoted_price,
        commission_owed: commission
      }]);
      
      await supabase.from('jobs').update({ status: 'COMPLETED' }).eq('job_id', job.job_id);
      
      // 2. 🚨 LOCK THE ARTISAN FOR PAYMENT (Do not free them!)
      await supabase.from('profiles').update({ current_status: 'AWAITING_COMMISSION_PAYMENT' }).eq('phone_number', job.assigned_artisan);
      
      // 3. Move Agent to Rating
      await supabase.from('profiles').update({ current_status: 'AWAITING_RATING' }).eq('phone_number', from);

      // Increment artisan job count 
      await incrementArtisanJobCount(job.assigned_artisan);

      // 4. Send the Payment Demand to the Artisan
      const bankMessage = `✅ *Payment Verified by Agent!*\n\nYour 15% commission owed to Nexa is: *₦${commission.toFixed(2)}*.\n\nTo unlock your account for new jobs, please transfer this amount to:\n🏦 *Bank:* Paystack-Titan\n👤 *Name:* Chippercash/Emiala Destinny\n🔢 *Acct:* 9713786473\n\nOnce you have transferred the money, reply to this chat with the exact word *"SENT"*.`;
      await sendMessage(job.assigned_artisan, bankMessage);

      // Send silent update to the Client
      await sendMessage(job.client_phone, `✅ Your agent has verified payment of ₦${job.quoted_price.toLocaleString()}. The job is now complete. Thank you for using Nexa!`);

      const ratingRows = [1, 2, 3, 4, 5].map(s => ({
        id: `RATE_${job.job_id}_${s}`, title: `${'⭐'.repeat(s)}`, description: `Rate ${s} Stars`
      }));
      await sendListMessage(from, '✅ *Job Completed!*\n\nRate the service on behalf of the client:', 'Rate Artisan', [{ title: 'Rating', rows: ratingRows }]);
      return true;
    }

    if (command.includes('DISPUTE') || command.includes('WRONG') || command.includes('NO')) {
      const { data: job } = await supabase.from('jobs').select('*').eq('referred_artisan', from).eq('status', 'VERIFYING_PRICE').order('updated_at', { ascending: false }).limit(1).single();
      if (!job) return true;

      await supabase.from('jobs').update({ status: 'DISPUTED' }).eq('job_id', job.job_id);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);

      await sendMessage(from, '⚠️ Dispute logged. An admin will contact you shortly.');
      await sendMessage(job.client_phone, '⚠️ Your agent has disputed the final price. A Nexa admin is reviewing the case.');
      await sendMessage(CS_NUMBER, `🚨 *DISPUTE (PROXY)* | Client: +${job.client_phone} | Agent: +${from} | Amount: ₦${job.quoted_price}`);
      return true;
    }

    return true; // Stay locked
  }

  // --- 8. AGENT SUBMITS RATING ---
  if (profile.current_status === 'AWAITING_RATING') {
    let score = 0;
    if (command.startsWith('RATE_')) {
      const parts = command.split('_');
      score = parseInt(parts[parts.length - 1]);
    } else if (command.includes('5')) score = 5;
    else if (command.includes('4')) score = 4;
    else if (command.includes('3')) score = 3;
    else if (command.includes('2')) score = 2;
    else if (command.includes('1')) score = 1;
    else {
      await sendMessage(from, 'Please select a rating from 1 to 5.');
      return true;
    }

    if (score < 1 || score > 5 || isNaN(score)) score = 5;

    // Extract jobId from RATE_ command and update artisan trust score
    if (command.startsWith('RATE_')) {
      const parts = command.split('_');
      const jobId = parts.slice(1, parts.length - 1).join('-').toLowerCase();
      if (jobId) await applyRatingToArtisan(jobId, score);
    }

    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    await sendButtonMessage(from, `🌟 Thanks! You rated this service ${score} stars on behalf of the client.`, [{ id: 'CMD_PROXY_BOOK', title: 'New Proxy Booking' }]);
    return true;
  }

  return false;
}

module.exports = { handleAgentFlow };
