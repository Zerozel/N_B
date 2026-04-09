const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage, sendListMessage } = require('../utils/whatsapp');

/**
 * Generates a unique, category-branded Artisan ID.
 * Format: NX-[CAT]-XXXX (e.g., NX-ELE-7W2P)
 * @param {string} category - The trade category selected by the user.
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

/**
 * Handles the registration and onboarding of new Artisans and Agents.
 */
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
    
    await sendMessage(from, '🤝 *Welcome to the Nexa Broker Network!*\n\nYou are now an authorized Agent.\n\nTo book a service for a client and earn your 15% commission share, simply type: *NEXA*');
    return true; 
  }

  // --- 2. NAME CAPTURE ---
  if (profile.current_status === 'ONBOARDING_NAME') {
    if (isButton) return true; // Name must be typed text

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

  // --- 3. TRADE SELECTION (NEW: Intercept for Zone Selection) ---
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

    // Push state forward to Zone selection, storing the category in the state string
    await supabase.from('profiles').update({ 
      current_status: `ONBOARDING_ZONE_${category}` 
    }).eq('phone_number', from);

    // Show operational zones (Matching Client Flow exactly)
    const zones = [
      { title: "Campus", rows: [{ id: "ONB_ZONE_GIDAN_KWANO", title: "Gidan Kwano" }, { id: "ONB_ZONE_BOSSO", title: "Bosso" }] },
      { title: "Town", rows: [{ id: "ONB_ZONE_MINNA_TOWN", title: "Minna Town" }] }
    ];

    await sendListMessage(from, `✅ *${category}* saved.\n\nTo help us route local jobs to you faster, which operational zone are you based in?`, "Select Zone", zones);
    return true; 
  }

  // --- 4. ZONE SELECTION & FINALIZATION ---
  if (profile.current_status.startsWith('ONBOARDING_ZONE_')) {
    if (!isButton || !payload.startsWith('ONB_ZONE_')) {
      await sendMessage(from, '❌ Please use the list menu to select your zone.');
      return true; 
    }

    const category = profile.current_status.replace('ONBOARDING_ZONE_', '');
    const zone = payload.replace('ONB_ZONE_', '').replace('_', ' '); // Formats "GIDAN_KWANO" to "GIDAN KWANO"
    const artisanId = generateArtisanId(category);

    // Create the specialized Artisan Meta-data entry
    const { error: insertError } = await supabase.from('artisan_meta').insert([{
      artisan_id: artisanId,
      phone_number: from,
      category: category,
      zone: zone,        // <--- THE MISSING LINK IS NOW FIXED
      tier: 3,           
      trust_score: 5.0,  
      is_available: true,
      total_jobs: 0
    }]);

    if (insertError) {
      console.error('Registration Error:', insertError);
      await sendMessage(from, '⚠️ Database Error. We couldn\'t finalize your registration. Please try again later.');
      return true; 
    }

    // Finalize the profile update
    await supabase.from('profiles').update({ 
      current_status: 'IDLE', 
      user_type: 'ARTISAN' 
    }).eq('phone_number', from);

    // Generate Deep-Link for direct client referral
    const nexaBotNumber = process.env.BOT_PHONE_NUMBER || '2348113343613'; 
    const encodedMessage = encodeURIComponent(`Hi Nexa, I need a ${category} service. Ref: ${artisanId}`);
    const waLink = `https://wa.me/${nexaBotNumber}?text=${encodedMessage}`;

    await sendMessage(from, 
      `✅ *Registration Complete!*\n\nYou are now active on Nexa as a verified *${category}* in *${zone}*.\n\n` +
      `📈 *GROW YOUR BUSINESS*\nWhen clients use your personal link, Nexa assigns the job *directly to you* first:\n\n` +
      `🔗 ${waLink}\n\n` +
      `Share this link on your WhatsApp status and groups!`
    );
    return true; 
  }

  return false;
}

module.exports = { handleOnboardingFlow };
