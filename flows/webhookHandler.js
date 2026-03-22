const supabase = require('../config/supabase');
const { handleClientFlow } = require('./clientFlow');
const { handleArtisanFlow } = require('./artisanFlow');
const { sendMessage } = require('../utils/whatsapp');
const { handleOnboardingFlow } = require('./onboardingFlow');

async function processIncomingMessage(from, text) {
  try {
    let cleanText = text.trim();

    // --- 1. THE DEEP-LINK INTERCEPTOR (Marketing Strategy) ---
    // Looks for "Ref: ART-123" or similar in the incoming text
    const refMatch = cleanText.match(/Ref:\s*(ART-\d+)/i);
    let referredBy = null;
    
    if (refMatch) {
      referredBy = refMatch[1].toUpperCase(); // Extracts "ART-123"
      // Strip the reference from the text so it doesn't confuse the FSM
      cleanText = cleanText.replace(refMatch[0], '').trim(); 
      console.log(`🔗 Deep-Link detected! Client referred by: ${referredBy}`);
    }

    // --- 2. USER STATE MANAGEMENT ---
    let { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('phone_number', from)
      .single();
    
    if (userError && userError.code !== 'PGRST116') throw userError;
    
    if (!user) {
      // Create new user, attach the referral ID if it exists
      const { data: newUser } = await supabase
        .from('users')
        .insert([{ 
          phone_number: from, 
          status: 'NEW', 
          user_type: 'CLIENT',
          referred_by: referredBy // Saves the artisan's marketing tag
        }])
        .select()
        .single();
      user = newUser;
    } else {
      // Update last message and attach referral ID if they used a new link
      const updatePayload = { last_message: cleanText };
      if (referredBy) updatePayload.referred_by = referredBy;
      await supabase.from('users').update(updatePayload).eq('phone_number', from);
    }

    // --- 3. THE ROUTER ---
    // Try the Artisan Flow first. If it returns true, the message was handled.
    
    // Check if they are trying to register as an Artisan
    const isOnboardingHandled = await handleOnboardingFlow(user, from, cleanText);
    if (isOnboardingHandled) return;

    // Try the Artisan Flow first.
    const isArtisanHandled = await handleArtisanFlow(user, from, cleanText);
    if (isArtisanHandled) return;

    // If not an artisan command, pass to the Client Flow.
    const isClientHandled = await handleClientFlow(user, from, cleanText);
    if (isClientHandled) return;

    // Fallback if the FSM completely misses it (Safety net)
    await sendMessage(from, "I didn't quite understand that. Please reply with *menu* to see your options.");

  } catch (err) {
    console.error(`❌ ROUTING ERROR for ${from}:`, err);
    await sendMessage(from, '⚠️ The system is currently experiencing high traffic. Please wait a moment and reply "menu".');
  }
}

module.exports = { processIncomingMessage };
