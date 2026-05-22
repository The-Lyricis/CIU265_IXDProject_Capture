import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const BROADCAST_MAX_DIM = 600;
const BROADCAST_QUALITY = 0.7;
const VOTE_COOLDOWN_MS = 5000;
const MAX_LIBRARY = 100;
const FIFO_SLOTS = 8;

const PHOTO_TABLE = 'citizen_photos';

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const toast = document.getElementById('toast');
const shutter = document.getElementById('shutter-overlay');
const cameraPicker = document.getElementById('camera-picker');
const overlayPicker = document.getElementById('overlay-picker');
const overlayImg = document.getElementById('overlay-img');
const photoWall = document.getElementById('photo-wall');
const cells = Array.from(photoWall.querySelectorAll('.photo-cell'));

const photoLibrary = [];
const voteCooldownUntil = new Map();
let toastTimerId = null;
let activeStream = null;
let supabase = null;
let currentSessionId = null;
let currentCameraDeviceId = '';

// ----------------------------------------------------
// 新闻边框叠加：test1 -> testnews.png, test2 -> testnews2.png
// 黑底用 screen 混合视为透明，拍照时合成进 canvas
// ----------------------------------------------------
const OVERLAY_SOURCES = {
    test1: './testnews.png',
    test2: './testnews2.png',
};
let currentOverlayKey = 'test1';
const overlayImages = {};

function preloadOverlays() {
    for (const [key, src] of Object.entries(OVERLAY_SOURCES)) {
        const img = new Image();
        img.src = src;
        overlayImages[key] = img;
    }
}

function applyOverlaySelection() {
    currentOverlayKey = overlayPicker?.value || 'test1';
    if (overlayImg) overlayImg.src = OVERLAY_SOURCES[currentOverlayKey] || '';
}

// 把图片以 object-fit: cover 的方式画满目标尺寸
function drawCover(ctx, img, cw, ch) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}

function showToast(message, isError = false) {
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = isError ? '#b53a3a' : '#1f8f4a';
    toast.classList.add('show');
    if (toastTimerId) clearTimeout(toastTimerId);
    toastTimerId = setTimeout(() => toast.classList.remove('show'), 2200);
}

function flashShutter() {
    if (!shutter) return;
    shutter.classList.remove('flash-animation');
    void shutter.offsetWidth;
    shutter.classList.add('flash-animation');
}

function makeId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePhoto(row) {
    if (!row || !row.id) return null;
    return {
        id: row.id,
        dataUrl: row.image_data || row.data_url || row.dataUrl || '',
        votes: typeof row.votes === 'number' ? row.votes : Number(row.votes || 0),
        createdAt: row.created_at || row.createdAt || new Date().toISOString(),
    };
}

function upsertPhoto(row) {
    const photo = normalizePhoto(row);
    if (!photo) return;
    const index = photoLibrary.findIndex((p) => p.id === photo.id);
    if (index >= 0) photoLibrary[index] = photo;
    else {
        photoLibrary.push(photo);
        while (photoLibrary.length > MAX_LIBRARY) photoLibrary.shift();
    }
}

function removePhoto(id) {
    const index = photoLibrary.findIndex((p) => p.id === id);
    if (index >= 0) photoLibrary.splice(index, 1);
}

function getBestPhoto() {
    if (photoLibrary.length === 0) return null;
    const sorted = [...photoLibrary].sort((a, b) => {
        if (b.votes !== a.votes) return b.votes - a.votes;
        return new Date(b.createdAt) - new Date(a.createdAt);
    });
    if (sorted[0].votes === 0) return null;
    return sorted[0];
}

function getFifoPhotos() {
    const best = getBestPhoto();
    return photoLibrary
        .filter((p) => !best || p.id !== best.id)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, FIFO_SLOTS);
}

function renderCell(cell, photo) {
    const slot = cell.querySelector('.photo-slot');
    const btn = cell.querySelector('.vote-btn');
    const countEl = cell.querySelector('.vote-count');

    if (photo) {
        cell.dataset.photoId = photo.id;
        const existing = slot.querySelector('img');
        if (!existing || existing.dataset.photoId !== photo.id) {
            slot.innerHTML = `<img src="${photo.dataUrl}" data-photo-id="${photo.id}">`;
        }
        countEl.textContent = String(photo.votes);
        const cooldownEnd = voteCooldownUntil.get(photo.id);
        const onCooldown = cooldownEnd && cooldownEnd > Date.now();
        btn.disabled = !!onCooldown;
        btn.textContent = onCooldown ? `${Math.ceil((cooldownEnd - Date.now()) / 1000)}s` : 'VOTE';
    } else {
        delete cell.dataset.photoId;
        slot.innerHTML = '';
        countEl.textContent = '0';
        btn.disabled = true;
        btn.textContent = 'VOTE';
    }
}

function renderWall() {
    const best = getBestPhoto();
    const fifo = getFifoPhotos();
    renderCell(cells[0], best);
    for (let i = 0; i < FIFO_SLOTS; i += 1) renderCell(cells[i + 1], fifo[i]);
}

function ensureCooldownTicker() {
    if (window.__photoCooldownTicker) return;
    window.__photoCooldownTicker = setInterval(() => {
        const now = Date.now();
        let stillActive = false;
        for (const [id, end] of voteCooldownUntil) {
            if (end > now) stillActive = true;
            else voteCooldownUntil.delete(id);
        }
        renderWall();
        if (!stillActive) {
            clearInterval(window.__photoCooldownTicker);
            window.__photoCooldownTicker = null;
        }
    }, 250);
}

function captureFrameDataUrl(quality) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(video, 0, 0, vw, vh);

    // 叠加新闻边框：screen 模式让黑底透明，与取景框一致
    const overlay = overlayImages[currentOverlayKey];
    if (overlay && overlay.complete && overlay.naturalWidth) {
        ctx.globalCompositeOperation = 'screen';
        drawCover(ctx, overlay, vw, vh);
        ctx.globalCompositeOperation = 'source-over';
    }

    return canvas.toDataURL('image/jpeg', quality);
}

function downscaleDataUrl(srcDataUrl, maxDim, quality) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (w > h && w > maxDim) {
                h = Math.round((h * maxDim) / w);
                w = maxDim;
            } else if (h >= w && h > maxDim) {
                w = Math.round((w * maxDim) / h);
                h = maxDim;
            }
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = srcDataUrl;
    });
}

async function loadSupabaseConfig() {
    const response = await fetch('/supabase-config.js');
    if (!response.ok) throw new Error('Failed to load config file');
}

async function setupSupabase() {
    const mod = await import('./supabase-config.js');
    supabase = createClient(mod.SUPABASE_URL, mod.SUPABASE_ANON_KEY);
}

async function loadCurrentSession() {
    const { data, error } = await supabase
        .from('sessions')
        .select('id')
        .eq('status', 'active')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.warn('[capture] could not load active session:', error.message);
        return;
    }

    currentSessionId = data?.id || null;
}

async function loadExistingPhotos() {
    let query = supabase
        .from(PHOTO_TABLE)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(MAX_LIBRARY);

    if (currentSessionId) query = query.eq('session_id', currentSessionId);

    const { data, error } = await query;
    if (error) {
        console.warn('[capture] could not load existing photos:', error.message);
        return;
    }

    photoLibrary.length = 0;
    (data || []).forEach(upsertPhoto);
    renderWall();
}

function subscribeToPhotos() {
    const changes = { event: '*', schema: 'public', table: PHOTO_TABLE };
    if (currentSessionId) changes.filter = `session_id=eq.${currentSessionId}`;

    supabase
        .channel(currentSessionId ? `citizen-photos:${currentSessionId}` : 'citizen-photos')
        .on('postgres_changes', changes, (payload) => {
            const row = payload.new || payload.old;
            if (!row) return;
            if (payload.eventType === 'DELETE') removePhoto(row.id);
            else upsertPhoto(row);
            renderWall();
        })
        .subscribe();
}

async function populateCameraPicker() {
    if (!cameraPicker || !navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput');
    const previous = cameraPicker.value;

    cameraPicker.innerHTML = '<option value="">Auto</option>';
    cameras.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${index + 1}`;
        cameraPicker.appendChild(option);
    });

    if (currentCameraDeviceId && cameras.some((device) => device.deviceId === currentCameraDeviceId)) {
        cameraPicker.value = currentCameraDeviceId;
    } else if (previous && cameras.some((device) => device.deviceId === previous)) {
        cameraPicker.value = previous;
        currentCameraDeviceId = previous;
    }
}

async function setupCamera() {
    const constraints = {
        video: currentCameraDeviceId
            ? { deviceId: { exact: currentCameraDeviceId } }
            : true,
        audio: false,
    };

    try {
        if (activeStream) {
            activeStream.getTracks().forEach((track) => track.stop());
            activeStream = null;
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        activeStream = stream;
        video.srcObject = stream;
        await populateCameraPicker();
    } catch (err) {
        console.error('Failed to access camera', err);
        showToast('Camera unavailable', true);
    }
}

async function handleCameraChange() {
    currentCameraDeviceId = cameraPicker.value || '';
    await setupCamera();
}

async function takePhoto() {
    flashShutter();
    const rawDataUrl = captureFrameDataUrl(0.92);
    if (!rawDataUrl) {
        showToast('Camera not ready', true);
        return;
    }

    const dataUrl = await downscaleDataUrl(rawDataUrl, BROADCAST_MAX_DIM, BROADCAST_QUALITY);
    const photo = {
        id: makeId(),
        dataUrl,
        votes: 0,
        createdAt: new Date().toISOString(),
    };

    upsertPhoto({
        id: photo.id,
        image_data: photo.dataUrl,
        votes: 0,
        created_at: photo.createdAt,
    });
    renderWall();

    try {
        const response = await fetch('/api/photos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: photo.id,
                session_id: currentSessionId,
                image_data: photo.dataUrl,
                created_at: photo.createdAt,
                source: 'vercel-capture',
            }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `upload ${response.status}`);
        if (result.photo) upsertPhoto(result.photo);
        renderWall();
        showToast('Sent to newspaper');
    } catch (error) {
        console.error('[capture] upload failed:', error);
        showToast('Sync failed', true);
    }
}

function handleWallClick(event) {
    const btn = event.target.closest('.vote-btn');
    if (!btn || btn.disabled) return;
    const cell = btn.closest('.photo-cell');
    const photoId = cell?.dataset.photoId;
    if (!photoId) return;

    const end = voteCooldownUntil.get(photoId);
    if (end && end > Date.now()) return;

    const photo = photoLibrary.find((p) => p.id === photoId);
    if (photo) photo.votes += 1;
    voteCooldownUntil.set(photoId, Date.now() + VOTE_COOLDOWN_MS);
    renderWall();
    ensureCooldownTicker();

    fetch(`/api/photos/${encodeURIComponent(photoId)}/vote`, { method: 'POST' })
        .then(async (response) => {
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `vote ${response.status}`);
            if (result.photo) upsertPhoto(result.photo);
            renderWall();
        })
        .catch((error) => {
            console.warn('[capture] vote failed:', error);
            showToast('Vote sync failed', true);
        });
}

// ----------------------------------------------------
// 实体快门：Arduino 作为 USB 键盘，按键按下时敲 F9
// 网页监听 F9 即触发拍照，无需任何连接步骤或按钮
// ----------------------------------------------------
const SHUTTER_KEY = 'F9';
const KEY_DEBOUNCE_MS = 800; // 防止按键自动重复造成连拍
let lastKeyTriggerAt = 0;

function handleShutterKey(event) {
    if (event.key !== SHUTTER_KEY && event.code !== SHUTTER_KEY) return;
    event.preventDefault();
    if (event.repeat) return;
    const now = Date.now();
    if (now - lastKeyTriggerAt < KEY_DEBOUNCE_MS) return;
    lastKeyTriggerAt = now;
    takePhoto();
}

photoWall.addEventListener('click', handleWallClick);
window.addEventListener('keydown', handleShutterKey);
cameraPicker?.addEventListener('change', handleCameraChange);
overlayPicker?.addEventListener('change', applyOverlaySelection);

preloadOverlays();
applyOverlaySelection();

await setupSupabase();
await loadCurrentSession();
await loadExistingPhotos();
subscribeToPhotos();
await setupCamera();
renderWall();