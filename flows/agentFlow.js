const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage, sendListMessage } = require('../utils/whatsapp');
const { triggerMatchmaker } = require('../utils/matchmaker');

/**
 * Handles the Proxy Booking flow for authorized Nexa Agents.
 * Allows brokers to book services on behalf of clients while retaining referral tracking.
 */
async function handleAgentFlow(profile, payload, isButton) {
  const from = profile.phone_number;

  // --- 1. PROXY INITIATION ---
  // Triggered by the keyword "NEXA" or an Admin/Menu button
  if (payload === 'NEXA' || payload === 'CMD_PROXY_BOOK') {
    await supabase.from('profiles').update({ current_status: 'PROXY_PHONE' }).eq('phone_number', from);
    return await sendMessage(from, '📱 *Agent Proxy Initiated*\n\nPlease reply with the WhatsApp number of the client you are booking for (e.g., 2348012345678):');
  }

  // --- 2. CAPTURE CLIENT PHONE & SHOW CATEGORIES ---
  if (profile.current_status === 'PROXY_PHONE') {
    if (isButton) return true; // Only accept typed text for phone numbers

    // Basic Nigerian/International phone format validation
    const phoneRegex = /^\d{11,15}$/;
    if (!phoneRegex.test(payload)) {
      return await sendMessage(from, '❌ Invalid format. Please enter only digits including country code (e.g., 234...).');
    }
    
    // Store target phone in the status string to pass to the next step
    await supabase.from('profiles').update({ current_status: `PROXY_CAT_${payload}` }).eq('phone_number', from);
    
    return await sendButtonMessage(
      from,
      `✅ *Target Client:* +${payload}\n\nWhat service does this client require?`,
      [
        { id: `AG_CAT_ELECTRICAL`, title: 'Electrical' },
        { id: `AG_CAT_PLUMBING`, title: 'Plumbing' },
        { id: `AG_CAT_CARPENTRY`, title: 'Carpentry' }
      ]
    );
  }

  // --- 3. CREATE DRAFT JOB & SHOW ZONES ---
  if (profile.current_status.startsWith('PROXY_CAT_')) {
    if (!isButton || !payload.startsWith('AG_CAT_')) return true;

    const targetPhone = profile.current_status.replace('PROXY_CAT_', '');
    const categoryMap = { 'AG_CAT_ELECTRICAL': 'Electrical', 'AG_CAT_PLUMBING': 'Plumbing', 'AG_CAT_CARPENTRY': 'Carpentry' };
    const category = categoryMap[payload];

    // Initialize DRAFT job and tag the agent for commission tracking
    const { data: job, error } = await supabase.from('jobs').insert([{
      client_phone: targetPhone,
      category: category,
      status: 'DRAFT'
      // Note: If you add an 'agent_ref' column to 'jobs', insert 'from' here
    }]).select().single();

    if (error) throw error;

    await supabase.from('profiles').update({ current_status: `PROXY_ZONE_${job.job_id}` }).eq('phone_number', from);

    const zones = [
      {
        title: "Operational Zones",
        rows: [
          { id: `AG_ZONE_GIDAN_KWANO`, title: "Gidan Kwano" },
          { id: `AG_ZONE_BOSSO`, title: "Bosso" },
          { id: `AG_ZONE_MINNA_TOWN`, title: "Minna Town" }
        ]
      }
    ];

    return await sendListMessage(from, `✅ *${category}* selected.\n\nSelect the client's location zone:`, "Select Zone", zones);
  }

  // --- 4. CAPTURE ZONE & ASK FOR DESCRIPTION ---
  if (profile.current_status.startsWith('PROXY_ZONE_')) {
    if (!isButton || !payload.startsWith('AG_ZONE_')) return true;

    const jobId = profile.current_status.split('_')[2];
    const zone = payload.replace('AG_ZONE_', '').replace('_', ' ');

    await supabase.from('jobs').update({ zone: zone }).eq('job_id', jobId);
    await supabase.from('profiles').update({ current_status: `PROXY_DESC_${jobId}` }).eq('phone_number', from);

    return await sendMessage(from, `📍 *Zone:* ${zone}.\n\nBriefly describe the exact complaint (e.g., "Main switch tripping"):`);
  }

 // --- 5. FINALIZE & REQUEST CLIENT CONFIRMATION ---
  if (profile.current_status.startsWith('PROXY_DESC_')) {
    if (isButton) return true;

    const jobId = profile.current_status.split('_')[2];
    const description = `${payload} (Proxy via Agent +${from})`;

    // Note: Status is NOT 'SEARCHING' yet. It is pending the client's approval.
    await supabase.from('jobs').update({ 
      problem_description: description,
      status: 'PENDING_CLIENT_CONFIRM',
      updated_at: new Date().toISOString()
    }).eq('job_id', jobId);

    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    
    await sendMessage(from, `⏳ *Proxy Booking Pending!*\n\nWe have sent a confirmation message to the client. Once they tap "Yes", the Matchmaker will begin finding an artisan.`);
    
    // Ensure the client's profile exists
    const { data: job } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();
    await supabase.from('profiles').upsert({ phone_number: job.client_phone, current_status: 'IDLE' });

    // V2 TEMPLATE UPGRADE: Send the confirmation template to the actual client
    const { sendTemplateMessage } = require('../utils/whatsapp'); // Ensure this is imported at the top
    await sendTemplateMessage(
      job.client_phone,
      'agent_booking_confirm',
      [job.category, job.zone] // Fills in {{1}} and {{2}}
    );

    return true; // We DO NOT triggerMatchmaker() here anymore.
  }

  return false;
}

module.exports = { handleAgentFlow };
