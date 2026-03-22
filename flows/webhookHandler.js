const supabase = require('../config/supabase');
const { handleClientFlow } = require('./clientFlow');
const { handleArtisanFlow } = require('./artisanFlow');
const { handleOnboardingFlow } = require('./onboardingFlow');
const { sendMessage } = require('../utils/whatsapp');

async function processIncomingMessage(from, text) {
  try {
    let cleanText = text.trim();
    const lowerText = cleanText.toLowerCase();

    // --- 0. THE GLOBAL KILL SWITCH ---
    // This intercepts the message BEFORE any flow can see it.
    // It instantly forces the database state back to the beginning.
    if (lowerText === 'menu' || lowerText === 'cancel' || lowerText === 'restart' || lowerText === 'stop') {
      await supabase.from('users').update({ status: 'AWAITING_INTAKE_TYPE' }).eq('phone_number', from);
      await sendMessage(from, '🛑 *Process Cancelled.*\n\n🔄 *Main Menu* 🛠️\n\nReply with a number:\n1️⃣ Service Call\n2️⃣ Make an Enquiry');
      return; // The 'return' stops the code dead in its tracks here.
    }

    // --- 1. THE DEEP-LINK INTERCEPTOR ---
    const const refMatch = cleanText.match(/Ref:\s*(ART-[A-Z0-9]+)/i);
    let referredBy = null;
    
    if (refMatch) {
      referredBy = refMatch[1].toUpperCase(); 
      cleanText = cleanText.replace(refMatch[0], '').trim(); 
      console.log(`🔗 Deep-Link detected! Client referred by: ${referredBy}`);
    }

    // --- 2. USER STATE MANAGEMENT ---
    let { data: user, error: userError } = await supabase.from('users').select('*').eq('phone_number', from).single();
    
    if (userError && userError.code !== 'PGRST116') throw userError;
    
    if (!user) {
      const { data: newUser } = await supabase.from('users').insert([{ 
          phone_number: from, 
          status: 'NEW', 
          user_type: 'CLIENT',
          referred_by: referredBy 
        }]).select().single();
      user = newUser;
    } else {
      const updatePayload = { last_message: cleanText };
      if (referredBy) updatePayload.referred_by = referredBy;
      await supabase.from('users').update(updatePayload).eq('phone_number', from);
    }

    // --- 3. THE ROUTER ---
    const isOnboardingHandled = await handleOnboardingFlow(user, from, cleanText);
    if (isOnboardingHandled) return;

    const isArtisanHandled = await handleArtisanFlow(user, from, cleanText);
    if (isArtisanHandled) return;

    const isClientHandled = await handleClientFlow(user, from, cleanText);
    if (isClientHandled) return;

    // The Ultimate Fallback
    await sendMessage(from, "I didn't quite understand that. Please reply with *menu* to restart or see your options.");

  } catch (err) {
    console.error(`❌ ROUTING ERROR for ${from}:`, err);
    await sendMessage(from, '⚠️ The system is currently experiencing high traffic. Please type "menu" to restart.');
  }
}

module.exports = { processIncomingMessage };
