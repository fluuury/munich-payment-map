// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

// **REPLACE THESE WITH YOUR ACTUAL KEYS!**
const supabaseUrl = 'https://qreoxotdmuufmguseitw.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFyZW94b3RkbXV1Zm1ndXNlaXR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUzMDE5MzAsImV4cCI6MjA4MDg3NzkzMH0.fUflkM4F9R7S369_lddrtm1vzzuuoQ87Qdt42b3GXzI'; 

export const supabase = createClient(supabaseUrl, supabaseAnonKey);