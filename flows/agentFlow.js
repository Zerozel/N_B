const supabase = require('../config/supabase');
const { sendMessage, sendTemplateMessage } = require('../utils/whatsapp');

async function handleAgentFlow(user, from, text) {
  if (user.user_type !== 'AGENT') return false; // Safety lock

  const cleanText = text.trim();
  const upperText = cleanText.toUpperCase();

  // --- TRIGGER THE PROXY BOOKING ---
  if (upperText === 'NEXA' && user.status === 'IDLE') {
    await supabase.from('users').update({ status: 'PROXY_PHONE' }).eq('phone_number', from);
    await sendMessage(from, '📱 *Agent Proxy Initiated*\n\nPlease reply with the exact WhatsApp number of the client you are booking for (e.g., 2348012345678):\n\n*(Type "cancel" at anytime to abort)*');
    return true;
  }

  if (user.status === 'PROXY_PHONE') {
    // Validate number strictly (must be digits)
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

    // Inject the job directly into the broadcast pool
    const { data: job, error } = await supabase.from('job_tickets').insert([{
      client_phone: targetPhone, // The proxy client gets the service
      category: category,
      location: location,
      description: `Proxy booking via Agent +${from}`,
      status: 'SEARCHING'
    }]).select().single();

    if (error) {
      await sendMessage(from, '⚠️ Database error. Please try again.\n\n*(Type "cancel" to exit)*');
      return true;
    }

    await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
    await sendMessage(from, `🎯 *Proxy Booking Successful!*\n\nJob #${job.job_id} has been broadcasted to artisans. You will be credited for this referral.`);
    
    // Alert the actual client that an agent booked for them (Using Template to bypass 24-hour block)
    const clientVars = [
      category, // {{1}}
      location  // {{2}}
    ];
    await sendTemplateMessage(targetPhone, 'agent_booking_alert', clientVars);
    
    return true;
  }

  return false;
}

module.exports = { handleAgentFlow };
