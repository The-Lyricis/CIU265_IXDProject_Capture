# CIU265 IXD Project Capture

Capture and vote client for Citizen Lens.

Live project:

```text
https://ciu-265-ixd-project-capture.vercel.app/
```

## Flow

```text
User opens the capture page
  -> Browser camera starts
  -> User takes a photo
  -> Vercel API writes the photo to Supabase `citizen_photos`
  -> User votes on photos in the same wall
  -> Vercel API updates the vote count in Supabase
  -> Newspaper display subscribes to Supabase Realtime
  -> Display updates without refresh
```

## What this project does

```text
Capture / vote page:
  - Browser camera access
  - Camera selector
  - Capture button
  - Vote buttons
  - Session-aware photo loading

Backend:
  - Vercel serverless API
  - Writes to Supabase with the service role key

Database:
  - Stores photos in `citizen_photos`
  - Tracks vote counts
  - Publishes realtime updates
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

## Display Side

The newspaper display lives in the separate Vercel repository and subscribes to:

```text
citizen_photos
sessions
frontpage_articles
interviews
```

Both apps use the same `session_id` so the capture page and display page stay in sync.

## Supabase

The database must contain:

```text
sessions
citizen_photos
```

and `citizen_photos` must be included in the `supabase_realtime` publication.
