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
const overlayImg = document.getElementById('overlay-img');
const freezeImg = document.getElementById('freeze-img');
const captureStatus = document.getElementById('capture-status');
const newsPrev = document.getElementById('news-prev');
const newsNext = document.getElementById('news-next');
const newsCurrent = document.getElementById('news-current');
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
// 新闻边框叠加：左右箭头切换 test news 1 / test news 2
// 黑底已是透明 PNG，contain 完整叠加进 canvas
// ----------------------------------------------------
const OVERLAYS = [
    { key: 'test1', label: 'Farewell to Route 16: Gothenburg\u2019s Iconic Bus Line Discontinued', src: './testnews.png' },
    { key: 'test2', label: 'Studentilska mot Chalmers nya logotyp: \u201DSkitfult\u201D', src: './testnews2.png' },
    { key: 'test3', label: 'G\u00F6teborgsvarvet 2026 \u2013 f\u00F6lj folkfesten h\u00E4r', src: './testnews3.png' },
];
let overlayIndex = 0;
let currentOverlayKey = OVERLAYS[0].key;
const overlayImages = {};

function preloadOverlays() {
    for (const o of OVERLAYS) {
        const img = new Image();
        img.src = o.src;
        overlayImages[o.key] = img;
    }
}

function applyOverlaySelection() {
    const o = OVERLAYS[overlayIndex];
    currentOverlayKey = o.key;
    if (overlayImg) overlayImg.src = o.src;
    if (newsCurrent) newsCurrent.textContent = o.label;
}

function stepOverlay(delta) {
    overlayIndex = (overlayIndex + delta + OVERLAYS.length) % OVERLAYS.length;
    applyOverlaySelection();
}

// 把图片以 object-fit: contain 的方式完整放入目标尺寸（不裁切，居中留边）
function drawContain(ctx, img, cw, ch) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = Math.min(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}

function showToast(message, isError = false) {
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = isError ? '#a93a32' : '#181818';
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

// ----------------------------------------------------
// 快门音效：播放 index 同目录下的 button.mp3
// 在拍照（用户按键手势）时触发，满足浏览器自动播放策略
// ----------------------------------------------------
const shutterAudio = new Audio('/button.mp3');
shutterAudio.preload = 'auto';

function playShutterSound() {
    try {
        shutterAudio.currentTime = 0;
        const played = shutterAudio.play();
        if (played && typeof played.catch === 'function') {
            played.catch((error) => console.warn('[capture] shutter sound failed:', error.message));
        }
    } catch (error) {
        console.warn('[capture] shutter sound failed:', error.message);
    }
}

// ----------------------------------------------------
// 拍照保护 & 定格：拍下后取景框定格 3 秒，期间禁止再次触发
// ----------------------------------------------------
const CAPTURE_FREEZE_MS = 3000;
let captureLockUntil = 0;
let freezeTimerId = null;

function setCaptureStatus(active) {
    if (!captureStatus) return;
    captureStatus.textContent = active ? 'A new headline just dropped!' : 'Awaiting photo shoot';
    captureStatus.classList.toggle('active', active);
}

function showFreeze(dataUrl) {
    if (freezeImg) {
        freezeImg.src = dataUrl;
        freezeImg.classList.add('show');
    }
    // 定格画面已含新闻边框，临时隐藏实时边框层避免重叠
    if (overlayImg) overlayImg.style.visibility = 'hidden';
    setCaptureStatus(true);

    if (freezeTimerId) clearTimeout(freezeTimerId);
    freezeTimerId = setTimeout(() => {
        if (freezeImg) {
            freezeImg.classList.remove('show');
            freezeImg.removeAttribute('src');
        }
        if (overlayImg) overlayImg.style.visibility = '';
        setCaptureStatus(false);
        freezeTimerId = null;
    }, CAPTURE_FREEZE_MS);
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
    if (index >= 0) {
        const prev = photoLibrary[index];
        // 图片内容创建后不会改变。一旦本地已有该图的有效数据，就始终保留它，
        // 不让后续投票/实时更新推送来的「空」或「被截断」的 image_data 覆盖（否则换格子重建 <img> 时会变破图）
        if (prev.dataUrl) {
            photo.dataUrl = prev.dataUrl;
        }
        photoLibrary[index] = photo;
    } else {
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

// 投票按钮始终显示「VOTE」文字 + 一条进度条：点击后置灰，进度条从左到右读条 5 秒
function ensureVoteStructure(btn) {
    if (btn.querySelector('.vote-label')) return;
    btn.textContent = '';
    const label = document.createElement('span');
    label.className = 'vote-label';
    label.textContent = 'VOTE';
    const progress = document.createElement('span');
    progress.className = 'vote-progress';
    btn.append(label, progress);
}

function setVoteProgress(btn, fraction) {
    const progress = btn.querySelector('.vote-progress');
    if (!progress) return;
    if (fraction == null) {
        // 不在冷却：立即清空（无过渡，避免读条往回缩）
        progress.style.transition = 'none';
        progress.style.width = '0%';
    } else {
        const pct = Math.max(0, Math.min(100, fraction * 100));
        // 250ms 过渡刚好衔接定时器步进，读条平滑
        progress.style.transition = 'width 250ms linear';
        progress.style.width = `${pct}%`;
    }
}

function renderCell(cell, photo) {
    const slot = cell.querySelector('.photo-slot');
    const btn = cell.querySelector('.vote-btn');
    const countEl = cell.querySelector('.vote-count');
    ensureVoteStructure(btn);

    if (photo) {
        cell.dataset.photoId = photo.id;
        const existing = slot.querySelector('img');
        if (photo.dataUrl) {
            if (!existing || existing.dataset.photoId !== photo.id) {
                slot.innerHTML = `<img src="${photo.dataUrl}" data-photo-id="${photo.id}" onerror="this.style.display='none'">`;
            }
        } else if (existing) {
            slot.innerHTML = '';
        }
        countEl.textContent = String(photo.votes);
        const cooldownEnd = voteCooldownUntil.get(photo.id);
        const onCooldown = cooldownEnd && cooldownEnd > Date.now();
        btn.disabled = !!onCooldown;
        btn.classList.toggle('cooling', !!onCooldown);
        if (onCooldown) {
            const elapsed = VOTE_COOLDOWN_MS - (cooldownEnd - Date.now());
            setVoteProgress(btn, elapsed / VOTE_COOLDOWN_MS);
        } else {
            setVoteProgress(btn, null);
        }
    } else {
        delete cell.dataset.photoId;
        slot.innerHTML = '';
        countEl.textContent = '0';
        btn.disabled = true;
        btn.classList.remove('cooling');
        setVoteProgress(btn, null);
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

// 取景框比例（4:3），拍照按此比例居中裁剪，保证所见即所得
const CAPTURE_ASPECT = 4 / 3;

function captureFrameDataUrl(quality) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    // 按 4:3 居中裁剪视频源，模拟取景框的 object-fit: cover
    let sw = vw;
    let sh = Math.round(vw / CAPTURE_ASPECT);
    if (sh > vh) {
        sh = vh;
        sw = Math.round(vh * CAPTURE_ASPECT);
    }
    const sx = Math.round((vw - sw) / 2);
    const sy = Math.round((vh - sh) / 2);

    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

    // 叠加新闻边框（PNG 已带透明通道；contain 完整显示不裁切）
    const overlay = overlayImages[currentOverlayKey];
    if (overlay && overlay.complete && overlay.naturalWidth) {
        drawContain(ctx, overlay, sw, sh);
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
    // getUserMedia 仅在安全上下文可用（https 或 http://localhost）；用 file:// 直接打开会拿不到 mediaDevices
    if (!navigator.mediaDevices?.getUserMedia) {
        console.error('navigator.mediaDevices 不可用 —— 多半是非安全上下文（file:// 或非 https）');
        showToast('Camera needs https / localhost', true);
        return;
    }

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
        await video.play().catch(() => {});
        await populateCameraPicker();
    } catch (err) {
        console.error('Failed to access camera', err);
        // 暴露真实原因便于排查：NotAllowedError(未授权) / NotFoundError(无设备) / NotReadableError(被占用) 等
        showToast(`Camera: ${err.name || 'unavailable'}`, true);
    }
}

async function handleCameraChange() {
    currentCameraDeviceId = cameraPicker.value || '';
    await setupCamera();
}

async function takePhoto() {
    // 3 秒拍照保护：定格期间忽略重复触发
    const now = Date.now();
    if (now < captureLockUntil) return;
    captureLockUntil = now + CAPTURE_FREEZE_MS;

    flashShutter();
    playShutterSound();
    const rawDataUrl = captureFrameDataUrl(0.92);
    if (!rawDataUrl) {
        showToast('Camera not ready', true);
        captureLockUntil = 0; // 拍摄失败，立即解除保护以便重试
        return;
    }

    // 取景框定格 3 秒 + 状态文字切换
    showFreeze(rawDataUrl);

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
newsPrev?.addEventListener('click', () => stepOverlay(-1));
newsNext?.addEventListener('click', () => stepOverlay(1));

preloadOverlays();
applyOverlaySelection();

// 先启动摄像头并渲染，避免后端（Supabase/CDN）初始化失败或卡住时取景框一直空白
await setupCamera();
renderWall();

try {
    await setupSupabase();
    await loadCurrentSession();
    await loadExistingPhotos();
    subscribeToPhotos();
} catch (err) {
    console.warn('[capture] backend init failed:', err);
}
renderWall();