# CIU265 IXD Project Capture

Capture and vote client for Citizen Lens.

## Flow

```text
Capture page
  -> Vercel API /api/photos
  -> Vercel API /api/photos/:id/vote
  -> Supabase citizen_photos
  -> Vercel display page subscribes in realtime
```

## Files

```text
index.html
style.css
script.js
supabase-config.js
api/photos.js
api/photos/[id]/vote.js
```

## Vercel

Set these environment variables in the Vercel project:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

`SUPABASE_ANON_KEY` should be your publishable key.

## Supabase

The database must contain:

```text
sessions
citizen_photos
```

and `citizen_photos` must be included in the `supabase_realtime` publication.
