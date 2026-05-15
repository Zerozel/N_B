// flows/onboardingFlow.js
const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage, sendListMessage } = require('../utils/whatsapp');

/**
 * Generates a unique, category-branded Artisan ID.
 * Format: NX-[CAT]-XXXX (e.g., NX-ELE-7W2P)
 */
function generateArtisanId(category) {
  const prefixMap = { 'Electrical': 'ELE', 'Plumbing': 'PLU', 'Carpentry': 'CAR' };
  const prefix = prefixMap[category] || 'GEN';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomId = '';
  for (let i = 0; i < 4; i++) {
    randomId += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `NX-${prefix}-${randomId}`;
}

async function handleOnboardingFlow(profile, payload, isButton) {
  const from = profile.phone_number;
  const command = typeof payload === 'string' ? payload.trim().toUpperCase() : '';

  // --- 1. REGISTRATION TRIGGERS ---
  if (command === 'JOIN NEXA') {
    await supabase.from('profiles').update({ current_status: 'ONBOARDING_NAME' }).eq('phone_number', from);
    await sendMessage(from, '🛠️ *Welcome to the Nexa Artisan Network!*\n\nLet\'s get you registered. Please type your *Full Name* or *Business Name* below:');
    return true;
  }

  if (command === 'JOIN AGENT') {
    await supabase.from('profiles').update({
      current_status: 'IDLE',
      user_type: 'AGENT'
    }).eq('phone_number', from);
    await sendMessage(from, '🤝 *Welcome to the Nexa Broker Network!*\n\nYou are now an authorized Agent.\n\nTo book a service for a client and earn your commission, simply type: *NEXA*');
    return true;
  }

  // --- 2. NAME CAPTURE ---
  if (profile.current_status === 'ONBOARDING_NAME') {
    if (isButton) return true;

    await supabase.from('profiles').update({
      full_name: payload,
      current_status: 'ONBOARDING_CAT'
    }).eq('phone_number', from);

    await sendButtonMessage(from, `Thanks, ${payload}!\n\nWhat is your primary trade?`, [
      { id: 'ONB_CAT_ELECTRICAL', title: 'Electrical' },
      { id: 'ONB_CAT_PLUMBING', title: 'Plumbing' },
      { id: 'ONB_CAT_CARPENTRY', title: 'Carpentry' }
    ]);
    return true;
  }

  // --- 3. TRADE SELECTION ---
  if (profile.current_status === 'ONBOARDING_CAT') {
    if (!isButton || !payload.startsWith('ONB_CAT_')) {
      await sendMessage(from, '❌ Please use the buttons provided to select your trade.');
      return true;
    }

    const categoryMap = {
      'ONB_CAT_ELECTRICAL': 'Electrical',
      'ONB_CAT_PLUMBING': 'Plumbing',
      'ONB_CAT_CARPENTRY': 'Carpentry'
    };
    const category = categoryMap[payload];
    if (!category) return true;

    // Store category in status string temporarily — bounded value, safe per architecture
    await supabase.from('profiles').update({
      current_status: `ONBOARDING_ZONE_${category}`
    }).eq('phone_number', from);

    const zones = [
      { title: "Campus",  rows: [{ id: "ONB_ZONE_GIDAN_KWANO", title: "Gidan Kwano" }, { id: "ONB_ZONE_BOSSO", title: "Bosso" }] },
      { title: "Town",    rows: [{ id: "ONB_ZONE_MINNA_TOWN",  title: "Minna Town"  }] }
    ];

    await sendListMessage(from, `✅ *${category}* saved.\n\nWhich operational zone are you based in?`, 'Select Zone', zones);
    return true;
  }

  // --- 4. ZONE SELECTION & FINALIZATION ---
  if (profile.current_status.startsWith('ONBOARDING_ZONE_')) {
    if (!isButton || !payload.startsWith('ONB_ZONE_')) {
      await sendMessage(from, '❌ Please use the list menu to select your zone.');
      return true;
    }

    const category = profile.current_status.replace('ONBOARDING_ZONE_', '');

    // BUG FIX #8: Use /g flag to replace ALL underscores (e.g., GIDAN_KWANO → Gidan Kwano)
    const rawZone = payload.replace('ONB_ZONE_', '').replace(/_/g, ' ');
    // Title-case for clean DB storage (GIDAN KWANO → Gidan Kwano)
    const zone = rawZone.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');

    const artisanId = generateArtisanId(category);

    const { error: insertError } = await supabase.from('artisan_meta').insert([{
      artisan_id:   artisanId,
      phone_number: from,
      category:     category,
      zone:         zone,
      tier:         3,
      trust_score:  5.0,
      is_available: true,
      total_jobs:   0
    }]);

    if (insertError) {
      console.error('❌ Registration Error:', insertError);
      await sendMessage(from, '⚠️ Database Error. Could not finalize your registration. Please try again or contact support.');
      return true;
    }

    await supabase.from('profiles').update({
      current_status: 'IDLE',
      user_type: 'ARTISAN'
    }).eq('phone_number', from);

    const nexaBotNumber = process.env.BOT_PHONE_NUMBER || '2348113343613';
    const encodedMessage = encodeURIComponent(`Hi Nexa, I need a ${category} service. Ref: ${artisanId}`);
    const waLink = `https://wa.me/${nexaBotNumber}?text=${encodedMessage}`;

    await sendMessage(from,
      `✅ *Registration Complete!*\n\n` +
      `You are now active as a verified *${category}* artisan in *${zone}*.\n\n` +
      `🆔 *Your Artisan ID:* ${artisanId}\n\n` +
      `📈 *GROW YOUR BUSINESS*\n` +
      `Share your personal link and Nexa will route jobs directly to you first:\n\n` +
      `🔗 ${waLink}\n\n` +
      `To receive jobs, just type *ACCEPT* when you get a ping.`
    );
    return true;
  }

  return false;
}

module.exports = { handleOnboardingFlow };
