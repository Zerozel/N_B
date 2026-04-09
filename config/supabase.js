require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// 1. Load Environment Variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// 2. Failsafe: Prevent the server from booting if DB credentials are missing
if (!supabaseUrl || !supabaseKey) {
  throw new Error('❌ FATAL: Missing Supabase Environment Variables. Check your .env file or Render environment settings.');
}

// 3. Initialize the global Supabase Client
const supabase = createClient(supabaseUrl, supabaseKey);

// Export for use across all flows, webhook handlers, and cron jobs
module.exports = supabase;
