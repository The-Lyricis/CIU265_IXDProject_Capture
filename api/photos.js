import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getSupabaseAdmin() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
        res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is missing' });
        return;
    }

    try {
        const {
            id,
            session_id = null,
            image_data,
            created_at = null,
            source = 'vercel-capture',
        } = req.body || {};

        if (!id || !image_data) {
            res.status(400).json({ error: 'id and image_data are required' });
            return;
        }

        const { data, error } = await supabase
            .from('citizen_photos')
            .insert({
                id,
                session_id,
                image_data,
                votes: 0,
                source,
                created_at,
            })
            .select('*')
            .single();

        if (error) {
            res.status(500).json({ error: error.message, details: error });
            return;
        }

        res.status(201).json({ ok: true, photo: data });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
}
