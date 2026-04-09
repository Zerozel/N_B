const supabase = require('../config/supabase');
// V2 TEMPLATE UPGRADE: Import sendTemplateMessage
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
  if (!job || !job.status.startsWith('SEARCHING_T')) return;

  const currentTier = parseInt(job.status.split('_T')[1]) || 1;

  // 2. Fetch Available Artisans (Category + Zone)
  const { data: targetGroupRaw } = await supabase
    .from('artisan_meta')
    .select('artisan_id, phone_number, tier, trust_score')
    .eq('category', job.category)
    .eq('zone', job.zone)
    .eq('is_available', true);

  // If absolutely ZERO artisans exist in this zone/category across all tiers
  if (!targetGroupRaw || targetGroupRaw.length === 0) {
    // Fail instantly. No need to make the client wait 10 mins if nobody exists.
    return await handleNoArtisans(jobId);
  }

  // 3. Isolate the Target Group for the CURRENT Tier
  let targetGroup = targetGroupRaw.filter(a => a.tier === currentTier);

  // 4. THE FAST-FORWARD (If current tier is empty, move to next instantly)
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
  const ESCALATION_DELAY_MS = 10 * 60 * 1000; // 10 minutes in milliseconds
  
  console.log(`⏳ Alerts sent. Starting 10-minute patience clock for Tier ${currentTier}...`);

  setTimeout(async () => {
    // Wake up after 10 minutes and check the database
    const { data: currentJobState } = await supabase.from('jobs').select('status').eq('job_id', jobId).single();
    
    // If the status is STILL searching for this tier, nobody accepted it
    if (currentJobState && currentJobState.status === `SEARCHING_T${currentTier}`) {
      console.log(`⏰ Time's up for Tier ${currentTier}. Nobody replied to Job #${jobId}.`);
      
      if (currentTier < 3) {
        // Escalate to next tier
        await supabase.from('jobs').update({ 
          status: `SEARCHING_T${currentTier + 1}`, 
          updated_at: new Date().toISOString() 
        }).eq('job_id', jobId);
        
        triggerMatchmaker(jobId); // Run the engine for the next tier
      } else {
        // The entire waterfall is exhausted
        await handleNoArtisans(jobId);
      }
    } else {
      // The status changed (e.g., PENDING_ON_SITE)! Someone accepted it.
      console.log(`✅ Job #${jobId} was already accepted. Escalation timer safely ignored.`);
    }
  }, ESCALATION_DELAY_MS);
}

/**
 * Helper function to gracefully handle a dry waterfall and route to Human Support.
 */
async function handleNoArtisans(jobId) {
  console.log(`❌ Waterfall dry for Job #${jobId}. FAILED.`);
  
  // Fetch latest job details for the message
  const { data: job } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();
  if (!job) return;

  await supabase.from('jobs').update({ status: 'FAILED_NO_ARTISANS', updated_at: new Date().toISOString() }).eq('job_id', jobId);
  await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.client_phone);
  
  const CS_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171';
  const preFilledMsg = encodeURIComponent(`Hi Nexa Support, my service request for ${job.category} in ${job.zone} couldn't find an available artisan. Can you help?`);
  const waLink = `https://wa.me/${CS_NUMBER}?text=${preFilledMsg}`;

  await sendMessage(job.client_phone, `⚠️ *No Available Artisans*\n\nAll our verified ${job.category}s in your zone are currently busy or offline.\n\nPlease chat with our human support team so we can manually dispatch someone for you:\n\n🔗 ${waLink}`);
}

module.exports = { triggerMatchmaker };
