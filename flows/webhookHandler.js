const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage } = require('../utils/whatsapp');

// Import V2 Flow Handlers
const { handleAdminFlow } = require('./adminFlow');
const { handleArtisanFlow } = require('./artisanFlow');
const { handleAgentFlow } = require('./agentFlow');
const { handleClientFlow } = require('./clientFlow');
const { handleOnboardingFlow } = require('./onboardingFlow');

/**
 * THE TRAFFIC COP: Routes every incoming message to the correct logic module.
 * @param {string} from - Recipient phone number.
 * @param {Object} messageObj - The raw message object from Meta.
 */
async function processIncomingMessage(from, messageObj) {
  try {
    // 1. DATA PARSING
    let payload = '';
    let isButton = false;

    if (messageObj.type === 'text') {
      payload = messageObj.text.body.trim(); // Keep case for description/names
    } else if (messageObj.type === 'interactive') {
      isButton = true;
      payload = messageObj.interactive.type === 'button_reply' 
        ? messageObj.interactive.button_reply.id 
        : messageObj.interactive.list_reply.id;
    } else if (messageObj.type === 'button') {
      // 🚨 Catch Meta Template Quick Replies
      isButton = true;
      payload = messageObj.button.payload || messageObj.button.text;
    } else {
      return; // Ignore non-text/non-interactive media
    }
    
    const upperPayload = payload.toUpperCase();

    // 2. GLOBAL SYSTEM COMMANDS (Kill Switch)
    if (upperPayload === 'CMD_CANCEL' || upperPayload === 'MENU' || upperPayload === 'CANCEL') {
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
      
      return await sendButtonMessage(
        from, 
        '🛑 *Process Cancelled.*\n\n🔄 *Main Menu* 🛠️\nWhat would you like to do?', 
        [
          { id: 'CMD_REQ_SERVICE', title: 'Request Service' },
          { id: 'CMD_ENQUIRY', title: 'Make Enquiry' }
        ]
      );
    }

    // 3. V2 DEEP-LINK INTERCEPTOR (Ref: NX-CAT-ID)
    const refMatch = payload.match(/Ref:\s*(NX-[A-Z]{3}-[A-Z0-9]{4})/i);
    let referredBy = null;
    
    if (refMatch) {
      referredBy = refMatch[1].toUpperCase(); 
      console.log(`🔗 Referral link detected: ${referredBy}`);
    }

    // 4. PROFILE MANAGEMENT
    let { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('phone_number', from)
      .single();
    
    if (profileError && profileError.code !== 'PGRST116') throw profileError;
    
    // Create new profile if it doesn't exist
    if (!profile) {
      const { data: newProfile } = await supabase.from('profiles').insert([{ 
          phone_number: from, 
          current_status: 'NEW', 
          user_type: 'CLIENT'
        }]).select().single();
      profile = newProfile;
    }

    // 5. SEQUENTIAL ROUTING CASCADE
    // Check Onboarding first (Triggers like 'JOIN NEXA')
    const isOnboarding = await handleOnboardingFlow(profile, payload, isButton);
    if (isOnboarding) return;

    // Check Admin commands (Secure number check inside handler)
    const isAdmin = await handleAdminFlow(profile, upperPayload);
    if (isAdmin) return;

    // Route based on User Type
    if (profile.user_type === 'ARTISAN') {
      const handled = await handleArtisanFlow(profile, payload, isButton);
      if (handled) return;
    }
    
    if (profile.user_type === 'AGENT') {
      const handled = await handleAgentFlow(profile, payload, isButton);
      if (handled) return;
    }
    
    // Default: Route as a Client (Now passing the referredBy ID!)
    const handledByClient = await handleClientFlow(profile, payload, isButton, referredBy);
    if (handledByClient) return;

    // 6. ULTIMATE FALLBACK (Upgraded UX)
    await sendButtonMessage(
      from, 
      "It looks like you typed something I don't recognize right now.\n\nTo cancel your current process and return to the Main Menu, tap the button below:", 
      [{ id: 'CMD_CANCEL', title: '🔄 Main Menu' }]
    );

  } catch (err) {
    console.error(`❌ ROUTER ERROR for ${from}:`, err);
    await sendMessage(from, '⚠️ The system is currently refreshing. Please type "menu" in a moment.');
  }
}

module.exports = { processIncomingMessage };
