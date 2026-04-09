const supabase = require('../config/supabase');
// V2 TEMPLATE UPGRADE: Import sendTemplateMessage
const { sendTemplateMessage, sendMessage } = require('./whatsapp');

/**
 * Calculates the Match Score (S) for an artisan to determine ranking.
 * Formula: S = (T * 0.4) + (R * 0.3) + (C * 0.3)
 * @param {Object} artisan - The artisan object from the database.
 * @returns {number} The calculated score.
 */
function calculateMatchScore(artisan) {
  // T: Convert Tier (1, 2, 3) to a 100-point scale (Tier 1 = 100, 2 = 70, 3 = 40)
  const T = artisan.tier === 1 ? 100 : artisan.tier === 2 ? 70 : 40;
  
  // R: Convert 5.0 Trust Score to a 100-point scale
  const R = (artisan.trust_score / 5.0) * 100;
  
  // C: Completion/Activity (Mocking at 100 for now; can query the ledger later)
  const C = 100; 

  // The Algorithm
  return (T * 0.4) + (R * 0.3) + (C * 0.3);
}

/**
 * The Tiered Waterfall Dispatch Engine.
 * @param {string} jobId - The UUID of the job to match.
 */
async function triggerMatchmaker(jobId) {
  // 1. Fetch the Job Details
  const { data: job } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();
  
  // Failsafe: Ensure job exists and is actively searching
  if (!job || !job.status.startsWith('SEARCHING_T')) return;

  // Extract the specific tier we are currently targeting (e.g., 'SEARCHING_T2' -> 2)
  const currentTier = parseInt(job.status.split('_T')[1]) || 1;

  // 2. Fetch Available Artisans (Category + Zone explicitly filtered here!)
  const { data: targetGroupRaw } = await supabase
    .from('artisan_meta')
    .select('artisan_id, phone_number, tier, trust_score')
    .eq('category', job.category)
    .eq('zone', job.zone)          // <--- THE FIX: Checking the correct table
    .eq('is_available', true);

  if (!targetGroupRaw || targetGroupRaw.length === 0) {
    return await handleNoArtisans(job);
  }

  // 3. Isolate the Target Group for the CURRENT Tier
  let targetGroup = targetGroupRaw.filter(a => a.tier === currentTier);

  // 4. THE FAST-FORWARD UPGRADE
  if (targetGroup.length === 0) {
    if (currentTier < 3) {
      console.log(`⏩ Tier ${currentTier} is empty for Job #${jobId}. Fast-forwarding to Tier ${currentTier + 1}.`);
      
      await supabase.from('jobs').update({ 
        status: `SEARCHING_T${currentTier + 1}`, 
        updated_at: new Date().toISOString() 
      }).eq('job_id', jobId);
      
      return triggerMatchmaker(jobId); // Recursive call to instantly ping the next tier
    } else {
      // If Tier 3 is empty, the waterfall has run dry.
      return await handleNoArtisans(job);
    }
  }

  // 5. Score and Sort the Target Group
  targetGroup = targetGroup.map(a => ({
    ...a,
    score: calculateMatchScore(a)
  })).sort((a, b) => b.score - a.score).slice(0, 3); // Slice limits the blast to the top 3 max to prevent spam

  // 6. Blast the Target Group with Meta Templates (Bypasses 24h limit)
  for (const artisan of targetGroup) {
    await sendTemplateMessage(
      artisan.phone_number,
      'nexa_job_alert', // Your exact Meta Template Name
      [job.zone, job.problem_description] // Populates {{1}} and {{2}} in the template
    );
  }
}

/**
 * Helper function to gracefully handle a dry waterfall.
 */
/**
 * Helper function to gracefully handle a dry waterfall.
 */
async function handleNoArtisans(job) {
  console.log(`❌ Waterfall dry for Job #${job.job_id}. FAILED.`);
  await supabase.from('jobs').update({ status: 'FAILED_NO_ARTISANS', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
  await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.client_phone);
  
  // Route to human support to save the transaction
  const CS_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171';
  const preFilledMsg = encodeURIComponent(`Hi Nexa Support, my service request for ${job.category} in ${job.zone} couldn't find an available artisan. Can you help?`);
  const waLink = `https://wa.me/${CS_NUMBER}?text=${preFilledMsg}`;

  await sendMessage(job.client_phone, `⚠️ *No Available Artisans*\n\nAll our verified ${job.category}s in your zone are currently busy or offline.\n\nPlease chat with our human support team so we can manually dispatch someone for you:\n\n🔗 ${waLink}`);
}

module.exports = { triggerMatchmaker };
