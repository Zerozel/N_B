const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage, sendTemplateMessage } = require('../utils/whatsapp');

/**
 * Handles the Artisan-side of the job lifecycle: Acceptance, Arrival, and Price Reporting.
 */
async function handleArtisanFlow(profile, payload, isButton) {
  const from = profile.phone_number;
  
  // Normalize the payload to uppercase so we catch 'accept', 'ACCEPT', 'Accept_Match', etc.
  const command = typeof payload === 'string' ? payload.toUpperCase() : '';

  // --- 1. JOB ACCEPTANCE (Double Opt-In Handshake) ---
  // 🚨 THE FIX: Catch any payload containing 'ACCEPT' or the Checkmark emoji or 'YES'
  if (isButton && (command.includes('ACCEPT') || command.includes('✅') || command.includes('YES'))) {
    
    // 1a. Find the artisan's category to match the right job
    const { data: artisan } = await supabase.from('artisan_meta').select('*').eq('phone_number', from).single();
    
    // Failsafe: If the artisan somehow isn't in the meta table, stop the crash
    if (!artisan) {
      await sendMessage(from, '⚠️ Error: We could not find your verified trade category. Please text "MENU" and contact support.');
      return true;
    }

    // 1b. Find the most recent active job looking for this category
    const { data: job } = await supabase.from('jobs')
      .select('*')
      .like('status', 'SEARCHING_%') // Catches SEARCHING_T1, SEARCHING_T2, and SEARCHING_REFERRED
      .eq('category', artisan.category)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (!job) {
      await sendMessage(from, '🔒 Sorry, this job has already been claimed or cancelled.');
      return true;
    }

    const jobId = job.job_id;

    // Lock the job in a new "CLIENT_REVIEW" status
    await supabase.from('jobs').update({
      assigned_artisan: from,
      status: 'CLIENT_REVIEW',
      updated_at: new Date().toISOString()
    }).eq('job_id', jobId);

    // Tell the Artisan to hold on
    await supabase.from('profiles').update({ current_status: `WAITING_CLIENT_APPROVAL_${jobId}` }).eq('phone_number', from);
    await supabase.from('artisan_meta').update({ is_available: false }).eq('phone_number', from);

    await sendMessage(from, '⏳ *Match Request Sent!*\n\nWe have sent your profile to the client for final approval. Please wait a moment...');

    // Send the Client the interactive approval menu
    await supabase.from('profiles').update({ current_status: `APPROVING_ARTISAN_${jobId}` }).eq('phone_number', job.client_phone);
    
    await sendButtonMessage(
      job.client_phone,
      `🔔 *Artisan Found!*\n\n🧑‍🔧 *Name:* ${profile.full_name}\n⭐ *Rating:* ${artisan.trust_score}/5.0\n\nWould you like to accept this personnel for your request?`,
      [
        { id: `CLIENT_ACCEPT_${jobId}`, title: '✅ Accept Artisan' },
        { id: `CLIENT_REJECT_${jobId}`, title: '❌ Find Someone Else' }
      ]
    );
    return true;
  }

  // --- 2. PASS/REJECT OPTION (Fuzzy Template Match) ---
  if (isButton && (command.includes('PASS') || command.includes('❌') || command.includes('REJECT'))) {
    await sendMessage(from, '👌 Understood. We will keep you in the pool for the next available request.');
    return true;
  }

  // --- 3. ARRIVAL CHECK-IN ---
  if (isButton && payload.startsWith('ARRIVED_')) {
    const jobId = payload.split('_')[1];
    
    // Update Job and Profile state
    await supabase.from('jobs').update({ status: 'ON_SITE', updated_at: new Date().toISOString() }).eq('job_id', jobId);
    await supabase.from('profiles').update({ current_status: `AWAITING_PRICE_${jobId}` }).eq('phone_number', from);
    
    await sendMessage(from, '📍 *Status: On-Site.*\n\nOnce you have diagnosed the issue and completed the fix, reply to this chat with the *Total Final Amount* in Naira (Numbers only, e.g., 5500).');
    return true;
  }

  // --- 4. PRICE SUBMISSION (Anti-Leakage Start) ---
  if (profile.current_status.startsWith('AWAITING_PRICE_')) {
    if (isButton) return true; // Ignore button clicks if we expect a price number

    const jobId = profile.current_status.split('_')[2];
    
    // Sanitize input: strip anything that isn't a digit
    const quotedPrice = parseFloat(payload.replace(/[^0-9.]/g, ''));
    
    if (isNaN(quotedPrice) || quotedPrice <= 0) {
      await sendMessage(from, '❌ Invalid amount. Please reply with only the total price in numbers (e.g., 4000).');
      return true;
    }

    // Save quoted price and trigger client verification
    await supabase.from('jobs').update({ 
      quoted_price: quotedPrice,
      status: 'VERIFYING_PRICE',
      updated_at: new Date().toISOString()
    }).eq('job_id', jobId);

    // Put artisan in IDLE while waiting for verification, but they stay 'unavailable' in artisan_meta
    await supabase.from('profiles').update({ current_status: `IDLE` }).eq('phone_number', from); 
    
    await sendMessage(from, `✅ *Price Submitted: ₦${quotedPrice.toLocaleString()}*\n\nWe are now asking the client to verify this amount. You will be notified once they confirm.`);

    // Alert the Client to confirm the price using the Meta Template
    const { data: job } = await supabase.from('jobs').select('client_phone').eq('job_id', jobId).single();
    await supabase.from('profiles').update({ current_status: `VERIFY_PRICE_${jobId}` }).eq('phone_number', job.client_phone);
    
    await sendTemplateMessage(
      job.client_phone,
      'nexa_payment_verify',
      [quotedPrice.toLocaleString()] // Populates the {{1}} variable in the template
    );
    
    return true;
  }

  return false;
}

module.exports = { handleArtisanFlow };
