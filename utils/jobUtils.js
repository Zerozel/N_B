// utils/jobUtils.js
// Shared helpers called by clientFlow and agentFlow at job completion and rating.
const supabase = require('../config/supabase');

/**
 * Called when a job is COMPLETED (price verified).
 * Increments total_jobs on the artisan's profile.
 * @param {string} artisanPhone
 */
async function incrementArtisanJobCount(artisanPhone) {
  const { data: artisan } = await supabase
    .from('artisan_meta')
    .select('total_jobs')
    .eq('phone_number', artisanPhone)
    .single();

  if (!artisan) return;

  await supabase
    .from('artisan_meta')
    .update({ total_jobs: (artisan.total_jobs || 0) + 1 })
    .eq('phone_number', artisanPhone);
}

/**
 * Called when a rating is submitted (AWAITING_RATING → IDLE).
 * Recalculates trust_score as a rolling weighted average.
 *
 * Formula: new_score = ((old_score × (total_jobs − 1)) + new_rating) / total_jobs
 * total_jobs was already incremented at completion, so we use it as the new denominator.
 *
 * @param {string} jobId   - UUID of the completed job
 * @param {number} rating  - 1–5
 */
async function applyRatingToArtisan(jobId, rating) {
  const { data: job } = await supabase
    .from('jobs')
    .select('assigned_artisan')
    .eq('job_id', jobId)
    .single();

  if (!job?.assigned_artisan) return;

  const { data: artisan } = await supabase
    .from('artisan_meta')
    .select('trust_score, total_jobs')
    .eq('phone_number', job.assigned_artisan)
    .single();

  if (!artisan) return;

  const totalJobs   = artisan.total_jobs || 1;
  const oldScore    = parseFloat(artisan.trust_score) || 5.0;
  const prevCount   = Math.max(totalJobs - 1, 0); // jobs rated before this one
  const newScore    = parseFloat(((oldScore * prevCount + rating) / totalJobs).toFixed(2));
  const capped      = Math.min(5.0, Math.max(1.0, newScore)); // clamp 1.0–5.0

  await supabase
    .from('artisan_meta')
    .update({ trust_score: capped })
    .eq('phone_number', job.assigned_artisan);

  console.log(`⭐ Trust score updated for ${job.assigned_artisan}: ${oldScore} → ${capped} (job #${totalJobs})`);
}

module.exports = { incrementArtisanJobCount, applyRatingToArtisan };
