const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage, sendListMessage } = require('../utils/whatsapp');
const { triggerMatchmaker } = require('../utils/matchmaker');

/**
 * Handles the Proxy Booking flow for authorized Nexa Agents.
 * Allows brokers to book services on behalf of clients instantly.
 */
async function handleAgentFlow(profile, payload, isButton) {
  const from = profile.phone_number;
  
  // Normalize payload for fuzzy matching
  const command = typeof payload === 'string' ? payload.trim().toUpperCase() : '';

  // --- 1. PROXY INITIATION ---
  if (command === 'NEXA' || command === 'CMD_PROXY_BOOK') {
    await supabase.from('profiles').update({ current_status: 'PROXY_PHONE' }).eq('phone_number', from);
    await sendMessage(from, '📱 *Agent Proxy Initiated*\n\nPlease reply with the WhatsApp number of the client you are booking for (e.g., 2348012345678):');
    return true; 
  }

  // --- 2. CAPTURE CLIENT PHONE & SHOW CATEGORIES ---
  if (profile.current_status === 'PROXY_PHONE') {
    if (isButton) return true; // Only accept typed text for phone numbers

    const phoneRegex = /^\d{11,15}$/;
    if (!phoneRegex.test(payload)) {
      await sendMessage(from, '❌ Invalid format. Please enter only digits including country code (e.g., 234...).');
      return true; 
    }
    
    const targetPhone = payload;

    // Failsafe: Ensure the target client has a profile in the database so they can receive the artisan details later
    await supabase.from('profiles').upsert({ phone_number: targetPhone, user_type: 'CLIENT' }, { onConflict: 'phone_number', ignoreDuplicates: true });

    // 🚨 DATABASE FIX: We create the DRAFT job right now, and use `referred_artisan` to secretly tag it to this Agent.
    const { data: job, error } = await supabase.from('jobs').insert([{
      client_phone: targetPhone,
      status: 'PROXY_DRAFT',
      referred_artisan: from 
    }]).select().single();

    if (error) throw error;
    
    // Clean status strings
    await supabase.from('profiles').update({ current_status: 'PROXY_CATEGORY' }).eq('phone_number', from);
    
    await sendButtonMessage(
      from,
      `✅ *Target Client:* +${targetPhone}\n\nWhat service does this client require?`,
      [
        { id: `AG_CAT_ELECTRICAL`, title: 'Electrical' },
        { id: `AG_CAT_PLUMBING`, title: 'Plumbing' },
        { id: `AG_CAT_CARPENTRY`, title: 'Carpentry' }
      ]
    );
    return true; 
  }

  // --- 3. SHOW ZONES ---
  if (profile.current_status === 'PROXY_CATEGORY') {
    if (!isButton || !command.startsWith('AG_CAT_')) return true;

    const categoryMap = { 'AG_CAT_ELECTRICAL': 'Electrical', 'AG_CAT_PLUMBING': 'Plumbing', 'AG_CAT_CARPENTRY': 'Carpentry' };
    const category = categoryMap[command];

    // Find the exact draft this agent is working on
    const { data: job } = await supabase.from('jobs')
      .select('job_id')
      .eq('status', 'PROXY_DRAFT')
      .eq('referred_artisan', from)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!job) return true;

    await supabase.from('jobs').update({ category: category }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'PROXY_ZONE' }).eq('phone_number', from);

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

    await sendListMessage(from, `✅ *${category}* selected.\n\nSelect the client's location zone:`, "Select Zone", zones);
    return true; 
  }

  // --- 4. CAPTURE ZONE & ASK FOR DESCRIPTION ---
  if (profile.current_status === 'PROXY_ZONE') {
    if (!isButton || !command.startsWith('AG_ZONE_')) return true;

    const { data: job } = await supabase.from('jobs')
      .select('job_id')
      .eq('status', 'PROXY_DRAFT')
      .eq('referred_artisan', from)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!job) return true;

    const zone = command.replace('AG_ZONE_', '').replace('_', ' ');

    await supabase.from('jobs').update({ zone: zone }).eq('job_id', job.job_id);
    await supabase.from('profiles').update({ current_status: 'PROXY_DESC' }).eq('phone_number', from);

    await sendMessage(from, `📍 *Zone:* ${zone}.\n\nBriefly describe the exact complaint (e.g., "Main switch tripping"):`);
    return true; 
  }

 // --- 5. FINALIZE & AUTO-START WATERFALL ---
  if (profile.current_status === 'PROXY_DESC') {
    if (isButton) return true;

    const { data: job } = await supabase.from('jobs')
      .select('*')
      .eq('status', 'PROXY_DRAFT')
      .eq('referred_artisan', from)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!job) return true;

    const description = `${payload} (Proxy via Agent +${from})`;

    // 🚨 NEW FEATURE: Bypass Client Confirmation. Send directly to Matchmaker.
    await supabase.from('jobs').update({ 
      problem_description: description,
      status: 'SEARCHING_T1',
      updated_at: new Date().toISOString()
    }).eq('job_id', job.job_id);

    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
    
    await sendMessage(from, `✅ *Proxy Booking Confirmed!*\n\nTarget Client: +${job.client_phone}\nThe Matchmaker has been triggered and is finding an artisan now.`);
    
    // Notify the client that their job has started (No action required from them)
    await sendMessage(
      job.client_phone,
      `👋 *Hello from Nexa!*\n\nAn agent has just booked a *${job.category}* service on your behalf for an issue in *${job.zone}*.\n\n⚙️ We are currently matching you with a verified artisan. Please keep this chat open for updates!`
    );

    // Instantly blast the template to the artisans!
    triggerMatchmaker(job.job_id);
    return true; 
  }

  return false;
}

module.exports = { handleAgentFlow };
