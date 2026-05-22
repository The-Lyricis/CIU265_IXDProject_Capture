import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const BROADCAST_MAX_DIM = 600;
const BROADCAST_QUALITY = 0.7;
const VOTE_COOLDOWN_MS = 5000;
const MAX_LIBRARY = 100;
const FIFO_SLOTS = 8;

const PHOTO_TABLE = 'citizen_photos';

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const snapBtn = document.getElementById('snap-btn');
const toast = document.getElementById('toast');
const shutter = document.getElementById('shutter-overlay');
const cameraPicker = document.getElementById('camera-picker');
const photoWall = document.getElementById('photo-wall');
const serialStatus = document.getElementById('serial-status');
const cells = Array.from(photoWall.querySelectorAll('.photo-cell'));

const photoLibrary = [];
const voteCooldownUntil = new Map();
let toastTimerId = null;
let activeStream = null;
let supabase = null;
let currentSessionId = null;
let currentCameraDeviceId = '';

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
    canvas.getContext('2d').drawImage(video, 0, 0, vw, vh);
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
// Web Serial：读取 Arduino 串口，实体按键触发拍照
// 协议：Arduino 在 D7 按下时通过 115200 串口打印 "Button Clicked!"
// ----------------------------------------------------
const SERIAL_BAUD = 115200;
const TRIGGER_LINE = 'Button Clicked!';
// 实体按键去抖：忽略 1.2 秒内重复触发，避免抖动连拍
const SERIAL_TRIGGER_DEBOUNCE_MS = 1200;

let serialPort = null;
let serialReader = null;
let serialConnected = false;
let lastSerialTriggerAt = 0;

function setSerialStatus(message, state = '') {
    if (!serialStatus) return;
    serialStatus.textContent = message;
    serialStatus.classList.remove('connected', 'error');
    if (state) serialStatus.classList.add(state);
}

function handleSerialLine(line) {
    const text = line.trim();
    if (text !== TRIGGER_LINE) return;
    const now = Date.now();
    if (now - lastSerialTriggerAt < SERIAL_TRIGGER_DEBOUNCE_MS) return;
    lastSerialTriggerAt = now;
    takePhoto();
}

async function readSerialLoop(port) {
    const textDecoder = new TextDecoderStream();
    const readableClosed = port.readable.pipeTo(textDecoder.writable).catch(() => {});
    serialReader = textDecoder.readable.getReader();

    let buffer = '';
    try {
        for (;;) {
            const { value, done } = await serialReader.read();
            if (done) break;
            buffer += value;
            let newlineIndex;
            while ((newlineIndex = buffer.search(/\r?\n/)) >= 0) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(buffer.indexOf('\n', newlineIndex) + 1);
                handleSerialLine(line);
            }
        }
    } catch (err) {
        console.warn('[serial] read error:', err);
    } finally {
        try { serialReader.releaseLock(); } catch (_) {}
        await readableClosed;
    }
}

async function disconnectSerial() {
    serialConnected = false;
    try { if (serialReader) await serialReader.cancel(); } catch (_) {}
    try { if (serialPort) await serialPort.close(); } catch (_) {}
    serialReader = null;
    serialPort = null;
    snapBtn.classList.remove('connected');
    snapBtn.textContent = 'CONNECT BUTTON';
    setSerialStatus('已断开。点击重新连接 Arduino 拍照按钮', 'error');
}

async function connectSerial() {
    if (!('serial' in navigator)) {
        setSerialStatus('此浏览器不支持 Web Serial，请使用 Chrome 或 Edge', 'error');
        showToast('浏览器不支持串口', true);
        return;
    }

    try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: SERIAL_BAUD });
        serialPort = port;
        serialConnected = true;

        snapBtn.classList.add('connected');
        snapBtn.textContent = 'BUTTON CONNECTED';
        setSerialStatus('已连接，按下实体按键即可拍照', 'connected');
        showToast('Arduino 已连接');

        port.addEventListener?.('disconnect', () => disconnectSerial());

        readSerialLoop(port).then(() => {
            if (serialConnected) disconnectSerial();
        });
    } catch (err) {
        console.error('[serial] connect failed:', err);
        // 用户取消选择串口不算错误
        if (err && err.name === 'NotFoundError') {
            setSerialStatus('未选择串口，点击重试', '');
            return;
        }
        setSerialStatus('连接失败：' + (err?.message || err), 'error');
        showToast('串口连接失败', true);
    }
}

function handleSnapButton() {
    if (serialConnected) {
        // 已连接时再次点击可断开
        disconnectSerial();
    } else {
        connectSerial();
    }
}

photoWall.addEventListener('click', handleWallClick);
snapBtn.addEventListener('click', handleSnapButton);
cameraPicker?.addEventListener('change', handleCameraChange);

await setupSupabase();
await loadCurrentSession();
await loadExistingPhotos();
subscribeToPhotos();
await setupCamera();
renderWall();