// flows/artisanFlow.js
const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage, sendTemplateMessage, sendListMessage } = require('../utils/whatsapp');

const CS_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171'

async function handleArtisanFlow(profile, payload, isButton) {
  const from = profile.phone_number;
  const command = typeof payload === 'string' ? payload.toUpperCase() : '';

  // --- 1. JOB ACCEPTANCE ---
  if (command.includes('ACCEPT') || command.includes('✅') || command === 'YES') {

    // Double-booking guard — artisan must be free before claiming a new job
    const busyStatuses = ['WAITING_APPROVAL', 'ACTIVE_JOB', 'AWAITING_PRICE', 'WAITING_VERIFICATION'];
    if (busyStatuses.includes(profile.current_status)) {
      await sendMessage(from, '⚠️ You already have an active job in progress. Please complete it before accepting a new one.');
      return true;
    }

    // Fetch artisan's registered trade and zone
    const { data: artisan } = await supabase
      .from('artisan_meta')
      .select('*')
      .eq('phone_number', from)
      .single();

    if (!artisan) {
      await sendMessage(from, '⚠️ Error: Could not find your verified trade profile. Please contact support.');
      return true;
    }

    // BUG FIX #4: Added .ilike('zone', ...) so an artisan only claims jobs in their zone
    const { data: job } = await supabase
      .from('jobs')
      .select('*')
      .ilike('status', 'SEARCHING_%')
      .ilike('category', `%${artisan.category.trim()}%`)
      .ilike('zone', `%${artisan.zone.trim()}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!job) {
      await sendMessage(from, '🔒 Sorry, this job has already been claimed or no jobs are available in your zone right now.');
      return true;
    }

    const jobId = job.job_id;

    // Atomically lock the job to this artisan
    await supabase.from('jobs').update({
      assigned_artisan: from,
      status: 'CLIENT_REVIEW',
      updated_at: new Date().toISOString()
    }).eq('job_id', jobId);

    await supabase.from('profiles').update({ current_status: 'WAITING_APPROVAL' }).eq('phone_number', from);
    await supabase.from('artisan_meta').update({ is_available: false }).eq('phone_number', from);

    await sendMessage(from, '⏳ *Match Request Sent!*\n\nYour profile has been sent for client approval. Please wait...');

    // Proxy check: if referred_artisan is a phone number (not NX-...), route to agent
    const isProxy = job.referred_artisan && !job.referred_artisan.startsWith('NX-');
    const approvalPhone = isProxy ? job.referred_artisan : job.client_phone;

    await supabase.from('profiles').update({ current_status: 'APPROVING_ARTISAN' }).eq('phone_number', approvalPhone);

    await sendButtonMessage(
      approvalPhone,
      `🔔 *Artisan Found${isProxy ? ' (Proxy Booking)' : ''}!*\n\n` +
      `🧑‍🔧 *Name:* ${profile.full_name || 'Verified Pro'}\n` +
      `⭐ *Rating:* ${artisan.trust_score}/5.0\n` +
      `📍 *Zone:* ${artisan.zone}\n\n` +
      `Would you like to accept this artisan?`,
      [
        { id: `CLIENT_ACCEPT_${jobId}`, title: '✅ Accept Artisan' },
        { id: `CLIENT_REJECT_${jobId}`, title: '❌ Find Someone Else' }
      ]
    );

    if (isProxy) {
      await sendMessage(job.client_phone, `⚙️ We found an artisan for your request! Your agent is reviewing their profile now.`);
    }
    return true;
  }

  // --- 2. PASS / REJECT ---
  if (command.includes('PASS') || command.includes('❌') || command === 'NO' || command === 'REJECT') {
    await sendMessage(from, '👌 Understood. We will keep you in the pool for the next request.');
    return true;
  }

 // --- 3. ARRIVAL CHECK-IN ---
  if (isButton && payload.startsWith('ARRIVED_')) {
    const jobId = payload.split('_')[1];
    
    // Fetch job & artisan to see who brought this client
    const { data: job } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();
    const { data: artisan } = await supabase.from('artisan_meta').select('*').eq('phone_number', from).single();

    if (!job || !artisan) return true;

    // 🚨 THE BYOC CHECK: Did this specific artisan refer this specific job?
    const isBYOC = job.referred_artisan === artisan.artisan_id;

    await supabase.from('jobs').update({ status: 'ON_SITE', updated_at: new Date().toISOString() }).eq('job_id', jobId);
    
    if (isBYOC) {
      // 🟢 ZERO-COMMISSION FLOW
      await supabase.from('profiles').update({ current_status: 'AWAITING_BYOC_COMPLETION' }).eq('phone_number', from);
      await sendButtonMessage(from, '📍 *Status: On-Site.*\n\n🎉 *Zero-Commission Job!*\nSince you brought this client to Nexa, we take 0%.\n\nOnce you have finished the work and collected your payment directly from the client, tap below to close the job:', [
        { id: `BYOC_DONE_${jobId}`, title: '✅ Job Completed' }
      ]);
    } else {
      // 🔴 STANDARD COMMISSION FLOW
      await supabase.from('profiles').update({ current_status: 'AWAITING_PRICE' }).eq('phone_number', from);
      await sendMessage(from, '📍 *Status: On-Site.*\n\nOnce you have diagnosed the issue and completed the fix, reply to this chat with the *Total Final Amount* in Naira (Numbers only, e.g., 5500).');
    }
    return true;
  }

  // --- 3.5 ZERO-COMMISSION COMPLETION ---
  if (profile.current_status === 'AWAITING_BYOC_COMPLETION') {
    if (command.includes('DONE') || command.includes('COMPLETED') || command.includes('YES')) {

      const { data: job } = await supabase.from('jobs')
        .select('*')
        .eq('assigned_artisan', from)
        .eq('status', 'ON_SITE')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

      if (!job) return true;
      const jobId = job.job_id;

      // Log a 0-Naira commission entry for the data analytics
      await supabase.from('ledger').insert([{
        job_id: jobId,
        artisan_phone: from,
        total_job_value: 0, // Undisclosed payment
        commission_owed: 0,
        payment_status: 'CLEARED' // Auto-cleared since they owe nothing
      }]);

      await supabase.from('jobs').update({ status: 'COMPLETED' }).eq('job_id', jobId);

      // Free Artisan Immediately (No payment lock!)
      await supabase.from('artisan_meta').update({ is_available: true }).eq('phone_number', from);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);

      await sendMessage(from, `✅ *Job Closed!*\n\nThis zero-commission job has been successfully logged. You are now available in the active pool for new requests. Thanks for growing the Nexa network!`);

      // Move Client straight to Rating (Skipping the price verification entirely)
      await supabase.from('profiles').update({ current_status: 'AWAITING_RATING' }).eq('phone_number', job.client_phone);

      const ratingRows = [1, 2, 3, 4, 5].map(s => ({ id: `RATE_${jobId}_${s}`, title: `${"⭐".repeat(s)}`, description: `Rate ${s} Stars` }));
      await sendListMessage(job.client_phone, "✅ *Job Completed!*\n\nPlease rate the service provided by your artisan today:", "Rate Artisan", [{ title: "Rating", rows: ratingRows }]);

      return true;
    }
  }

  // --- 4. PRICE SUBMISSION ---
  if (profile.current_status === 'AWAITING_PRICE') {
    if (isButton) return true; // Ignore button taps — we need a typed number

    // BUG FIX #5 & #10: Added .order() and .limit(1) to prevent multi-row crashes
    const { data: job } = await supabase
      .from('jobs')
      .select('job_id, client_phone, referred_artisan')
      .eq('assigned_artisan', from)
      .eq('status', 'ON_SITE')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (!job) {
      await sendMessage(from, '⚠️ No active on-site job found. If this is an error, please contact support.');
      return true;
    }

    // Strip everything except digits and decimal point
    const quotedPrice = parseFloat(payload.replace(/[^0-9.]/g, ''));

    if (isNaN(quotedPrice) || quotedPrice <= 0) {
      await sendMessage(from, '❌ Invalid amount. Please reply with only the total price (e.g., 4000).');
      return true;
    }

    await supabase.from('jobs').update({
      quoted_price: quotedPrice,
      status: 'VERIFYING_PRICE',
      updated_at: new Date().toISOString()
    }).eq('job_id', job.job_id);

    await supabase.from('profiles').update({ current_status: 'WAITING_VERIFICATION' }).eq('phone_number', from);
    await sendMessage(from, `✅ *Price Submitted: ₦${quotedPrice.toLocaleString()}*\n\nWaiting for client verification. You will be notified once confirmed.`);

    // Proxy check
    const isProxy = job.referred_artisan && !job.referred_artisan.startsWith('NX-');
    const approvalPhone = isProxy ? job.referred_artisan : job.client_phone;

    await supabase.from('profiles').update({ current_status: 'VERIFYING_PRICE' }).eq('phone_number', approvalPhone);
    await sendTemplateMessage(approvalPhone, 'nexa_payment_verify', [quotedPrice.toLocaleString()]);

    if (isProxy) {
      await sendMessage(job.client_phone, `💳 The artisan submitted a total bill of ₦${quotedPrice.toLocaleString()}. Your agent is reviewing this for approval.`);
    }
    return true;
  }
  
  // --- 5. COMMISSION PAYMENT VERIFICATION ---
  if (profile.current_status === 'AWAITING_COMMISSION_PAYMENT') {
    if (command.includes('SENT') || command.includes('PAID') || command.includes('DONE')) {

      // Fetch the ledger entry so we can tell admin exactly how much they claim to have paid
      const { data: ledger } = await supabase.from('ledger')
        .select('*')
        .eq('artisan_phone', from)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // Free the Artisan
      await supabase.from('artisan_meta').update({ is_available: true }).eq('phone_number', from);
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);

      // Notify Customer Service Admin
      const amount = ledger ? ledger.commission_owed : 'Unknown Amount';
      const jobIdStr = ledger ? ledger.job_id.split('-')[0] : 'Unknown Job'; // Just grab the first chunk of the UUID
      
      await sendMessage(CS_NUMBER, `🚨 *COMMISSION CLAIMED PAID*\n*Artisan:* +${from}\n*Amount:* ₦${amount}\n*Job Ref:* ${jobIdStr}\n\nThe artisan has been freed for new jobs. Please verify this payment in your bank app.`);

      // Notify Artisan
      await sendMessage(from, `✅ *Confirmed!*\n\nWe have notified the admin. You are now officially available in the active pool for new jobs. Thank you for using Nexa!`);
      return true;
    } else {
       await sendMessage(from, `⚠️ Please make the transfer and reply *"SENT"* to unlock your account for new jobs.`);
       return true;
    }
  }

  return false;
}

module.exports = { handleArtisanFlow };
