const supabase = require('../config/supabase');
// V2 TEMPLATE UPGRADE: Added sendTemplateMessage
const { sendMessage, sendButtonMessage, sendTemplateMessage } = require('../utils/whatsapp');

/**
 * Handles the Artisan-side of the job lifecycle: Acceptance, Arrival, and Price Reporting.
 */
async function handleArtisanFlow(profile, payload, isButton) {
  const from = profile.phone_number;

  // --- 1. JOB ACCEPTANCE (Template Match) ---
  if (isButton && payload === '✅ Accept Match') {
    
    // 1a. Find the artisan's category to match the right job
    const { data: artisan } = await supabase.from('artisan_meta').select('*').eq('phone_number', from).single();
    
    // 1b. Find the most recent active job looking for this category
    const { data: job } = await supabase.from('jobs')
      .select('*')
      .like('status', 'SEARCHING_%')
      .eq('category', artisan.category)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (!job) {
      await sendMessage(from, '🔒 Sorry, this job has already been claimed by another artisan or cancelled.');
      return true;
    }

    const jobId = job.job_id;

    // Lock the job to this artisan and update status
    await supabase.from('jobs').update({
      assigned_artisan: from,
      status: 'PENDING_ON_SITE',
      updated_at: new Date().toISOString()
    }).eq('job_id', jobId);

    // Update profiles: Artisan is busy, Client is now awaiting the artisan
    await supabase.from('profiles').update({ current_status: `ACTIVE_JOB_${jobId}` }).eq('phone_number', from);
    await supabase.from('artisan_meta').update({ is_available: false }).eq('phone_number', from);
    await supabase.from('profiles').update({ current_status: `AWAITING_ARTISAN_${jobId}` }).eq('phone_number', job.client_phone);

    // Notify Artisan with standard Action Button (Free inside the 24h window now that they replied)
    await sendButtonMessage(
      from,
      `✅ *Job Claimed!*\n\n*Client:* +${job.client_phone}\n*Zone:* ${job.zone}\n*Issue:* ${job.problem_description}\n\n📞 Call the client immediately to coordinate. Tap below when you arrive:`,
      [{ id: `ARRIVED_${jobId}`, title: '📍 I Have Arrived' }]
    );

    // Notify Client
    await sendMessage(job.client_phone, `🔔 *Good news! We found a match.*\n\n🧑‍🔧 *Personnel:* ${profile.full_name}\n⭐ *Rating:* ${artisan.trust_score}/5.0\n📞 *Contact:* +${from}\n\nPlease keep your line open; they are reaching out now.`);
    return true;
  }

  // --- 2. PASS/REJECT OPTION (Template Match) ---
  if (isButton && payload === '❌ Pass') {
    await sendMessage(from, '👌 Understood. We will keep you in the pool for the next available request.');
    return true;
  }

  // --- 3. ARRIVAL CHECK-IN ---
  if (isButton && payload.startsWith('ARRIVED_')) {
    const jobId = payload.split('_')[1];
    
    // Update Job and Profile state
    await supabase.from('jobs').update({ status: 'ON_SITE', updated_at: new Date().toISOString() }).eq('job_id', jobId);
    await supabase.from('profiles').update({ current_status: `AWAITING_PRICE_${jobId}` }).eq('phone_number', from);
    
    return await sendMessage(from, '📍 *Status: On-Site.*\n\nOnce you have diagnosed the issue and completed the fix, reply to this chat with the *Total Final Amount* in Naira (Numbers only, e.g., 5500).');
  }

  // --- 4. PRICE SUBMISSION (Anti-Leakage Start) ---
  if (profile.current_status.startsWith('AWAITING_PRICE_')) {
    if (isButton) return true; // Ignore button clicks if we expect a price number

    const jobId = profile.current_status.split('_')[2];
    
    // Sanitize input: strip anything that isn't a digit
    const quotedPrice = parseFloat(payload.replace(/[^0-9.]/g, ''));
    
    if (isNaN(quotedPrice) || quotedPrice <= 0) {
      return await sendMessage(from, '❌ Invalid amount. Please reply with only the total price in numbers (e.g., 4000).');
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
    
    // V2 TEMPLATE UPGRADE: Replaced sendButtonMessage with sendTemplateMessage
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
