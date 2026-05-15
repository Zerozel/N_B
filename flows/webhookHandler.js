// flows/webhookHandler.js
const supabase = require('../config/supabase');
const { sendMessage, sendButtonMessage } = require('../utils/whatsapp');

const { handleAdminFlow }      = require('./adminFlow');
const { handleArtisanFlow }    = require('./artisanFlow');
const { handleAgentFlow }      = require('./agentFlow');
const { handleClientFlow }     = require('./clientFlow');
const { handleOnboardingFlow } = require('./onboardingFlow');

/**
 * THE TRAFFIC COP — Routes every incoming message to the correct flow.
 */
async function processIncomingMessage(from, messageObj) {
  try {
    console.log(`\n=== MESSAGE from ${from} ===`);
    console.log(JSON.stringify(messageObj, null, 2));

    // --- 1. PARSE PAYLOAD ---
    let payload = '';
    let isButton = false;

    if (messageObj.type === 'text') {
      payload = messageObj.text.body.trim();
    } else if (messageObj.type === 'interactive') {
      isButton = true;
      if (messageObj.interactive.type === 'button_reply') {
        payload = messageObj.interactive.button_reply.id;
      } else if (messageObj.interactive.type === 'list_reply') {
        payload = messageObj.interactive.list_reply.id;
      }
    } else if (messageObj.type === 'button') {
      // 🚨 THE FIX: Catch Template Quick-Reply Buttons!
      isButton = true;
      payload = messageObj.button.payload || messageObj.button.text;
    } else {
      console.log(`⚠️  Ignoring unsupported message type: ${messageObj.type}`);
      return;
    }

    const upperPayload = payload.toUpperCase();
    console.log(`→ payload: "${payload}" | isButton: ${isButton}`);

    // --- 2. PROFILE MANAGEMENT ---
    let { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('phone_number', from)
      .single();

    if (profileError && profileError.code !== 'PGRST116') throw profileError;

    if (!profile) {
      const { data: newProfile, error: createError } = await supabase
        .from('profiles')
        .insert([{ phone_number: from, current_status: 'NEW', user_type: 'CLIENT' }])
        .select()
        .single();
      if (createError) throw createError;
      profile = newProfile;
      console.log(`✨ New user created: ${from}`);
    }

    console.log(`→ Profile: type=${profile.user_type} | status=${profile.current_status}`);

    // --- 3. GLOBAL COMMANDS (State Machine Lock) ---
    if (upperPayload === 'CMD_CANCEL' || upperPayload === 'MENU' || upperPayload === 'CANCEL') {

      // These statuses lock the user in until they complete the current step
      const lockedStatuses = [
        // Client locks
        'TRACKING_ARTISAN',    // Client waiting for artisan en route
        'VERIFYING_PRICE',     // Client approving final price
        'AWAITING_RATING',     // Must rate to close the loop
        // Artisan locks
        'WAITING_APPROVAL',    // Artisan waiting for client to approve them
        'ACTIVE_JOB',          // Artisan accepted — travelling to site
        'AWAITING_PRICE',      // Artisan on-site, must submit price
        'WAITING_VERIFICATION',// Artisan waiting for client to verify price
        // Agent proxy locks — mid-booking cannot be interrupted
        'PROXY_PHONE',
        'PROXY_CATEGORY',
        'PROXY_ZONE',
        'PROXY_DESC',
        // Operational Upgrades
        'AWAITING_COMMISSION_PAYMENT',
        'AWAITING_BYOC_COMPLETION'
      ];

      if (lockedStatuses.includes(profile.current_status)) {
        await sendMessage(from,
          '⚠️ *Action Locked*\n\n' +
          'You have an active job in progress. Please complete the current step first.\n\n' +
          'If you have an urgent issue, contact support: +' + (process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171')
        );
        return;
      }

      // Safe to reset
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', from);
      return await sendButtonMessage(from,
        '🛑 *Process Cancelled.*\n\n🔄 *Main Menu* — What would you like to do?',
        [
          { id: 'CMD_REQ_SERVICE', title: 'Request Service' },
          { id: 'CMD_ENQUIRY',     title: 'Make Enquiry'    }
        ]
      );
    }

    // --- 4. DEEP-LINK INTERCEPTOR (Ref: NX-CAT-ID) ---
    const refMatch = payload.match(/Ref:\s*(NX-[A-Z]{3}-[A-Z0-9]{4})/i);
    const referredBy = refMatch ? refMatch[1].toUpperCase() : null;
    if (referredBy) console.log(`🔗 Referral detected: ${referredBy}`);

    // --- 5. ROUTING CASCADE ---
    // Order matters: Onboarding first (catches JOIN NEXA/AGENT), then Admin, then role-based flows

    const isOnboarding = await handleOnboardingFlow(profile, payload, isButton);
    if (isOnboarding) return;

    const isAdmin = await handleAdminFlow(profile, upperPayload);
    if (isAdmin) return;

    if (profile.user_type === 'ARTISAN') {
      const handled = await handleArtisanFlow(profile, payload, isButton);
      if (handled) return;
    }

    if (profile.user_type === 'AGENT') {
      const handled = await handleAgentFlow(profile, payload, isButton);
      if (handled) return;
    }

    // CLIENT is the default (all user types fall through to client for service requests)
    const handledByClient = await handleClientFlow(profile, payload, isButton, referredBy);
    if (handledByClient) return;

    // --- 6. ULTIMATE FALLBACK ---
    console.log(`ℹ️  No handler matched for ${from}. Showing fallback menu.`);
    await sendButtonMessage(from,
      "I didn't quite get that. 🤔\n\nTap the button below to return to the main menu:",
      [{ id: 'CMD_CANCEL', title: '🔄 Main Menu' }]
    );

  } catch (err) {
    console.error(`❌ ROUTER ERROR for ${from}:`, err);
    await sendMessage(from, '⚠️ The system is refreshing. Please type "menu" in a moment.');
  }
}

module.exports = { processIncomingMessage };
