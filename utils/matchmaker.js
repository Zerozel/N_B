const supabase = require('../config/supabase');
const { sendTemplateMessage, sendMessage } = require('../utils/whatsapp');

/**
 * Calculates the Match Score (S) for an artisan to determine ranking.
 * Formula: S = (T * 0.4) + (R * 0.3) + (C * 0.3)
 */
function calculateMatchScore(artisan) {
  const T = artisan.tier === 1 ? 100 : artisan.tier === 2 ? 70 : 40;
  const R = (artisan.trust_score / 5.0) * 100;
  const C = 100; 
  return (T * 0.4) + (R * 0.3) + (C * 0.3);
}

/**
 * The Tiered Waterfall Dispatch Engine with 10-Minute Escalation.
 * @param {string} jobId - The UUID of the job to match.
 */
async function triggerMatchmaker(jobId) {
  // 1. Fetch the Job Details
  const { data: job } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();
  
  if (!job || !job.status.startsWith('SEARCHING_')) return;

  // 🚨 THE IDENTITY FIX: Check if this is an Artisan Referral (NX-ID) or an Agent Proxy (Phone Number)
  const isDirectReferral = job.referred_artisan && job.referred_artisan.startsWith('NX-');

  // --- NEW: THE REFERRAL BYPASS ---
  if (job.status === 'SEARCHING_T1' && isDirectReferral) {
    console.log(`🔗 Priority Routing: Job #${jobId} goes to Artisan ${job.referred_artisan} first.`);
    
    const { data: preferredArtisan } = await supabase
      .from('artisan_meta')
      .select('*')
      .eq('artisan_id', job.referred_artisan)
      .eq('is_available', true)
      .single();

    if (preferredArtisan) {
      await supabase.from('jobs').update({ status: 'SEARCHING_REFERRED' }).eq('job_id', jobId);
      await sendTemplateMessage(preferredArtisan.phone_number, 'nexa_job_alert', [job.zone, job.problem_description]);

      setTimeout(async () => {
        const { data: checkJob } = await supabase.from('jobs').select('status').eq('job_id', jobId).single();
        if (checkJob && checkJob.status === 'SEARCHING_REFERRED') {
          console.log(`⏰ Referred artisan missed it. Dropping Job #${jobId} into public T1 waterfall.`);
          await supabase.from('jobs').update({ status: 'SEARCHING_T1', referred_artisan: null }).eq('job_id', jobId);
          triggerMatchmaker(jobId);
        }
      }, 10 * 60 * 1000);

      return; 
    } else {
      console.log(`⚠️ Referred artisan ${job.referred_artisan} is offline/busy. Falling back to public waterfall.`);
    }
  } else if (job.referred_artisan && !isDirectReferral) {
    console.log(`🛡️ Proxy Job detected. Agent +${job.referred_artisan} is handling the client. Routing to public waterfall...`);
  }

  // --- STANDARD TIERED WATERFALL ---
  const currentTier = parseInt(job.status.split('_T')[1]) || 1;

  // 2. Fetch Available Artisans 
  // 🚨 THE CASE-INSENSITIVE FIX: Using .ilike() instead of .eq() so capitalization doesn't break the search
  const { data: targetGroupRaw } = await supabase
    .from('artisan_meta')
    .select('artisan_id, phone_number, tier, trust_score')
    .ilike('category', job.category) 
    .ilike('zone', job.zone)         
    .eq('is_available', true);

  if (!targetGroupRaw || targetGroupRaw.length === 0) {
    return await handleNoArtisans(jobId);
  }

  // 3. Isolate the Target Group for the CURRENT Tier
  let targetGroup = targetGroupRaw.filter(a => a.tier === currentTier);

  // 4. THE FAST-FORWARD 
  if (targetGroup.length === 0) {
    if (currentTier < 3) {
      console.log(`⏩ Tier ${currentTier} is empty for Job #${jobId}. Fast-forwarding.`);
      await supabase.from('jobs').update({ 
        status: `SEARCHING_T${currentTier + 1}`, 
        updated_at: new Date().toISOString() 
      }).eq('job_id', jobId);
      
      return triggerMatchmaker(jobId);
    } else {
      return await handleNoArtisans(jobId);
    }
  }

  // 5. Score and Sort the Target Group
  targetGroup = targetGroup.map(a => ({
    ...a,
    score: calculateMatchScore(a)
  })).sort((a, b) => b.score - a.score).slice(0, 3);

  // 6. Blast the Target Group with Meta Templates
  for (const artisan of targetGroup) {
    await sendTemplateMessage(
      artisan.phone_number,
      'nexa_job_alert',
      [job.zone, job.problem_description] 
    );
  }

  // 7. THE PATIENCE CLOCK (10-Minute Escalation Timer)
  const ESCALATION_DELAY_MS = 10 * 60 * 1000; 
  
  console.log(`⏳ Alerts sent. Starting 10-minute patience clock for Tier ${currentTier}...`);

  setTimeout(async () => {
    const { data: currentJobState } = await supabase.from('jobs').select('status').eq('job_id', jobId).single();
    
    if (currentJobState && currentJobState.status === `SEARCHING_T${currentTier}`) {
      console.log(`⏰ Time's up for Tier ${currentTier}. Nobody replied to Job #${jobId}.`);
      
      if (currentTier < 3) {
        await supabase.from('jobs').update({ 
          status: `SEARCHING_T${currentTier + 1}`, 
          updated_at: new Date().toISOString() 
        }).eq('job_id', jobId);
        
        triggerMatchmaker(jobId); 
      } else {
        await handleNoArtisans(jobId);
      }
    } else {
      console.log(`✅ Job #${jobId} was already accepted. Escalation timer safely ignored.`);
    }
  }, ESCALATION_DELAY_MS);
}

/**
 * Helper function to gracefully handle a dry waterfall and route to Human Support.
 */
async function handleNoArtisans(jobId) {
  console.log(`❌ Waterfall dry for Job #${jobId}. FAILED.`);
  
  const { data: job } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();
  if (!job) return;

  await supabase.from('jobs').update({ status: 'FAILED_NO_ARTISANS', updated_at: new Date().toISOString() }).eq('job_id', jobId);
  
  // Clean up states
  await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.client_phone);
  if (job.referred_artisan && !job.referred_artisan.startsWith('NX-')) {
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.referred_artisan);
  }
  
  const CS_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171';
  const preFilledMsg = encodeURIComponent(`Hi Nexa Support, my service request for ${job.category} in ${job.zone} couldn't find an available artisan. Can you help?`);
  const waLink = `https://wa.me/${CS_NUMBER}?text=${preFilledMsg}`;

  const failureMessage = `⚠️ *No Available Artisans*\n\nAll our verified ${job.category} personnel in your zone are currently busy or offline.\n\nPlease chat with our human support team so we can manually dispatch someone for you:\n\n🔗 ${waLink}`;

  // Notify the person handling the job
  if (job.referred_artisan && !job.referred_artisan.startsWith('NX-')) {
      await sendMessage(job.referred_artisan, failureMessage);
      await sendMessage(job.client_phone, `⚠️ We could not find an available artisan right now. Your agent has been notified and is contacting support.`);
  } else {
      await sendMessage(job.client_phone, failureMessage);
  }
}

module.exports = { triggerMatchmaker };
