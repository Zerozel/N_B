const supabase = require('../config/supabase');
const { sendMessage, sendTemplateMessage } = require('../utils/whatsapp');

async function handleAgentFlow(user, from, text) {
  if (user.user_type !== 'AGENT') return false; 

  const cleanText = text.trim();
  const upperText = cleanText.toUpperCase();

  // --- BUG 1 FIX: THE TRIGGER OVERRIDE ---
  // Removed the IDLE requirement. This now intercepts immediately.
  if (upperText === 'NEXA') {
    await supabase.from('users').update({ status: 'PROXY_PHONE' }).eq('phone_number', from);
    await sendMessage(from, '📱 *Agent Proxy Initiated*\n\nPlease reply with the exact WhatsApp number of the client you are booking for (e.g., 2348012345678):\n\n*(Type "cancel" at anytime to abort)*');
    return true;
  }

  if (user.status === 'PROXY_PHONE') {
    const phoneRegex = /^\d{11,15}$/;
    if (!phoneRegex.test(cleanText)) {
      await sendMessage(from, '❌ Invalid format. Please enter only numbers with the country code (e.g., 2348012345678).\n\n*(Type "cancel" to exit)*');
      return true;
    }
    
    await supabase.from('users').update({ status: `PROXY_CAT_${cleanText}` }).eq('phone_number', from);
    await sendMessage(from, 'Got it. What service does this client need?\n\n1️⃣ Electrical\n2️⃣ Plumbing\n3️⃣ Carpentry\n\n*(Type "cancel" to exit)*');
    return true;
  }

  if (user.status.startsWith('PROXY_CAT_')) {
    const targetPhone = user.status.replace('PROXY_CAT_', '');
    const map = { '1': 'Electrical', '2': 'Plumbing', '3': 'Carpentry' };
    const category = map[cleanText];

    if (!category) {
      await sendMessage(from, '❌ Please reply with *1*, *2*, or *3*.\n\n*(Type "cancel" to exit)*');
      return true;
    }

    await supabase.from('users').update({ status: `PROXY_LOC_${targetPhone}_${category}` }).eq('phone_number', from);
    await sendMessage(from, `✅ ${category} selected.\n\nWhat is the exact location/address for the client?\n\n*(Type "cancel" to exit)*`);
    return true;
  }

  if (user.status.startsWith('PROXY_LOC_')) {
    const parts = user.status.split('_');
    const targetPhone = parts[2];
    const category = parts[3];
    const location = cleanText;
    const description = `Proxy booking via Agent +${from}`;

    // 1. Create the Ticket
    const { data: job, error: jobError } = await supabase.from('job_tickets').insert([{
      client_phone: targetPhone,
      category: category,
      location: location,
      description: description,
      status: 'SEARCHING'
    }]).select().single();

    if (jobError) {
      await sendMessage(from, '⚠️ Database error. Please try again.\n\n*(Type "cancel" to exit)*');
      return true;
    }

    // --- BUG 2 FIX: THE MISSING ARTISAN SEARCH ---
    const { data: artisans } = await supabase.from('artisans').select('*').eq('category', category).eq('is_available', true).limit(3);
    
    if (!artisans || artisans.length === 0) {
      // If no artisans, fail the job and alert the agent
      await supabase.from('job_tickets').update({ status: 'FAILED_NO_ARTISANS' }).eq('job_id', job.job_id);
      await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
      await sendMessage(from, `⚠️ We are sorry, but there are no available *${category}* artisans right now. The proxy booking could not be completed.`);
      return true;
    }

    // 2. Artisans found! Reset Agent and send success alerts
    await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
    await sendMessage(from, `🎯 *Proxy Booking Successful!*\n\nJob #${job.job_id} has been broadcasted to available artisans. You will be credited for this referral.`);
    
    // Alert the actual client via Template
    const clientVars = [category, location];
    await sendTemplateMessage(targetPhone, 'agent_alert_v2', clientVars);

    // 3. Broadcast to the Artisans via Template
    const artisanNumbers = artisans.map(a => a.phone_number);
    await supabase.from('job_tickets').update({ status: 'BROADCASTED', notified_artisans: artisanNumbers }).eq('job_id', job.job_id);
    
    for (const phone of artisanNumbers) {
      const vars = [job.job_id, category, location, description, job.job_id];
      await sendTemplateMessage(phone, 'artisan_alert_v2', vars);
    }
    
    return true;
  }

  return false;
}

module.exports = { handleAgentFlow };
