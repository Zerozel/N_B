const supabase = require('../config/supabase');
const { sendMessage } = require('../utils/whatsapp');
const { extractNumber } = require('../utils/fuzzyRouter');

// Function to generate a random 4-character ID (e.g., 9X2P)
function generateArtisanId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `ART-${id}`;
}

async function handleOnboardingFlow(user, from, text) {
  const cleanText = text.trim();
  const upperText = cleanText.toUpperCase();

  // --- THE TRIGGER ---
  if (upperText === 'JOIN NEXA') {
    await supabase.from('users').update({ status: 'ONBOARDING_NAME' }).eq('phone_number', from);
    await sendMessage(from, '🛠️ *Welcome to the Nexa Artisan Network!*\n\nLet\'s get you registered. Please reply with your Full Name or Business Name.');
    return true;
  }

  // --- STEP 1: CAPTURE NAME ---
  if (user.status === 'ONBOARDING_NAME') {
    // Save their name temporarily in the status string so we don't lose it
    const safeName = cleanText.replace(/_/g, ' '); // remove underscores just in case
    await supabase.from('users').update({ status: `ONBOARDING_CAT_${safeName}` }).eq('phone_number', from);
    await sendMessage(from, `Thanks, ${safeName}!\n\nWhat is your primary trade?\n1️⃣ Electrical\n2️⃣ Plumbing\n3️⃣ Carpentry`);
    return true;
  }

  // --- STEP 2: CAPTURE CATEGORY & FINISH ---
  if (user.status.startsWith('ONBOARDING_CAT_')) {
    const name = user.status.replace('ONBOARDING_CAT_', '');
    const choice = extractNumber(cleanText, ['1', '2', '3']);
    const map = { '1': 'Electrical', '2': 'Plumbing', '3': 'Carpentry' };
    const category = map[choice];

    if (!category) {
      await sendMessage(from, '❌ Invalid choice. Please reply with *1*, *2*, or *3*.\n\n*(Type "cancel" at any time to exit)*');
      return true;
    }

    const artisanId = generateArtisanId();

    // 1. Insert them into the Artisans table
    const { error: insertError } = await supabase.from('artisans').insert([{
      phone_number: from,
      name: name,
      category: category,
      rating: 5.0, // Default starting rating
      is_available: true,
      artisan_id: artisanId
    }]);

    if (insertError) {
      console.error('Registration Error:', insertError);
      await sendMessage(from, '⚠️ There was an error registering your account. Please try again later.');
      return true;
    }

    // 2. Update their User profile to Artisan status
    await supabase.from('users').update({ 
      status: 'IDLE', 
      user_type: 'ARTISAN' 
    }).eq('phone_number', from);

    // 3. Generate the Custom Marketing Link
    // Replace with your actual Nexa Business Number
    const nexaNumber = process.env.META_PHONE_ID_OR_YOUR_NEXA_NUMBER || '2349032925721'; 
    const encodedMessage = encodeURI(`Hi Nexa, I need a ${category} service. Ref: ${artisanId}`);
    const waLink = `https://wa.me/${nexaNumber}?text=${encodedMessage}`;

    await sendMessage(from, `✅ *Registration Complete!*\n\nYou are now active on Nexa as an *${category}*.\n\n📈 *GROW YOUR BUSINESS*\nWhen clients click the link below, Nexa will assign the job *directly to you* before anyone else sees it:\n\n🔗 ${waLink}\n\nShare this link on your WhatsApp status and campus groups!`);
    
    return true;
  }

  return false;
}

module.exports = { handleOnboardingFlow };
