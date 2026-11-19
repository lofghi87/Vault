import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import { LockKeyhole, ShieldCheck, UploadCloud, Film, Share2, Trash2, LogOut, Eye, EyeOff, Copy, Check, X, Play, Clock3, HardDrive, LoaderCircle, KeyRound, Mail, ArrowUpRight, AlertCircle, Pencil, Maximize2, Download, UserRound, Activity, Smartphone, Settings } from 'lucide-react';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const BUCKET = 'vault-videos';
const SHARE_SECONDS = 60 * 60;
async function b2Request(session, payload) {
  if (!session?.access_token) throw new Error('Sessione non valida: accedi di nuovo.');
  const response = await fetch('/api/storage', { method: 'POST', headers: { Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Operazione Backblaze non riuscita (HTTP ' + response.status + ').');
  return result;
}
async function b2ListAll(session) {
  const all = [];
  let continuationToken = null;
  do {
    const result = await b2Request(session, {
      action: 'list',
      ...(continuationToken ? { continuationToken } : {}),
    });
    all.push(...(result.data || []));
    continuationToken = result.nextContinuationToken || null;
  } while (continuationToken);
  return all;
}
async function b2Download(session,path){ const r=await b2Request(session,{action:'downloadUrl',path}); const response=await fetch(r.url); if(!response.ok) throw new Error('Download Backblaze non riuscito (HTTP '+response.status+').'); return response.blob(); }
async function b2Upload(session,path,blob){ const r=await b2Request(session,{action:'uploadUrl',path,size:blob.size}); const response=await fetch(r.url,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:blob}); if(!response.ok) throw new Error('Caricamento Backblaze non riuscito (HTTP '+response.status+').'); const v=await b2Request(session,{action:'verify',path,expectedSize:blob.size}); if(Number(v.data?.size)!==blob.size) throw new Error('Verifica dimensionale Backblaze non riuscita.'); }
async function b2Delete(session,paths){ if(paths?.length) await b2Request(session,{action:'delete',paths}); }
async function b2DeleteShareCopies(session, paths) {
  if (!paths?.length) return;
  await b2Delete(session, paths);
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) throw new Error('Non riesco a rimuovere anche le eventuali vecchie copie su Supabase: ' + error.message);
}
async function b2Move(session,from,to){ await b2Request(session,{action:'move',from,to}); }
async function b2Copy(session,from,to){ await b2Request(session,{action:'copy',from,to}); }
async function b2SignedUrl(session,path,seconds=3600){ const r=await b2Request(session,{action:'sign',path,seconds}); return r.url; }

async function googleRequest(session, payload) {
  if (!session?.access_token) throw new Error('Sessione Vault non valida.');
  const response = await fetch('/api/google-drive', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + session.access_token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Operazione Google Drive non riuscita.');
  return result;
}

async function googleDownload(session, accountId, fileId, size) {
  const totalSize = Number(size || 0);
  const chunkSize = 8 * 1024 * 1024;
  const chunks = [];
  const query = new URLSearchParams({ action: 'download', accountId, fileId });
  const downloadChunk = async (start, end, useRange) => {
    const headers = { Authorization: 'Bearer ' + session.access_token };
    if (useRange) headers.Range = 'bytes=' + start + '-' + end;
    const response = await fetch('/api/google-drive?' + query.toString(), {
      headers,
      cache: 'no-store',
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'Download da Google Drive non riuscito.');
    }
    if (useRange && response.status !== 206) {
      throw new Error('Google Drive non ha restituito una parte valida del video. Riprova.');
    }
    const blob = await response.blob();
    const expected = end - start + 1;
    if (useRange && blob.size !== expected) {
      throw new Error('Il download parziale da Google Drive è incompleto.');
    }
    chunks.push(blob);
  };

  if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || totalSize <= chunkSize) {
    await downloadChunk(0, Math.max(0, totalSize - 1), false);
    return chunks[0];
  }

  for (let start = 0; start < totalSize; start += chunkSize) {
    const end = Math.min(totalSize - 1, start + chunkSize - 1);
    await downloadChunk(start, end, true);
  }
  return new Blob(chunks, { type: 'application/octet-stream' });
}

async function googleUpload(session, accountId, name, encryptedBlob) {
  const started = await googleRequest(session, {
    action: 'startUpload', accountId, name, size: encryptedBlob.size,
  });
  if (!started.uploadUrl) throw new Error('Google Drive non ha preparato il caricamento.');
  const chunkSize = 8 * 1024 * 1024; // Multiplo di 256 KB, adatto ai video di grandi dimensioni.
  let offset = 0;
  let uploaded = null;

  const probeUpload = async () => {
    const response = await fetch(started.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': 'bytes */' + encryptedBlob.size },
      body: new Blob([]),
    });
    if (response.status === 200 || response.status === 201) {
      return { nextOffset: encryptedBlob.size, uploaded: await response.json().catch(() => ({})) };
    }
    if (response.status !== 308) {
      throw new Error('Non riesco a riprendere il caricamento su Google Drive.');
    }
    const range = response.headers.get('Range') || '';
    const match = range.match(/^bytes=0-([0-9]+)$/);
    return { nextOffset: match ? Number(match[1]) + 1 : 0, uploaded: null };
  };

  while (offset < encryptedBlob.size) {
    const end = Math.min(encryptedBlob.size, offset + chunkSize) - 1;
    const chunk = encryptedBlob.slice(offset, end + 1);
    let response;
    try {
      response = await fetch(started.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': 'bytes ' + offset + '-' + end + '/' + encryptedBlob.size,
        },
        body: chunk,
      });
    } catch {
      const progress = await probeUpload();
      if (progress.uploaded) {
        uploaded = progress.uploaded;
        offset = encryptedBlob.size;
        break;
      }
      if (progress.nextOffset === offset) {
        throw new Error('Connessione interrotta durante il caricamento su Google Drive. Puoi riprovare senza ricifrare il video.');
      }
      offset = progress.nextOffset;
      continue;
    }

    if (response.status === 200 || response.status === 201) {
      uploaded = await response.json().catch(() => ({}));
      offset = encryptedBlob.size;
      break;
    }
    if (response.status !== 308) {
      const progress = await probeUpload().catch(() => null);
      if (progress?.uploaded) {
        uploaded = progress.uploaded;
        offset = encryptedBlob.size;
        break;
      }
      throw new Error('Caricamento su Google Drive non riuscito (HTTP ' + response.status + '). Riprova.');
    }

    const range = response.headers.get('Range') || '';
    const match = range.match(/^bytes=0-([0-9]+)$/);
    if (match) {
      offset = Number(match[1]) + 1;
    } else {
      const progress = await probeUpload();
      if (progress.uploaded) {
        uploaded = progress.uploaded;
        offset = encryptedBlob.size;
      } else if (progress.nextOffset > offset) {
        offset = progress.nextOffset;
      } else {
        throw new Error('Google Drive non ha confermato i dati caricati. Riprova.');
      }
    }
  }

  if (!uploaded?.id) {
    const progress = await probeUpload();
    uploaded = progress.uploaded;
  }
  if (!uploaded?.id) throw new Error('Google Drive non ha confermato il completamento del caricamento.');

  const verified = await googleRequest(session, {
    action: 'verify', accountId, fileId: uploaded.id, expectedSize: encryptedBlob.size,
  });
  return verified.data;
}

function getDisplayName(name) {
  return name.replace(/^[0-9a-f-]{30,}-/i, '').replace(/\.vlt$/i, '');
}

function metadataStoragePath(userId, storagePath) {
  if (typeof storagePath === 'string' && storagePath.startsWith('google:')) {
    const [, accountId, fileId] = storagePath.split(':');
    return userId + '/_google/' + accountId + '/' + fileId;
  }
  return storagePath;
}

async function sealVideoMetadata(metadata, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(metadata));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return bytesToBase64(new Uint8Array([...iv, ...new Uint8Array(cipher)]));
}

async function openVideoMetadata(value, key) {
  try {
    const packed = base64ToBytes(value || '');
    if (packed.length < 29) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12));
    const parsed = JSON.parse(new TextDecoder().decode(plain));
    if (typeof parsed.name !== 'string' || typeof parsed.mime !== 'string') return null;
    return { name: parsed.name, mime: parsed.mime };
  } catch {
    return null;
  }
}

async function saveEncryptedVideoMetadata(userId, storagePath, metadata, key) {
  const encryptedMetadata = await sealVideoMetadata(metadata, key);
  const { error } = await supabase.from('vault_video_meta').upsert({
    user_id: userId,
    storage_path: storagePath,
    encrypted_metadata: encryptedMetadata,
  }, { onConflict: 'user_id,storage_path' });
  if (error) throw new Error('Metadati cifrati non salvati: ' + error.message);
}

async function loadEncryptedVideoMetadata(userId, paths, key) {
  if (!paths.length) return new Map();
  const result = new Map();
  for (let offset = 0; offset < paths.length; offset += 100) {
    const batch = paths.slice(offset, offset + 100);
    const { data, error } = await supabase.from('vault_video_meta')
      .select('storage_path,encrypted_metadata')
      .eq('user_id', userId)
      .in('storage_path', batch);
    if (error) throw new Error('Non riesco a leggere i metadati cifrati: ' + error.message);
    for (const row of data || []) {
      const metadata = await openVideoMetadata(row.encrypted_metadata, key);
      if (metadata) result.set(row.storage_path, metadata);
    }
  }
  return result;
}

function getOriginalVideoMime(name) {
  const match = name.replace(/\.vlt$/i, '').match(/\.([a-z0-9]+)$/i);
  const ext = match ? match[1].toLowerCase() : '';
  const types = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mpeg: 'video/mpeg', mpg: 'video/mpeg', '3gp': 'video/3gpp' };
  return types[ext] || 'video/mp4';
}

async function deriveVaultKey(passphrase, userId) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new TextEncoder().encode('VAULT-v1:' + userId), iterations: 310000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function encryptVideo(file, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await file.arrayBuffer();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return new Blob([new Uint8Array([86, 76, 84, 49]), iv, cipher], { type: 'application/octet-stream' });
}

async function decryptVideo(blob, key, mime) {
  const data = new Uint8Array(await blob.arrayBuffer());
  if (data.length < 32 || data[0] !== 86 || data[1] !== 76 || data[2] !== 84 || data[3] !== 49) throw new Error('Formato cifrato non riconosciuto.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(4, 16) }, key, data.slice(16));
  return new Blob([plain], { type: mime || 'video/mp4' });
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function createVideoPoster(blob) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(blob);
    let finished = false;
    const timeout = window.setTimeout(() => finish(''), 5000);
    function finish(result) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    }
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth) {
        finish('');
        return;
      }
      try { video.currentTime = Math.min(0.2, video.duration / 3); }
      catch { finish(''); }
    }, { once: true });
    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 480 / video.videoWidth);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) return finish('');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.68));
      } catch { finish(''); }
    }, { once: true });
    video.addEventListener('error', () => finish(''), { once: true });
    video.src = objectUrl;
    video.load();
  });
}

function isAppleVideoDevice() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function getDeviceLabel() {
  const ua = navigator.userAgent || '';
  const platform = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    ? 'iPad'
    : /iPhone|iPod/.test(ua) ? 'iPhone'
    : /Android/.test(ua) ? 'Dispositivo Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'PC Windows'
    : /Linux/.test(ua) ? 'Computer Linux'
    : 'Questo dispositivo';
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return platform + ' · ' + browser;
}

function parseIncomingShare() {
  try {
    const raw = new URLSearchParams(window.location.hash.slice(1)).get('share');
    if (!raw) return null;
    const payload = JSON.parse(raw);
    const signedUrl = new URL(payload.url);
    const isSupabaseShare = signedUrl.origin === new URL(supabaseUrl).origin && signedUrl.pathname.includes('/storage/v1/object/sign/' + BUCKET + '/');
    const isBackblazeShare = signedUrl.hostname === 's3.eu-central-003.backblazeb2.com' && signedUrl.pathname.includes('/' + BUCKET + '/');
    if (!isSupabaseShare && !isBackblazeShare) return null;
    if (!payload.key || !payload.name || !payload.mime || base64ToBytes(payload.key).length !== 32) return null;
    return payload;
  } catch { return null; }
}

function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [videos, setVideos] = useState([]);
  const [storageQuota, setStorageQuota] = useState(null);
  const [googleDriveQuota, setGoogleDriveQuota] = useState(null);
  const [googleAccounts, setGoogleAccounts] = useState([]);
  const [storageDestination, setStorageDestination] = useState('backblaze');
  const [uploadDestinationOpen, setUploadDestinationOpen] = useState(false);
  const [googleDriveError, setGoogleDriveError] = useState('');
  const [googleConnectBusy, setGoogleConnectBusy] = useState(false);
  const [googleDisconnectId, setGoogleDisconnectId] = useState('');
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progressName, setProgressName] = useState('');
  const [shareItem, setShareItem] = useState(null);
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [vaultKey, setVaultKey] = useState(null);
  const [vaultPassphrase, setVaultPassphrase] = useState('');
  const [vaultPassphraseConfirm, setVaultPassphraseConfirm] = useState('');
  const [showVaultPassphrase, setShowVaultPassphrase] = useState(false);
  const [showVaultPassphraseConfirm, setShowVaultPassphraseConfirm] = useState(false);
  const [showNewVaultPassphrase, setShowNewVaultPassphrase] = useState(false);
  const [showNewVaultPassphraseConfirm, setShowNewVaultPassphraseConfirm] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsHubOpen, setSettingsHubOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [currentVaultPassphrase, setCurrentVaultPassphrase] = useState('');
  const [newVaultPassphrase, setNewVaultPassphrase] = useState('');
  const [newVaultPassphraseConfirm, setNewVaultPassphraseConfirm] = useState('');
  const [rotationBusy, setRotationBusy] = useState(false);
  const [rotationProgress, setRotationProgress] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewName, setPreviewName] = useState('');
  const [renameItem, setRenameItem] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [openingVideoId, setOpeningVideoId] = useState(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [copyFile, setCopyFile] = useState(null);
  const [incomingShare] = useState(() => parseIncomingShare());
  const [incomingShareLoading, setIncomingShareLoading] = useState(false);
  const [incomingShareVideoUrl, setIncomingShareVideoUrl] = useState('');
  const [incomingShareFile, setIncomingShareFile] = useState(null);
  const [incomingShareError, setIncomingShareError] = useState('');
  const [thumbnails, setThumbnails] = useState({});
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountName, setAccountName] = useState(session?.user?.user_metadata?.display_name || '');
  const [accountEmail, setAccountEmail] = useState('');
  const [currentAccountPassword, setCurrentAccountPassword] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [confirmAccountPassword, setConfirmAccountPassword] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [activity, setActivity] = useState([]);
  const [shares, setShares] = useState([]);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted');
  const [nowTick, setNowTick] = useState(() => Date.now());
  const notifiedShareIds = useRef(new Set());
  const videoElementRef = useRef(null);
  const uploadInputRef = useRef(null);
  const uploadDestinationRef = useRef('backblaze');

  useEffect(() => {
    const clock = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/vault-sw.js', { scope: '/' }).catch(error => {
        console.warn('Service worker Vault non disponibile:', error);
      });
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const driveStatus = params.get('drive');
    const driveError = params.get('drive_error');
    if (driveStatus === 'connected') {
      setMessage('Account Google Drive collegato. Ora puoi sceglierlo come destinazione dei nuovi video.');
    }
    if (driveError) setError(driveError);
    if (driveStatus || driveError) {
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!incomingShare) return;
    let active = true;
    let objectUrl = '';
    (async () => {
      setIncomingShareLoading(true);
      setIncomingShareError('');
      try {
        const response = await fetch(incomingShare.url);
        if (!response.ok) {
          if ([400, 401, 403, 404].includes(response.status)) throw new Error('Questo link è scaduto o il video non è più disponibile.');
          throw new Error('Non riesco a scaricare il video condiviso. Riprova tra poco.');
        }
        const encrypted = await response.blob();
        const key = await crypto.subtle.importKey('raw', base64ToBytes(incomingShare.key), { name: 'AES-GCM' }, false, ['decrypt']);
        const decrypted = await decryptVideo(encrypted, key, incomingShare.mime);
        const file = new File([decrypted], incomingShare.name, { type: incomingShare.mime });
        objectUrl = URL.createObjectURL(decrypted);
        if (active) {
          setIncomingShareFile(file);
          setIncomingShareVideoUrl(objectUrl);
        }
      } catch (e) {
        if (active) setIncomingShareError(e.message || 'Link non valido o video non disponibile.');
      } finally {
        if (active) setIncomingShareLoading(false);
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [incomingShare]);

  const loadVideos = useCallback(async () => {
    if (!session?.user?.id || !vaultKey) return;
    setLoadingVideos(true);
    setError('');
    let entries = [];
    try {
      entries = await b2ListAll(session);
    } catch (listError) {
      setError('Non riesco a caricare i video da Backblaze: ' + listError.message);
    }
    const metadataPaths = [
      ...entries.map(item => item.path || (session.user.id + '/' + item.name)),
    ];
    const b2Items = entries.map(item => {
      const path = item.path || (session.user.id + '/' + item.name);
      return {
        ...item,
        id: 'b2-' + item.id,
        path,
        provider: 'backblaze',
        providerLabel: 'Backblaze B2',
        encrypted: item.name.endsWith('.vlt'),
        displayName: getDisplayName(item.name),
        size: item.metadata?.size || 0,
        mime: item.name.endsWith('.vlt') ? getOriginalVideoMime(item.name) : (item.metadata?.mimetype || ''),
      };
    });

    let driveRows = [];
    let connectedAccounts = [];
    let driveQuotaResult = null;
    try {
      const accountsResult = await googleRequest(session, { action: 'accounts' });
      connectedAccounts = accountsResult.data || [];
      setGoogleDriveError('');
      for (const account of connectedAccounts) {
        try {
          const listResult = await googleRequest(session, { action: 'list', accountId: account.id });
          const accountFiles = (listResult.data || [])
            .filter(file => file.name?.endsWith('.vlt'))
            .map(file => ({
              id: 'google-' + account.id + '-' + file.id,
              fileId: file.id,
              accountId: account.id,
              accountEmail: account.email,
              path: 'google:' + account.id + ':' + file.id,
              name: file.name,
              displayName: getDisplayName(file.name),
              size: Number(file.size || 0),
              created_at: file.created_at,
              mime: getOriginalVideoMime(file.name),
              encrypted: true,
              provider: 'google',
              providerLabel: 'Google Drive · ' + account.email,
            }));
          driveRows.push(...accountFiles);
          try {
            const quota = await googleRequest(session, { action: 'quota', accountId: account.id });
            driveQuotaResult = quota.data || null;
            account.quotaError = '';
          } catch (quotaError) {
            account.quotaError = quotaError.message || 'Autorizzazione aggiuntiva necessaria per leggere lo spazio Drive.';
          }
          account.status = 'connected';
          account.error = '';
        } catch (accountError) {
          account.status = 'error';
          account.error = accountError.message || 'Ricollega questo account Google.';
          setGoogleDriveError(accountError.message || 'Un account Google deve essere ricollegato.');
        }
      }
    } catch (driveError) {
      setGoogleDriveError(driveError.message || 'Google Drive non è momentaneamente disponibile.');
    }
    const allItems = [...b2Items, ...driveRows];
    const allMetadataPaths = allItems.map(item => metadataStoragePath(session.user.id, item.path));
    try {
      const metadataMap = await loadEncryptedVideoMetadata(session.user.id, allMetadataPaths, vaultKey);
      for (const item of allItems) {
        const metadata = metadataMap.get(metadataStoragePath(session.user.id, item.path));
        if (metadata) {
          item.displayName = metadata.name;
          item.mime = metadata.mime;
          item.encryptedMetadata = true;
        }
      }
    } catch (metadataError) {
      console.warn('Metadati cifrati non disponibili; uso i nomi legacy:', metadataError);
    }
    setGoogleAccounts(connectedAccounts);
    setGoogleDriveQuota(driveQuotaResult);
    setVideos(allItems);

    try {
      const quotaResult = await b2Request(session, { action: 'quota' });
      setStorageQuota(quotaResult.data || null);
    } catch (quotaError) {
      console.warn('Contatore spazio Vault non aggiornato:', quotaError);
      setStorageQuota(null);
    }
    setLoadingVideos(false);
  }, [session, vaultKey]);

  useEffect(() => {
    if (session && vaultKey) loadVideos();
    else {
      setVideos([]);
      setStorageQuota(null);
      setGoogleAccounts([]);
      setGoogleDriveQuota(null);
      setGoogleDriveError('');
    }
  }, [session, vaultKey, loadVideos]);

  useEffect(() => {
    if (session?.user?.id) {
      setAccountName(session.user.user_metadata?.display_name || '');
      setAccountEmail(session.user.email || '');
      loadSecurityData();
    } else {
      setShares([]);
      setActivity([]);
    }
  }, [session?.user?.id]);

  async function handleAuth(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    setAuthBusy(true);
    try {
      if (mode === 'signup') {
        if (vaultPassphrase.length < 12) throw new Error('La frase segreta deve contenere almeno 12 caratteri.');
        if (vaultPassphrase !== vaultPassphraseConfirm) throw new Error('Le due frasi segrete non coincidono.');
        const { data, error: signError } = await supabase.auth.signUp({ email: email.trim(), password });
        if (signError) throw signError;
        if (data.session && data.user?.id) {
          setVaultKey(await deriveVaultKey(vaultPassphrase, data.user.id));
          setVaultPassphrase(''); setVaultPassphraseConfirm('');
          setMessage('Account creato e cassaforte inizializzata. Conserva la frase segreta: non è recuperabile.');
        } else {
          setVaultPassphraseConfirm('');
          setMessage('Account creato. Conferma l’email, poi accedi e inserisci la stessa frase segreta: non viene conservata durante la conferma.');
        }
      } else {
        const { data: signInData, error: signError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signError) throw signError;
        if (signInData.user?.id) await logActivity(signInData.user.id, 'login', null, getDeviceLabel());
      }
    } catch (e) {
      setError(e.message || 'Non è stato possibile completare l’accesso.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleReset() {
    if (!email.trim()) {
      setError('Inserisci prima la tua email.');
      return;
    }
    setError('');
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim());
    if (resetError) setError(resetError.message);
    else setMessage('Se l’indirizzo è registrato, riceverai un’email per reimpostare la password.');
  }

  async function unlockVault(event) {
    event.preventDefault();
    if (vaultPassphrase.length < 12) { setError('Usa una frase segreta di almeno 12 caratteri.'); return; }
    setUnlockBusy(true); setError('');
    try {
      const candidateKey = await deriveVaultKey(vaultPassphrase, session.user.id);
      // Se esiste almeno un video cifrato, verifica la frase prima di sbloccare la libreria.
      // Usa il file più piccolo per limitare il download necessario alla verifica.
      const entries = await b2ListAll(session);
      const sample = entries
        .filter(item => item.name?.endsWith('.vlt'))
        .sort((a, b) => (a.metadata?.size || 0) - (b.metadata?.size || 0))[0];
      if (sample) {
        const samplePath = sample.path || (session.user.id + '/' + sample.name);
        const encryptedSample = await b2Download(session, samplePath);
        await decryptVideo(encryptedSample, candidateKey, getOriginalVideoMime(sample.name));
      }
      setVaultKey(candidateKey);
      setVaultPassphrase('');
      await logActivity(session.user.id, 'vault_unlocked', null, 'Cassaforte sbloccata da questo dispositivo');
    } catch (unlockError) {
      setVaultPassphrase('');
      if (unlockError?.name === 'OperationError') {
        setError('Frase segreta errata. Inseriscila nuovamente per sbloccare Vault.');
      } else {
        setError('Non riesco a verificare la frase segreta. Controlla la connessione e riprova.');
      }
    } finally {
      setUnlockBusy(false);
    }
  }

  async function changeVaultPassphrase(event) {
    event.preventDefault();
    if (!vaultKey || !session?.user?.id) return;
    if (!currentVaultPassphrase) { setError('Inserisci la frase segreta attuale.'); return; }
    const enteredOldKey = await deriveVaultKey(currentVaultPassphrase, session.user.id);
    const [enteredOldRaw, activeRaw] = await Promise.all([crypto.subtle.exportKey('raw', enteredOldKey), crypto.subtle.exportKey('raw', vaultKey)]);
    const enteredBytes = new Uint8Array(enteredOldRaw); const activeBytes = new Uint8Array(activeRaw);
    if (enteredBytes.some((byte, index) => byte !== activeBytes[index])) { setError('La frase segreta attuale non è corretta.'); return; }
    if (newVaultPassphrase.length < 12) { setError('La nuova frase deve contenere almeno 12 caratteri.'); return; }
    if (newVaultPassphrase !== newVaultPassphraseConfirm) { setError('Le due nuove frasi non coincidono.'); return; }
    if (newVaultPassphrase === currentVaultPassphrase) { setError('Scegli una frase diversa da quella attuale.'); return; }
    if (!window.confirm('Vault creerà nuove copie cifrate su ciascuno spazio, verificherà i file e solo dopo eliminerà gli originali. I link temporanei attivi verranno revocati. Tieni aperta la pagina fino al termine. Vuoi continuare?')) return;

    setRotationBusy(true);
    setRotationProgress('Preparazione della nuova chiave…');
    setError('');
    const stagedItems = [];
    let replacementStarted = false;
    let pendingNewKey = null;
    try {
      setRotationProgress('Revoca dei link temporanei…');
      const { data: activeShares, error: activeSharesError } = await supabase
        .from('vault_shares')
        .select('id,storage_path')
        .eq('user_id', session.user.id)
        .is('revoked_at', null);
      if (activeSharesError) throw new Error('Non riesco a controllare i link temporanei: ' + activeSharesError.message);
      if (activeShares?.length) {
        await b2DeleteShareCopies(session, activeShares.map(share => share.storage_path));
        const { error: markSharesError } = await supabase
          .from('vault_shares')
          .update({ revoked_at: new Date().toISOString() })
          .in('id', activeShares.map(share => share.id));
        if (markSharesError) console.warn('Copie dei link rimosse, ma alcuni record non sono stati aggiornati:', markSharesError.message);
      }

      const newKey = await deriveVaultKey(newVaultPassphrase, session.user.id);
      pendingNewKey = newKey;
      const allItems = [];
      const b2Entries = await b2ListAll(session);
      for (const item of b2Entries) {
        allItems.push({
          provider: 'backblaze',
          name: item.name,
          path: item.path || (session.user.id + '/' + item.name),
          displayName: getDisplayName(item.name),
          mime: item.name.endsWith('.vlt') ? getOriginalVideoMime(item.name) : (item.metadata?.mimetype || 'video/mp4'),
          encrypted: item.name.endsWith('.vlt'),
          size: Number(item.metadata?.size || 0),
        });
      }

      const accountsResult = await googleRequest(session, { action: 'accounts' });
      const accounts = accountsResult.data || [];
      for (const account of accounts) {
        const listResult = await googleRequest(session, { action: 'list', accountId: account.id });
        for (const item of (listResult.data || []).filter(file => file.name?.endsWith('.vlt'))) {
          allItems.push({
            provider: 'google',
            accountId: account.id,
            fileId: item.id,
            name: item.name,
            path: 'google:' + account.id + ':' + item.id,
            displayName: getDisplayName(item.name),
            mime: getOriginalVideoMime(item.name),
            encrypted: true,
            size: Number(item.size || 0),
          });
        }
      }

      const passphraseMetadata = await loadEncryptedVideoMetadata(
        session.user.id,
        allItems.map(item => metadataStoragePath(session.user.id, item.path)),
        vaultKey
      );
      for (const item of allItems) {
        const metadata = passphraseMetadata.get(metadataStoragePath(session.user.id, item.path));
        if (metadata) {
          item.displayName = metadata.name;
          item.mime = metadata.mime;
        }
      }

      if (!allItems.length) {
        setVaultKey(newKey);
        setCurrentVaultPassphrase('');
        setSettingsOpen(false);
        await logActivity(session.user.id, 'vault_passphrase_changed', null, 'Frase segreta aggiornata: link temporanei revocati');
        await loadSecurityData();
        setMessage('Frase segreta aggiornata. La cassaforte era vuota.');
      } else {
        for (let index = 0; index < allItems.length; index++) {
          const item = allItems[index];
          setRotationProgress('Cifratura e verifica ' + (index + 1) + ' di ' + allItems.length + ': ' + item.displayName);
          const data = item.provider === 'google'
            ? await googleDownload(session, item.accountId, item.fileId, item.size)
            : await b2Download(session, item.path);
          const plain = item.encrypted ? await decryptVideo(data, vaultKey, item.mime) : data;
          const encrypted = await encryptVideo(plain, newKey);
          await decryptVideo(encrypted, newKey, item.mime);
          const newName = crypto.randomUUID() + '.vlt';

          if (item.provider === 'google') {
            const saved = await googleUpload(session, item.accountId, newName, encrypted);
            const newMetadataPath = 'google:' + item.accountId + ':' + saved.id;
            await saveEncryptedVideoMetadata(session.user.id, metadataStoragePath(session.user.id, newMetadataPath), { name: item.displayName, mime: item.mime }, newKey);
            stagedItems.push({ provider: 'google', accountId: item.accountId, fileId: saved.id, metadataPath: metadataStoragePath(session.user.id, newMetadataPath) });
            const savedCopy = await googleDownload(session, item.accountId, saved.id, saved.size);
            await decryptVideo(savedCopy, newKey, item.mime);
          } else {
            const newPath = session.user.id + '/Vault/' + newName;
            await b2Upload(session, newPath, encrypted);
            await saveEncryptedVideoMetadata(session.user.id, newPath, { name: item.displayName, mime: item.mime }, newKey);
            stagedItems.push({ provider: 'backblaze', path: newPath, metadataPath: newPath });
            const savedCopy = await b2Download(session, newPath);
            await decryptVideo(savedCopy, newKey, item.mime);
          }
        }

        setRotationProgress('Tutti i nuovi video sono verificati. Sostituzione degli originali…');
        replacementStarted = true;
        const oldB2Paths = allItems.filter(item => item.provider === 'backblaze').map(item => item.path);
        if (oldB2Paths.length) await b2Delete(session, oldB2Paths);
        if (oldB2Paths.length) await supabase.from('vault_video_meta').delete().eq('user_id', session.user.id).in('storage_path', oldB2Paths);
        for (const account of accounts) {
          const oldGoogleIds = allItems
            .filter(item => item.provider === 'google' && item.accountId === account.id)
            .map(item => item.fileId);
          for (const fileId of oldGoogleIds) {
            await googleRequest(session, { action: 'delete', accountId: account.id, fileId });
          }
          const oldGooglePaths = allItems.filter(item => item.provider === 'google' && item.accountId === account.id).map(item => metadataStoragePath(session.user.id, item.path));
          if (oldGooglePaths.length) await supabase.from('vault_video_meta').delete().eq('user_id', session.user.id).in('storage_path', oldGooglePaths);
        }
        setVaultKey(newKey);
        setSettingsOpen(false);
        await logActivity(session.user.id, 'vault_passphrase_changed', null, 'Frase segreta aggiornata: tutti i video cifrati su Backblaze e Google Drive sono stati verificati e ricifrati; link temporanei revocati');
        await loadSecurityData();
        setMessage('Frase segreta aggiornata. Tutti i video sono stati ricifrati e verificati nei rispettivi spazi.');
      }
      setCurrentVaultPassphrase('');
      setNewVaultPassphrase('');
      setNewVaultPassphraseConfirm('');
      setVaultPassphrase('');
    } catch (e) {
      if (!replacementStarted && stagedItems.length) {
        for (const item of stagedItems) {
          try {
            if (item.provider === 'google') {
              await googleRequest(session, { action: 'delete', accountId: item.accountId, fileId: item.fileId });
              if (item.metadataPath) await supabase.from('vault_video_meta').delete().eq('user_id', session.user.id).eq('storage_path', item.metadataPath);
            } else {
              await b2Delete(session, [item.path]);
              if (item.metadataPath) await supabase.from('vault_video_meta').delete().eq('user_id', session.user.id).eq('storage_path', item.metadataPath);
            }
          } catch (cleanupError) {
            console.error('Pulizia della copia temporanea non riuscita:', cleanupError);
          }
        }
      }
      if (replacementStarted && pendingNewKey) {
        // Tutte le nuove copie sono state verificate prima di iniziare a rimuovere gli originali.
        // Attivare la nuova chiave mantiene accessibile l'archivio anche se una vecchia copia non è stata eliminata.
        setVaultKey(pendingNewKey);
        setSettingsOpen(false);
        setNewVaultPassphrase('');
        setNewVaultPassphraseConfirm('');
        setVaultPassphrase('');
        setMessage('La nuova frase segreta è attiva e tutte le nuove copie sono state verificate. Alcune vecchie copie potrebbero essere ancora presenti: controlla lo spazio e la libreria.');
      }
      const recoveryNote = replacementStarted
        ? ' La nuova frase è attiva sulle copie verificate; controlla se sono rimaste vecchie copie da eliminare.'
        : ' I video originali sono stati mantenuti.';
      setError('Modifica della frase non completata: ' + (e.message || 'errore sconosciuto') + recoveryNote);
    } finally {
      setRotationBusy(false);
      setRotationProgress('');
      await loadVideos();
    }
  }

  async function handleLogout() {
    if (!window.confirm('Vuoi davvero uscire dal tuo account Vault?')) return;
    setVaultKey(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(''); setPreviewName('');
    await supabase.auth.signOut({ scope: 'local' });
    setShareItem(null);
    setShareUrl('');
  }


  async function connectGoogleDrive() {
    if (!session?.user?.id || googleConnectBusy) return;
    setGoogleConnectBusy(true);
    setGoogleDriveError('');
    try {
      const result = await googleRequest(session, { action: 'connect' });
      if (!result.url) throw new Error('Google non ha restituito il link di autorizzazione.');
      window.location.assign(result.url);
    } catch (connectError) {
      setGoogleDriveError(connectError.message || 'Non riesco ad avviare il collegamento Google.');
      setGoogleConnectBusy(false);
    }
  }

  async function disconnectGoogleDrive(account) {
    if (!account?.id || googleDisconnectId) return;
    const confirmed = window.confirm(
      'Vuoi scollegare ' + account.email + ' da Vault? I video resteranno nel suo Google Drive, ma non saranno più visibili in Vault finché non ricollegherai lo stesso account.'
    );
    if (!confirmed) return;
    setGoogleDisconnectId(account.id);
    setGoogleDriveError('');
    try {
      await googleRequest(session, { action: 'disconnect', accountId: account.id });
      setGoogleAccounts(current => current.filter(row => row.id !== account.id));
      if (storageDestination === 'google:' + account.id) setStorageDestination('backblaze');
      setMessage('Account Google scollegato. I file originali sono rimasti nel Google Drive.');
      await loadVideos();
    } catch (disconnectError) {
      setGoogleDriveError(disconnectError.message || 'Non riesco a scollegare l’account Google.');
    } finally {
      setGoogleDisconnectId('');
    }
  }

  function openUploadDestination() {
    setError('');
    setUploadDestinationOpen(true);
  }

  function chooseUploadDestination(destination) {
    if (destination.startsWith('google:')) {
      const accountId = destination.slice('google:'.length);
      const account = googleAccounts.find(row => row.id === accountId);
      if (!account || account.status === 'error') {
        setError('Questo account Google non è disponibile. Controlla il collegamento nelle impostazioni di archiviazione.');
        return;
      }
    }
    uploadDestinationRef.current = destination;
    setStorageDestination(destination);
    setUploadDestinationOpen(false);
    // Aprire il selettore nello stesso gesto dell'utente è necessario su Safari/iOS.
    uploadInputRef.current?.click();
  }

  async function handleUpload(event) {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    if (!selected.length || !session?.user?.id) return;
    const invalid = selected.find(file => !file.type.startsWith('video/'));
    if (invalid) {
      setError('Puoi caricare soltanto file video.');
      return;
    }
    if (!vaultKey) { setError('Sblocca prima la cassaforte con la tua frase segreta.'); return; }
    const selectedDestination = uploadDestinationRef.current || storageDestination;
    const isGoogleDestination = selectedDestination.startsWith('google:');
    const googleAccountId = isGoogleDestination ? selectedDestination.slice('google:'.length) : '';
    const googleAccount = isGoogleDestination ? googleAccounts.find(account => account.id === googleAccountId) : null;
    if (isGoogleDestination && !googleAccount) {
      setError('Seleziona un account Google Drive collegato e disponibile.');
      return;
    }
    if (isGoogleDestination && googleAccount.status === 'error') {
      setError('Questo account Google deve essere ricollegato prima di poter caricare video.');
      return;
    }

    setUploading(true);
    setError('');
    const uploadedDriveItems = [];
    for (const file of selected) {
      setProgressName(file.name);
      const storedName = crypto.randomUUID() + '.vlt';
      const path = session.user.id + '/Vault/' + storedName;
      try {
        const encrypted = await encryptVideo(file, vaultKey);
        if (isGoogleDestination) {
          const saved = await googleUpload(session, googleAccountId, storedName, encrypted);
          const drivePath = 'google:' + googleAccountId + ':' + saved.id;
          await saveEncryptedVideoMetadata(session.user.id, metadataStoragePath(session.user.id, drivePath), { name: file.name, mime: file.type || 'video/mp4' }, vaultKey);
          uploadedDriveItems.push({
            id: 'google-' + googleAccountId + '-' + saved.id,
            fileId: saved.id,
            accountId: googleAccountId,
            accountEmail: googleAccount.email,
            path: drivePath,
            name: saved.name || storedName,
            displayName: getDisplayName(saved.name || storedName),
            size: Number(saved.size || encrypted.size),
            created_at: saved.created_at || new Date().toISOString(),
            mime: getOriginalVideoMime(storedName),
            encrypted: true,
            provider: 'google',
            providerLabel: 'Google Drive · ' + googleAccount.email,
          });
          await logActivity(session.user.id, 'video_uploaded', file.name, 'Video cifrato sul dispositivo e salvato su Google Drive · ' + googleAccount.email);
        } else {
          await b2Upload(session, path, encrypted);
          await saveEncryptedVideoMetadata(session.user.id, path, { name: file.name, mime: file.type || 'video/mp4' }, vaultKey);
          await logActivity(session.user.id, 'video_uploaded', file.name, 'Video cifrato sul dispositivo e salvato su Backblaze B2');
        }
      } catch (uploadError) {
        setError('Errore durante la cifratura o il caricamento di ' + file.name + ': ' + (uploadError.message || 'errore sconosciuto'));
        break;
      }
    }
    setUploading(false);
    setProgressName('');
    await loadVideos();
    if (uploadedDriveItems.length) {
      setVideos(current => {
        const byId = new Map(current.map(item => [item.id, item]));
        uploadedDriveItems.forEach(item => byId.set(item.id, item));
        return Array.from(byId.values());
      });
    }
  }

  async function openEncryptedVideo(item) {
    if (!vaultKey || openingVideoId) return;
    setOpeningVideoId(item.id);
    setError('');
    try {
      const encryptedBlob = item.provider === 'google'
        ? await googleDownload(session, item.accountId, item.fileId, item.size)
        : await b2Download(session, item.path);
      if (!encryptedBlob || typeof encryptedBlob.arrayBuffer !== 'function') throw new Error('Lo spazio di archiviazione non ha restituito un file valido.');
      const decrypted = await decryptVideo(encryptedBlob, vaultKey, item.mime);
      createVideoPoster(decrypted).then(poster => { if (poster) setThumbnails(current => ({ ...current, [item.path]: poster })); }).catch(() => {});
      await logActivity(session.user.id, 'video_opened', item.displayName || getDisplayName(item.name), 'Video aperto nella libreria privata');
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(decrypted);
      setPreviewUrl(url);
      setPreviewName(item.displayName || getDisplayName(item.name));
    } catch (e) {
      const detail = e?.name === 'OperationError'
        ? 'La decifratura non è riuscita. Controlla di aver inserito la stessa frase segreta usata quando hai caricato il video.'
        : (e?.message || 'Errore sconosciuto durante l’apertura.');
      setError(detail);
    } finally {
      setOpeningVideoId(null);
    }
  }

  function beginRename(item) {
    setRenameItem(item);
    setRenameValue((item.displayName || getDisplayName(item.name)).replace(/\.[^.]+$/, ''));
    setError('');
  }

  async function saveRename(event) {
    event.preventDefault();
    if (!renameItem || !session?.user?.id) return;
    const clean = renameValue.trim().normalize('NFKC').replace(/[\/\\]/g, '-').replace(/[<>:"|?*]/g, '-').replace(/\s+/g, ' ').slice(0, 100);
    if (!clean) { setError('Inserisci un nome valido.'); return; }
    if (!renameItem.encrypted) { setError('Puoi rinominare solo i video cifrati.'); return; }
    const oldDisplay = renameItem.displayName || getDisplayName(renameItem.name);
    const extMatch = oldDisplay.match(/(\.[^.]+)$/);
    const extension = extMatch ? extMatch[1] : '';
    const newName = crypto.randomUUID() + '.vlt';
    const newPath = renameItem.provider === 'google' ? renameItem.path : session.user.id + '/Vault/' + newName;
    setRenameBusy(true); setError('');
    try {
      if (renameItem.provider === 'google') {
        await googleRequest(session, { action: 'rename', accountId: renameItem.accountId, fileId: renameItem.fileId, name: newName });
      } else {
        await b2Move(session, renameItem.path, newPath);
      }
    } catch (moveError) {
      setRenameBusy(false);
      setError('Non sono riuscito a rinominare il video: ' + moveError.message);
      return;
    }
    setRenameBusy(false);
    try {
      await saveEncryptedVideoMetadata(session.user.id, metadataStoragePath(session.user.id, newPath), { name: clean + extension, mime: renameItem.mime || 'video/mp4' }, vaultKey);
      if (renameItem.path !== newPath) {
        await supabase.from('vault_video_meta').delete().eq('user_id', session.user.id).eq('storage_path', metadataStoragePath(session.user.id, renameItem.path));
      }
    } catch (metadataError) {
      setError('Video rinominato, ma i metadati cifrati non sono stati aggiornati: ' + metadataError.message);
    }
    const { error: sharesMoveError } = await supabase.from('vault_shares').update({ original_path: newPath, file_name: clean + extension }).eq('user_id', session.user.id).eq('original_path', renameItem.path).is('revoked_at', null);
    if (sharesMoveError) setError('Video rinominato, ma non ho aggiornato il collegamento dei link già creati: ' + sharesMoveError.message);
    await logActivity(session.user.id, 'video_renamed', clean, 'Video rinominato');
    setRenameItem(null); setRenameValue('');
    await loadVideos();
  }

  async function requestVideoFullscreen() {
    const video = videoElementRef.current;
    if (!video) return;
    try {
      if (video.requestFullscreen) await video.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    } catch { setError('Schermo intero non disponibile in questo browser.'); }
  }

  function createShare(item) {
    setError('');
    setShareItem(item);
    setShareUrl('');
    setCopied(false);
    setCopyFile(null);
    setShareBusy(false);
  }

  async function createTemporaryLink() {
    if (!shareItem || !session?.user?.id) return;
    setShareBusy(true);
    setError('');
    let sharePath = '';
    let shareRecordId = '';
    try {
      const shareId = crypto.randomUUID();
      sharePath = session.user.id + '/_shares/' + shareId + '/video' + (shareItem.encrypted ? '.vlt' : '.bin');
      if (shareItem.provider === 'google') {
        const encryptedSource = await googleDownload(session, shareItem.accountId, shareItem.fileId, shareItem.size);
        await b2Upload(session, sharePath, encryptedSource);
      } else {
        await b2Copy(session, shareItem.path, sharePath);
      }
      const expiresAt = new Date(Date.now() + SHARE_SECONDS * 1000).toISOString();
      const signedUrl = await b2SignedUrl(session, sharePath, SHARE_SECONDS);
      const { data: shareRecord, error: recordError } = await supabase.from('vault_shares').insert({
        user_id: session.user.id, original_path: shareItem.path, storage_path: sharePath,
        file_name: shareItem.displayName || getDisplayName(shareItem.name), expires_at: expiresAt
      }).select('id').single();
      if (recordError) throw recordError;
      shareRecordId = shareRecord?.id || '';
      let url = signedUrl;
      if (shareItem.encrypted) {
        if (!vaultKey) throw new Error('Sblocca nuovamente Vault per creare il link.');
        const rawKey = await crypto.subtle.exportKey('raw', vaultKey);
        const payload = {
          url,
          key: bytesToBase64(new Uint8Array(rawKey)),
          mime: shareItem.mime || 'video/mp4',
          name: shareItem.displayName || getDisplayName(shareItem.name)
        };
        url = window.location.origin + window.location.pathname + '#share=' + encodeURIComponent(JSON.stringify(payload));
      }
      setShareUrl(url);
      await logActivity(session.user.id, 'share_created', shareItem.displayName || getDisplayName(shareItem.name), 'Creato link temporaneo con copia separata revocabile');
      await loadSecurityData();
      await loadVideos();
    } catch (e) {
      if (shareRecordId) await supabase.from('vault_shares').delete().eq('id', shareRecordId).eq('user_id', session.user.id);
      if (sharePath) await b2Delete(session, [sharePath]);
      setError('Non sono riuscito a creare il link: ' + (e.message || 'errore sconosciuto'));
    } finally {
      setShareBusy(false);
    }
  }

  async function prepareCopy() {
    if (!shareItem) return;
    setShareBusy(true);
    setError('');
    try {
      const data = shareItem.provider === 'google'
        ? await googleDownload(session, shareItem.accountId, shareItem.fileId, shareItem.size)
        : await b2Download(session, shareItem.path);
      const content = shareItem.encrypted ? await decryptVideo(data, vaultKey, shareItem.mime) : data;
      const filename = shareItem.displayName || getDisplayName(shareItem.name);
      setCopyFile(new File([content], filename, { type: shareItem.mime || content.type || 'video/mp4' }));
    } catch (e) {
      setError('Non sono riuscito a preparare la copia: ' + (e.message || 'errore sconosciuto'));
    } finally {
      setShareBusy(false);
    }
  }

  async function shareFileToDevice(file) {
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ files: [file], title: file.name });
      return;
    }
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function sendPreparedCopy() {
    if (!copyFile) return;
    try {
      await shareFileToDevice(copyFile);
    } catch (e) {
      if (e.name !== 'AbortError') setError('Non è stato possibile condividere la copia: ' + (e.message || 'errore sconosciuto'));
    }
  }

  async function copyShare() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setError('Copia automatica non disponibile: seleziona e copia il link.');
    }
  }

  async function deleteVideo(item) {
    if (!window.confirm('Vuoi eliminare definitivamente questo video? Verranno rimossi anche i link temporanei ancora attivi associati al file.')) return;
    const { data: linkedShares, error: sharesError } = await supabase.from('vault_shares').select('id,storage_path').eq('user_id', session.user.id).eq('original_path', item.path).is('revoked_at', null);
    if (sharesError) { setError('Non riesco a verificare i link attivi: ' + sharesError.message); return; }
    if (linkedShares?.length) {
      try { await b2DeleteShareCopies(session, linkedShares.map(row => row.storage_path)); }
      catch (shareDeleteError) { setError('Non riesco a revocare tutti i link collegati: ' + shareDeleteError.message); return; }
      await supabase.from('vault_shares').update({ revoked_at: new Date().toISOString() }).in('id', linkedShares.map(row => row.id));
    }
    try {
      if (item.provider === 'google') {
        await googleRequest(session, { action: 'delete', accountId: item.accountId, fileId: item.fileId });
      } else {
        await b2Delete(session, [item.path]);
      }
    } catch (deleteError) { setError(deleteError.message); return; }
    {
      await supabase.from('vault_video_meta').delete().eq('user_id', session.user.id).eq('storage_path', metadataStoragePath(session.user.id, item.path));
      await logActivity(session.user.id, 'video_deleted', item.displayName || getDisplayName(item.name), 'Video eliminato dalla libreria');
      setVideos(current => current.filter(v => v.id !== item.id));
      if (shareItem?.id === item.id) {
        setShareItem(null);
        setShareUrl('');
      }
      await loadSecurityData();
    }
  }

  async function logActivity(userId, eventType, itemName = null, details = null) {
    if (!userId) return;
    const { error: activityError } = await supabase.from('vault_activity').insert({ user_id: userId, event_type: eventType, item_name: itemName, details });
    if (activityError) console.warn('Registro attività non aggiornato:', activityError.message);
  }

  async function loadSecurityData() {
    if (!session?.user?.id) return;
    setSecurityLoading(true);
    const [shareResult, activityResult] = await Promise.all([
      supabase.from('vault_shares').select('*').eq('user_id', session.user.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('vault_activity').select('id,event_type,item_name,details,created_at').eq('user_id', session.user.id).order('created_at', { ascending: false }).limit(40)
    ]);
    if (shareResult.error || activityResult.error) {
      setError('Non riesco a caricare il centro sicurezza: ' + (shareResult.error || activityResult.error).message);
    } else {
      let shareRows = shareResult.data || [];
      const expiredPending = shareRows.filter(row => !row.revoked_at && new Date(row.expires_at).getTime() <= Date.now());
      if (expiredPending.length) {
        let cleanupError = null;
        try { await b2DeleteShareCopies(session, expiredPending.map(row => row.storage_path)); } catch (e) { cleanupError = e; }
        if (!cleanupError) {
          const { error: markError } = await supabase.from('vault_shares').update({ revoked_at: new Date().toISOString() }).in('id', expiredPending.map(row => row.id));
          if (!markError) shareRows = shareRows.map(row => expiredPending.some(expired => expired.id === row.id) ? { ...row, revoked_at: new Date().toISOString() } : row);
        } else {
          console.warn('Pulizia automatica dei link scaduti non riuscita:', cleanupError.message);
        }
      }
      setShares(shareRows);
      setActivity(activityResult.data || []);
    }
    setSecurityLoading(false);
  }

  async function revokeShare(share) {
    if (!window.confirm('Revocare questo link? Vault rimuoverà la copia temporanea condivisa. Chi ha già scaricato il video o ne ha conservato una copia non può essere disconnesso da remoto.')) return;
    try { await b2DeleteShareCopies(session, [share.storage_path]); }
    catch (removeError) { setError('Non riesco a rimuovere la copia condivisa: ' + removeError.message); return; }
    const { error: updateError } = await supabase.from('vault_shares').update({ revoked_at: new Date().toISOString() }).eq('id', share.id).eq('user_id', session.user.id);
    if (updateError) setError('Copia condivisa rimossa, ma registro non aggiornato: ' + updateError.message);
    await logActivity(session.user.id, 'share_revoked', share.file_name, 'Link temporaneo revocato e copia condivisa rimossa');
    await loadSecurityData();
    setMessage('Link revocato: la copia temporanea è stata rimossa. Le copie già scaricate non possono essere richiamate.');
  }

  async function saveAccountName() {
    const displayName = accountName.trim().slice(0, 60);
    setAccountBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ data: { ...(session.user.user_metadata || {}), display_name: displayName } });
    setAccountBusy(false);
    if (updateError) { setError('Non riesco a salvare il nome: ' + updateError.message); return; }
    setMessage('Nome profilo aggiornato.');
  }

  async function requestAccountEmailChange() {
    const nextEmail = accountEmail.trim().toLowerCase();
    if (!nextEmail || nextEmail === (session.user.email || '').toLowerCase()) { setError('Inserisci un indirizzo email diverso da quello attuale.'); return; }
    setAccountBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ email: nextEmail });
    setAccountBusy(false);
    if (updateError) { setError('Non riesco a richiedere il cambio email: ' + updateError.message); return; }
    await logActivity(session.user.id, 'email_change_requested', nextEmail, 'Richiesta di cambio email inviata');
    setMessage('Richiesta inviata. Controlla la posta e conferma il cambio secondo le istruzioni ricevute.');
  }

  async function updateAccountPassword() {
    if (!currentAccountPassword) { setError('Inserisci prima la password attuale.'); return; }
    if (newAccountPassword.length < 8) { setError('La nuova password deve contenere almeno 8 caratteri.'); return; }
    if (newAccountPassword !== confirmAccountPassword) { setError('Le nuove password non coincidono.'); return; }
    if (newAccountPassword === currentAccountPassword) { setError('La nuova password deve essere diversa da quella attuale.'); return; }
    setAccountBusy(true); setError('');
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email: session.user.email, password: currentAccountPassword });
    if (verifyError) { setAccountBusy(false); setError('La password attuale non è corretta.'); return; }
    const { error: updateError } = await supabase.auth.updateUser({ password: newAccountPassword });
    setAccountBusy(false);
    if (updateError) { setError('Non riesco ad aggiornare la password: ' + updateError.message); return; }
    setCurrentAccountPassword(''); setNewAccountPassword(''); setConfirmAccountPassword('');
    await logActivity(session.user.id, 'password_changed', null, 'Password account aggiornata');
    setMessage('Password aggiornata.');
  }

  async function signOutOtherSessions() {
    if (!window.confirm('Disconnettere tutti gli altri dispositivi che usano questo account? Questa sessione resterà attiva.')) return;
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' });
    if (signOutError) { setError('Non riesco a chiudere le altre sessioni: ' + signOutError.message); return; }
    await logActivity(session.user.id, 'other_sessions_signed_out', null, 'Richiesta revoca delle altre sessioni');
    setMessage('Richiesta completata: le altre sessioni sono state revocate. I token di accesso già emessi possono restare validi fino alla loro scadenza.');
    await loadSecurityData();
  }

  async function enableBrowserNotifications() {
    if (!('Notification' in window)) {
      setError('Questo browser non supporta le notifiche desktop.');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationsEnabled(permission === 'granted');
      setMessage(permission === 'granted'
        ? 'Notifiche locali attivate: Vault ti avviserà dei link in scadenza mentre il sito è aperto.'
        : 'Permesso notifiche non concesso. Puoi modificarlo dalle impostazioni del browser.');
    } catch {
      setError('Non è stato possibile richiedere il permesso notifiche.');
    }
  }

  const visibleVideos = useMemo(() => videos
    .filter(video => (video.displayName || video.name).toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)), [videos, search]);
  const securityAlerts = shares.filter(share => !share.revoked_at && new Date(share.expires_at).getTime() <= nowTick + 15 * 60 * 1000);
  useEffect(() => {
    if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    securityAlerts.forEach(share => {
      if (notifiedShareIds.current.has(share.id)) return;
      notifiedShareIds.current.add(share.id);
      const expired = new Date(share.expires_at).getTime() <= Date.now();
      try {
        new Notification(expired ? 'Link Vault scaduto' : 'Link Vault in scadenza', {
          body: expired ? share.file_name + ' · la copia temporanea sarà rimossa.' : share.file_name + ' · il link scade entro 15 minuti.',
          icon: '/vault-app-icon.svg',
          tag: 'vault-share-' + share.id
        });
      } catch (error) {
        console.warn('Notifica Vault non disponibile:', error);
      }
    });
  }, [notificationsEnabled, shares, nowTick]);
  const totalBytes = videos.filter(item => item.provider !== 'google').reduce((sum, item) => sum + item.size, 0);
  const formatSize = bytes => bytes < 1_000_000
    ? (bytes / 1_000).toFixed(0) + ' KB'
    : bytes < 1_000_000_000
      ? (bytes / 1_000_000).toFixed(1) + ' MB'
      : (bytes / 1_000_000_000).toFixed(2) + ' GB';
  const formatDate = value => value ? new Date(value).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

  if (incomingShare) return (
    <main className="auth-page incoming-share-page">
      <div className="auth-top"><div className="brand"><div className="brand-icon"><img src="/vault-logo.svg" alt=""/></div><span>VAULT</span></div><span className="top-note"><Clock3 size={14}/> LINK TEMPORANEO</span></div>
      <section className="auth-layout" style={{ display: 'flex', justifyContent: 'center' }}>
        <div className="auth-card incoming-share-card">
          <div className="card-lock"><ShieldCheck size={22}/></div>
          <div className="section-kicker">VIDEO CONDIVISO IN MODO SICURO</div>
          <h2>{incomingShare.name}</h2>
          {incomingShareLoading && <div className="incoming-share-status"><LoaderCircle className="spin" size={20}/> Sto preparando il video…</div>}
          {incomingShareError && <div className="notice error"><AlertCircle size={16}/>{incomingShareError}</div>}
          {incomingShareVideoUrl && <div className="recipient-video-wrap"><video src={incomingShareVideoUrl} controls playsInline style={{ width: '100%', maxHeight: '55vh', marginTop: 18, background: '#000', borderRadius: 10 }} /><div className="vault-watermark">VAULT · CONTENUTO RISERVATO</div></div>}
          {incomingShareVideoUrl && <div className="notice error capture-warning"><ShieldCheck size={16}/> Se questo video viene registrato, Vault lo verrà a sapere. Non registrare né redistribuire questo contenuto.</div>}
          <p className="share-expiry-copy">Questo link temporaneo scade dopo 60 minuti.</p>
        </div>
      </section>
    </main>
  );

  if (!authReady) return <div className="boot"><div className="vault-mark"><LockKeyhole size={25}/></div><LoaderCircle className="spin" size={20}/></div>;

  if (!session) return (
    <main className="auth-page">
      <div className="auth-glow" />
      <div className="auth-top"><div className="brand"><div className="brand-icon"><img src="/vault-logo.svg" alt=""/></div><span>VAULT</span></div><span className="top-note"><ShieldCheck size={14}/> Spazio privato</span></div>
      <section className="auth-layout">
        <div className="auth-copy">
          <div className="eyebrow"><span className="pulse-dot"/> LA TUA AREA RISERVATA</div>
          <h1>I tuoi ricordi.<br/><span>Al sicuro.</span></h1>
          <p>Una cassaforte digitale privata per conservare i tuoi video e condividerli solo quando lo decidi tu.</p>
          <div className="trust-line"><ShieldCheck size={17}/><span>Archivio privato · Accesso protetto · Link temporanei</span></div>
        </div>
        <div className="auth-card">
          <div className="card-lock"><LockKeyhole size={22}/></div>
          <h2>{mode === 'login' ? 'Bentornato' : 'Crea la tua cassaforte'}</h2>
          <p className="card-sub">{mode === 'login' ? 'Accedi al tuo spazio personale.' : 'Registra il tuo account personale.'}</p>
          <form onSubmit={handleAuth}>
            <label>Email</label>
            <div className="input-wrap"><Mail size={17}/><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="nome@email.com" autoComplete="email" required /></div>
            <label>Password</label>
            <div className="input-wrap"><KeyRound size={17}/><input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Almeno 8 caratteri" minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required/><button className="eye-btn" type="button" onClick={() => setShowPassword(v => !v)} aria-label="Mostra password">{showPassword ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div>
            {mode === 'signup' && <><label>Frase segreta di cifratura</label><div className="input-wrap"><KeyRound size={17}/><input type={showVaultPassphrase ? 'text' : 'password'} value={vaultPassphrase} onChange={e => setVaultPassphrase(e.target.value)} placeholder="Almeno 12 caratteri" minLength={12} autoComplete="new-password" required/><button className="eye-btn" type="button" onClick={() => setShowVaultPassphrase(v => !v)} aria-label="Mostra frase segreta">{showVaultPassphrase ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div><label>Conferma frase segreta</label><div className="input-wrap"><KeyRound size={17}/><input type={showVaultPassphraseConfirm ? 'text' : 'password'} value={vaultPassphraseConfirm} onChange={e => setVaultPassphraseConfirm(e.target.value)} placeholder="Ripeti la frase segreta" minLength={12} autoComplete="new-password" required/><button className="eye-btn" type="button" onClick={() => setShowVaultPassphraseConfirm(v => !v)} aria-label="Mostra conferma frase">{showVaultPassphraseConfirm ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div><p className="card-sub">Questa frase cifra i video. È diversa dalla password dell’account e non può essere recuperata se la dimentichi.</p></>}
            <button className="primary-btn auth-submit" disabled={authBusy}>{authBusy ? <LoaderCircle className="spin" size={18}/> : <>{mode === 'login' ? 'Entra nella cassaforte' : 'Crea account'} <ArrowUpRight size={17}/></>}</button>
          </form>
          {mode === 'login' && <button className="text-btn forgot" onClick={handleReset}>Hai dimenticato la password?</button>}
          <div className="auth-switch">{mode === 'login' ? 'Non hai ancora un account?' : 'Hai già un account?'} <button onClick={() => {setMode(mode === 'login' ? 'signup' : 'login');setError('');setMessage('');setVaultPassphrase('');setVaultPassphraseConfirm('');}}>{mode === 'login' ? 'Registrati' : 'Accedi'}</button></div>
          {error && <div className="notice error"><AlertCircle size={16}/>{error}</div>}
          {message && <div className="notice success"><Check size={16}/>{message}</div>}
          <div className="auth-foot"><LockKeyhole size={13}/> Le tue credenziali non vengono mostrate né condivise.</div>
        </div>
      </section>
      <footer className="page-foot">VAULT <span>·</span> PRIVATE VIDEO STORAGE</footer>
    </main>
  );

  if (!vaultKey) return (
    <main className="auth-page"><div className="auth-glow"/><div className="auth-top"><div className="brand"><div className="brand-icon"><img src="/vault-logo.svg" alt=""/></div><span>VAULT</span></div><button className="text-btn" onClick={handleLogout}>Esci</button></div><section className="auth-layout" style={{display:'flex',justifyContent:'center'}}><div className="auth-card" style={{width:'min(100%,440px)'}}><div className="card-lock"><KeyRound size={22}/></div><h2>Sblocca la cifratura</h2><p className="card-sub">Inserisci la tua frase segreta Vault. Non viene inviata né salvata sui server. Usa la stessa frase su ogni dispositivo.</p><form onSubmit={unlockVault}><label>Frase segreta (almeno 12 caratteri)</label><div className="input-wrap"><KeyRound size={17}/><input type={showVaultPassphrase ? 'text' : 'password'} value={vaultPassphrase} onChange={e => setVaultPassphrase(e.target.value)} autoComplete="off" minLength={12} required placeholder="La tua frase segreta"/><button className="eye-btn" type="button" onClick={() => setShowVaultPassphrase(v => !v)} aria-label="Mostra frase segreta">{showVaultPassphrase ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div><button className="primary-btn auth-submit" disabled={unlockBusy}>{unlockBusy ? <LoaderCircle className="spin" size={18}/> : 'Sblocca Vault'}</button></form>{error && <div className="notice error"><AlertCircle size={16}/>{error}</div>}<div className="auth-foot"><ShieldCheck size={13}/> Se dimentichi la frase segreta, i video cifrati non si possono recuperare.</div></div></section></main>
  );

  return (
    <main className="dashboard">
      <header className="dash-header">
        <div className="brand"><div className="brand-icon"><img src="/vault-logo.svg" alt=""/></div><span>VAULT</span></div>
        <div className="header-right"><span className="secure-pill"><span className="pulse-dot"/> ARCHIVIO PROTETTO</span><button className="icon-btn settings-gear-btn" onClick={() => {setError('');setMessage('');setSettingsHubOpen(true);}} title="Impostazioni" aria-label="Apri impostazioni"><Settings size={19}/></button><button className="icon-btn" onClick={handleLogout} title="Esci" aria-label="Esci"><LogOut size={18}/></button></div>
      </header>
      <section className="welcome">
        <div><div className="eyebrow"><span className="pulse-dot"/> IL TUO SPAZIO PERSONALE</div><h1>La tua <span>cassaforte.</span></h1><p>I nuovi video vengono cifrati sul dispositivo prima del caricamento.</p></div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',justifyContent:'flex-end'}}>
          
          <button className="upload-btn" type="button" onClick={openUploadDestination}><UploadCloud size={18}/> Carica video</button>
          <input ref={uploadInputRef} type="file" accept="video/*" multiple hidden onChange={handleUpload}/>
        </div>
      </section>
      <section className="stats">
        <div className="stat-card"><div className="stat-icon"><Film size={18}/></div><div><strong>{videos.length}</strong><span>Video archiviati</span></div></div>
        <div className="stat-card"><div className="stat-icon"><HardDrive size={18}/></div><div><strong>{formatSize(storageQuota?.usedBytes ?? totalBytes)} / {formatSize(storageQuota?.personalLimitBytes ?? 2_000_000_000)}</strong><span>Spazio Backblaze utilizzato</span></div></div>
        <div className="stat-card"><div className="stat-icon"><HardDrive size={18}/></div><div><strong>{googleDriveQuota?.limitBytes == null && googleDriveQuota ? 'Senza limite' : googleDriveQuota?.availableBytes != null ? formatSize(googleDriveQuota.availableBytes) : googleAccounts.length ? 'Aggiorna Google' : 'Non collegato'}</strong><span>Spazio disponibile su Google Drive</span></div></div>
      </section>

      {uploading && <div className="upload-progress"><LoaderCircle className="spin" size={17}/><div><b>Caricamento in corso</b><span>{progressName}</span></div></div>}
      {uploadDestinationOpen && <div className="modal-backdrop" onClick={() => setUploadDestinationOpen(false)}><div className="share-modal upload-destination-modal" onClick={event => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setUploadDestinationOpen(false)} aria-label="Chiudi"><X size={18}/></button><div className="modal-icon"><HardDrive size={21}/></div><div className="section-kicker">NUOVO CARICAMENTO</div><h2>Dove vuoi salvarlo?</h2><p>Scegli la destinazione per questo caricamento. Il video verrà cifrato sul dispositivo prima del trasferimento.</p><div className="upload-destination-options"><button className="upload-destination-option" type="button" onClick={() => chooseUploadDestination('backblaze')}><span className="upload-destination-icon"><ShieldCheck size={20}/></span><span><b>Backblaze B2</b><small>Spazio personale Vault</small></span><ArrowUpRight size={17}/></button>{googleAccounts.map(account => <button className="upload-destination-option" type="button" key={account.id} disabled={account.status === 'error'} onClick={() => chooseUploadDestination('google:' + account.id)}><span className="upload-destination-icon"><HardDrive size={20}/></span><span><b>Google Drive</b><small>{account.status === 'error' ? 'Account da ricollegare' : account.email}</small></span>{account.status === 'error' ? <AlertCircle size={17}/> : <ArrowUpRight size={17}/>}</button>)}</div>{googleAccounts.length === 0 && <button className="secondary-share-btn" type="button" onClick={() => {setUploadDestinationOpen(false);setStorageOpen(true);}}><HardDrive size={16}/> Collega Google Drive</button>}</div></div>}
      {error && <div className="notice error dashboard-notice"><AlertCircle size={16}/>{error}<button onClick={() => setError('')}><X size={15}/></button></div>}
      <section className="library">
        <div className="library-head"><div><div className="section-kicker">IL TUO ARCHIVIO</div><h2>I miei video <span>{visibleVideos.length}/{videos.length}</span></h2></div><div className="library-tools"><div className="search-box"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca un video…" aria-label="Cerca un video"/></div></div></div>
        {loadingVideos ? <div className="empty-state"><LoaderCircle className="spin" size={24}/><p>Sto aprendo la cassaforte…</p></div> : visibleVideos.length === 0 ? (
          <div className="empty-state"><div className="empty-icon"><Film size={27}/></div><h3>{videos.length ? 'Nessun risultato' : 'La tua cassaforte è vuota'}</h3><p>{videos.length ? 'Prova con un altro nome.' : 'Carica il tuo primo video: resterà privato finché non deciderai di condividerlo.'}</p>{!videos.length && <button className="secondary-btn" type="button" onClick={openUploadDestination}><UploadCloud size={17}/> Seleziona video</button>}</div>
        ) : (
          <div className="video-grid">{visibleVideos.map(item => (
            <article className="video-card" key={item.id}>
              <button className="video-preview encrypted-preview" style={thumbnails[item.path] ? { backgroundImage: 'linear-gradient(#0002,#0002),url("' + thumbnails[item.path] + '")', backgroundSize: 'cover', backgroundPosition: 'center' } : undefined} disabled={openingVideoId !== null} onClick={() => item.encrypted ? openEncryptedVideo(item) : setError('Questo è un vecchio video non cifrato. Scaricalo e ricaricalo dopo la modifica per proteggerlo.') }>{thumbnails[item.path] ? <span className="thumb-play"><Play size={24} fill="currentColor"/></span> : <div className="video-placeholder">{openingVideoId === item.id ? <><LoaderCircle className="spin" size={32}/><span>APERTURA IN CORSO…</span></> : <><LockKeyhole size={32}/><span>{item.encrypted ? 'CIFRATO' : 'NON CIFRATO'}</span></>}</div>}<span className="private-tag"><LockKeyhole size={11}/> {item.encrypted ? 'AES-256' : 'VECCHIO FILE'}</span></button>
              <div className="video-info"><h3 title={item.displayName}>{item.displayName}</h3><div className="video-source"><HardDrive size={12}/>{item.providerLabel || 'Backblaze B2'}</div><div className="video-meta"><span><Clock3 size={13}/>{formatDate(item.created_at)}</span><span>{formatSize(item.size)}</span></div><div className="video-actions"><button className="share-btn" disabled={openingVideoId !== null} onClick={() => createShare(item)}><Share2 size={14}/> Condividi</button>{item.encrypted && <button className="delete-btn" onClick={() => beginRename(item)} title="Modifica nome"><Pencil size={16}/></button>}<button className="delete-btn" onClick={() => deleteVideo(item)} title="Elimina video"><Trash2 size={16}/></button></div></div>
            </article>
          ))}</div>
        )}
      </section>
      <footer className="dash-footer"><span><ShieldCheck size={14}/> I video sono cifrati sul dispositivo prima del salvataggio nella destinazione scelta.</span><span>VAULT · CLIENT-SIDE ENCRYPTION</span></footer>
      {message && <div className="notice success dashboard-notice"><Check size={16}/>{message}<button onClick={() => setMessage('')}><X size={15}/></button></div>}
      {settingsHubOpen && <div className="modal-backdrop" onClick={() => setSettingsHubOpen(false)}><div className="share-modal settings-hub-modal" onClick={e => e.stopPropagation()}><button className="modal-close" type="button" onClick={() => setSettingsHubOpen(false)}><X size={18}/></button><div className="modal-icon"><Settings size={21}/></div><div className="section-kicker">CENTRO DI CONTROLLO</div><h2>Impostazioni</h2><p>Tutte le opzioni di Vault raccolte in un unico posto.</p><div className="settings-menu-list"><button className="settings-menu-item" type="button" onClick={() => {setSettingsHubOpen(false);setStorageOpen(true);}}><span className="settings-menu-icon"><HardDrive size={18}/></span><span><b>Archiviazione</b><small>Destinazione dei video e account Google collegati</small></span><ArrowUpRight size={16}/></button><button className="settings-menu-item" type="button" onClick={() => {setAccountName(session.user.user_metadata?.display_name || '');setAccountEmail(session.user.email || '');setError('');setMessage('');setSettingsHubOpen(false);setAccountOpen(true);}}><span className="settings-menu-icon"><UserRound size={18}/></span><span><b>Account</b><small>Profilo, email e password</small></span><ArrowUpRight size={16}/></button><button className="settings-menu-item" type="button" onClick={() => {setError('');setMessage('');setSettingsHubOpen(false);setSecurityOpen(true);loadSecurityData();}}><span className="settings-menu-icon"><ShieldCheck size={18}/></span><span><b>Sicurezza e privacy</b><small>Sessioni, notifiche, link e attività</small></span><ArrowUpRight size={16}/></button><button className="settings-menu-item" type="button" onClick={() => {setError('');setMessage('');setSettingsHubOpen(false);setSettingsOpen(true);}}><span className="settings-menu-icon"><KeyRound size={18}/></span><span><b>Frase segreta Vault</b><small>Modifica la frase e ricifra l'archivio</small></span><ArrowUpRight size={16}/></button></div></div></div>}
      {storageOpen && <div className="modal-backdrop" onClick={() => !googleConnectBusy && !uploading && setStorageOpen(false)}><div className="share-modal settings-detail-modal" onClick={e => e.stopPropagation()}><button className="modal-close" type="button" onClick={() => !googleConnectBusy && !uploading && setStorageOpen(false)}><X size={18}/></button><div className="modal-icon"><HardDrive size={21}/></div><div className="section-kicker">IMPOSTAZIONI DI ARCHIVIAZIONE</div><h2>Destinazione dei video</h2><p>Scegli dove salvare i prossimi video e gestisci gli account collegati.</p>
      <section className="storage-panel">
        <div className="storage-panel-head">
          <div>
            <div className="section-kicker">DESTINAZIONE DEI VIDEO</div>
            <h2>Dove vuoi salvarli?</h2>
            <p>Ogni video viene cifrato sul dispositivo prima di essere caricato nello spazio scelto.</p>
          </div>
          {googleAccounts.length === 0 && <button className="secondary-share-btn storage-connect-btn" type="button" onClick={connectGoogleDrive} disabled={googleConnectBusy}>
            {googleConnectBusy ? <LoaderCircle className="spin" size={16}/> : <HardDrive size={16}/>}
            {googleConnectBusy ? 'Apro Google…' : 'Collega un account Google'}
          </button>}
        </div>
        <div className="storage-destination-row">
          <label htmlFor="vault-storage-destination">Salva i prossimi video in</label>
          <select id="vault-storage-destination" value={storageDestination} onChange={event => setStorageDestination(event.target.value)} disabled={uploading}>
            <option value="backblaze">Backblaze B2 · 2 GB personali</option>
            {googleAccounts.map(account => <option key={account.id} value={'google:' + account.id}>Google Drive · {account.email}</option>)}
          </select>
        </div>
        <div className="storage-account-list">
          {googleAccounts.length === 0
            ? <p className="storage-muted">Nessun account Google collegato. Puoi collegarne uno per usare il suo spazio Drive.</p>
            : googleAccounts.map(account => (
              <div className="storage-account-row" key={account.id}>
                <div className="storage-account-copy">
                  <b>{account.email}</b>
                  <span>{account.status === 'error' ? 'Connessione da ripristinare' : 'Cartella: Vault - video cifrati'}</span>
                  {account.quotaError && <span className="storage-account-error">Per mostrare lo spazio totale, aggiorna le autorizzazioni Google.</span>}
                  {account.error && <span className="storage-account-error">{account.error}</span>}
                </div>
                <div className="storage-account-actions">
                  {account.status === 'error' && <button type="button" onClick={connectGoogleDrive} disabled={googleConnectBusy}>Ricollega</button>}
                  <button type="button" onClick={() => disconnectGoogleDrive(account)} disabled={Boolean(googleDisconnectId)}>{googleDisconnectId === account.id ? 'Scollego…' : 'Scollega'}</button>
                </div>
              </div>
            ))}
        </div>
        {googleDriveError && <div className="storage-error"><AlertCircle size={15}/><span>{googleDriveError}</span></div>}
        {googleAccounts.some(account => account.quotaError) && <button className="secondary-share-btn" type="button" onClick={connectGoogleDrive} disabled={googleConnectBusy}>{googleConnectBusy ? <LoaderCircle className="spin" size={16}/> : <HardDrive size={16}/>} Aggiorna autorizzazioni Google Drive</button>}
        {googleDriveQuota && <p className="storage-note">Google Drive: {formatSize(googleDriveQuota.usedBytes)} utilizzati su {googleDriveQuota.limitBytes == null ? 'spazio senza limite indicato' : formatSize(googleDriveQuota.limitBytes)} totali.</p>}
        <p className="storage-note">Puoi collegare un solo account Google alla volta. Per cambiarlo, scollega quello attuale e collega il nuovo. I video già presenti nel Drive non vengono eliminati.</p>
      </section>
      </div></div>}
      {accountOpen && <div className="modal-backdrop" onClick={() => !accountBusy && setAccountOpen(false)}><div className="share-modal account-modal" onClick={e => e.stopPropagation()}><button className="modal-close" type="button" onClick={() => !accountBusy && setAccountOpen(false)}><X size={18}/></button><div className="modal-icon"><UserRound size={21}/></div><div className="section-kicker">IL TUO ACCOUNT</div><h2>Profilo e credenziali</h2><p>Gestisci i dati dell’account. La frase segreta Vault resta separata dalla password.</p><div className="account-field"><label>Email attuale</label><div className="account-current">{session.user.email}</div></div><label>Nome visualizzato</label><div className="input-wrap"><UserRound size={17}/><input value={accountName} onChange={e => setAccountName(e.target.value)} maxLength={60} placeholder="Nome profilo"/></div><button className="primary-btn copy-btn" type="button" disabled={accountBusy} onClick={saveAccountName}>{accountBusy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>} Salva nome</button><div className="account-divider"/><label>Nuovo indirizzo email</label><div className="input-wrap"><Mail size={17}/><input type="email" value={accountEmail} onChange={e => setAccountEmail(e.target.value)} autoComplete="email" placeholder="nuova@email.com"/></div><button className="secondary-share-btn" type="button" disabled={accountBusy} onClick={requestAccountEmailChange}>Richiedi cambio email</button><p className="card-sub account-hint">Il cambio potrebbe richiedere la conferma tramite email.</p><div className="account-divider"/><label>Password attuale</label><div className="input-wrap"><KeyRound size={17}/><input type="password" value={currentAccountPassword} onChange={e => setCurrentAccountPassword(e.target.value)} autoComplete="current-password" placeholder="Password attuale"/></div><label>Nuova password</label><div className="input-wrap"><KeyRound size={17}/><input type="password" value={newAccountPassword} onChange={e => setNewAccountPassword(e.target.value)} minLength={8} autoComplete="new-password" placeholder="Almeno 8 caratteri"/></div><label>Conferma nuova password</label><div className="input-wrap"><KeyRound size={17}/><input type="password" value={confirmAccountPassword} onChange={e => setConfirmAccountPassword(e.target.value)} minLength={8} autoComplete="new-password" placeholder="Ripeti la nuova password"/></div><button className="secondary-share-btn" type="button" disabled={accountBusy || !currentAccountPassword || newAccountPassword.length < 8 || !confirmAccountPassword} onClick={updateAccountPassword}>Aggiorna password</button>{error && <div className="notice error"><AlertCircle size={16}/>{error}</div>}{message && <div className="notice success"><Check size={16}/>{message}</div>}</div></div>}
      {securityOpen && <div className="modal-backdrop" onClick={() => setSecurityOpen(false)}><div className="share-modal security-modal" onClick={e => e.stopPropagation()}><button className="modal-close" type="button" onClick={() => setSecurityOpen(false)}><X size={18}/></button><div className="modal-icon"><ShieldCheck size={21}/></div><div className="section-kicker">CONTROLLO E PROTEZIONE</div><h2>Centro sicurezza</h2><p>Gestisci i link temporanei e controlla le attività recenti del tuo account.</p><button className="secondary-share-btn" type="button" onClick={enableBrowserNotifications} disabled={notificationsEnabled}>{notificationsEnabled ? <><Check size={16}/> Notifiche locali attive</> : 'Attiva notifiche su questo dispositivo'}</button><p className="account-hint">Notifiche del browser solo mentre Vault è aperto; non sono avvisi push quando il sito è chiuso.</p><div className="security-device"><Smartphone size={18}/><div><b>Sessione corrente</b><span>{getDeviceLabel()}</span></div><span className="current-device-pill">ATTIVA</span></div><div className="security-section-head"><h3>Sessioni riconosciute</h3><span className="account-hint">Dagli accessi recenti</span></div><div className="security-list">{activity.filter(entry => entry.event_type === 'login').slice(0,5).map(entry => <div className="security-row" key={entry.id}><div className="security-row-main"><b>{entry.details || 'Accesso registrato'}</b><span>{new Date(entry.created_at).toLocaleString('it-IT')}</span></div></div>)}</div><p className="account-hint">Questa è la cronologia degli accessi registrati da Vault, non l’elenco live delle sessioni aperte.</p><button className="secondary-share-btn" type="button" onClick={signOutOtherSessions}>Disconnetti gli altri dispositivi</button><p className="account-hint">Supabase consente di revocare le altre sessioni, ma non fornisce a questa app l’elenco dettagliato dei dispositivi. I token di accesso già emessi possono restare validi fino alla scadenza.</p><div className="account-divider"/><div className="security-section-head"><h3>Avvisi</h3><span className="account-hint">{securityAlerts.length} da controllare</span></div>{securityAlerts.length ? <div className="security-list">{securityAlerts.map(share => { const expired = new Date(share.expires_at).getTime() <= Date.now(); return <div className="security-row" key={'alert-'+share.id}><div className="security-row-main"><b>{share.file_name}</b><span>{expired ? 'Link scaduto: la copia sarà rimossa' : 'Link in scadenza entro 15 minuti'}</span></div><span className="current-device-pill">{expired ? 'SCADUTO' : 'IN SCADENZA'}</span></div>; })}</div> : <div className="security-empty">Nessun link in scadenza nei prossimi 15 minuti.</div>}<div className="account-divider"/><div className="security-section-head"><h3>Link temporanei</h3><button className="text-btn" type="button" onClick={loadSecurityData}>Aggiorna</button></div>{error && <div className="notice error"><AlertCircle size={16}/>{error}</div>}{message && <div className="notice success"><Check size={16}/>{message}</div>}{securityLoading ? <div className="incoming-share-status"><LoaderCircle className="spin" size={17}/> Caricamento…</div> : shares.length === 0 ? <div className="security-empty">Non hai ancora creato link temporanei.</div> : <div className="security-list">{shares.map(share => { const expired = new Date(share.expires_at).getTime() <= Date.now(); const revoked = Boolean(share.revoked_at); return <div className="security-row" key={share.id}><div className="security-row-main"><b>{share.file_name}</b><span>{revoked ? (expired ? 'Scaduto e ripulito' : 'Revocato') : expired ? 'Scaduto' : 'Attivo'} · scade {new Date(share.expires_at).toLocaleString('it-IT')}</span></div>{!revoked && <button className="revoke-btn" type="button" onClick={() => revokeShare(share)}>{expired ? 'Pulisci' : 'Revoca'}</button>}</div>; })}</div>}<div className="account-divider"/><div className="security-section-head"><h3>Attività recenti</h3><span className="account-hint">Ultime 40 azioni</span></div><p className="account-hint">Registro applicativo: annota le operazioni eseguite da Vault, ma non è un registro forense indipendente o non modificabile.</p>{activity.length === 0 ? <div className="security-empty">Le attività appariranno qui.</div> : <div className="security-list activity-list">{activity.map(entry => <div className="activity-row" key={entry.id}><div><b>{{login:'Accesso',video_uploaded:'Video caricato',video_opened:'Video aperto',video_renamed:'Video rinominato',video_deleted:'Video eliminato',share_created:'Link creato',share_revoked:'Link revocato',password_changed:'Password aggiornata',email_change_requested:'Cambio email richiesto',other_sessions_signed_out:'Altre sessioni revocate',vault_unlocked:'Cassaforte sbloccata'}[entry.event_type] || 'Attività'}</b><span>{entry.item_name || entry.details || '—'}</span></div><time>{new Date(entry.created_at).toLocaleString('it-IT')}</time></div>)}</div>}</div></div>}
      {settingsOpen && <div className="modal-backdrop" onClick={() => !rotationBusy && setSettingsOpen(false)}><div className="share-modal settings-modal" onClick={e => e.stopPropagation()}><button className="modal-close" disabled={rotationBusy} onClick={() => setSettingsOpen(false)}><X size={18}/></button><div className="modal-icon"><KeyRound size={21}/></div><div className="section-kicker">IMPOSTAZIONI DI SICUREZZA</div><h2>Modifica frase segreta</h2><p>Vault ricifrerà tutti i video con la nuova frase. Le frasi vengono elaborate solo sul dispositivo e non vengono inviate ai server.</p><form onSubmit={changeVaultPassphrase}><label>Frase segreta attuale</label><div className="input-wrap"><KeyRound size={17}/><input type="password" value={currentVaultPassphrase} onChange={e => setCurrentVaultPassphrase(e.target.value)} autoComplete="current-password" required placeholder="Inserisci la frase attuale"/></div><label>Nuova frase segreta</label><div className="input-wrap"><KeyRound size={17}/><input type={showNewVaultPassphrase ? 'text' : 'password'} value={newVaultPassphrase} onChange={e => setNewVaultPassphrase(e.target.value)} minLength={12} autoComplete="new-password" required placeholder="Almeno 12 caratteri"/><button className="eye-btn" type="button" onClick={() => setShowNewVaultPassphrase(v => !v)} aria-label="Mostra nuova frase">{showNewVaultPassphrase ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div><label>Conferma nuova frase</label><div className="input-wrap"><KeyRound size={17}/><input type={showNewVaultPassphraseConfirm ? 'text' : 'password'} value={newVaultPassphraseConfirm} onChange={e => setNewVaultPassphraseConfirm(e.target.value)} minLength={12} autoComplete="new-password" required placeholder="Ripeti la nuova frase"/><button className="eye-btn" type="button" onClick={() => setShowNewVaultPassphraseConfirm(v => !v)} aria-label="Mostra conferma nuova frase">{showNewVaultPassphraseConfirm ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div><p className="card-sub settings-warning">Non chiudere la pagina durante la procedura. Gli originali vengono eliminati solo dopo la verifica di tutte le nuove copie.</p><button className="primary-btn copy-btn" disabled={rotationBusy}>{rotationBusy ? <><LoaderCircle className="spin" size={17}/> Aggiornamento in corso…</> : <><ShieldCheck size={17}/> Ricifra e aggiorna la frase</>}</button></form>{rotationProgress && <div className="incoming-share-status"><LoaderCircle className="spin" size={17}/>{rotationProgress}</div>}</div></div>}
      {previewUrl && <div className="modal-backdrop" onClick={() => {URL.revokeObjectURL(previewUrl);setPreviewUrl('');setPreviewName('');}}><div className="share-modal video-modal" onClick={e => e.stopPropagation()}><button className="modal-close" onClick={() => {URL.revokeObjectURL(previewUrl);setPreviewUrl('');setPreviewName('');}}><X size={18}/></button><div className="section-kicker">DECIFRATO SOLO IN MEMORIA</div><h2>{previewName}</h2><div className="video-player-wrap"><video ref={videoElementRef} src={previewUrl} controls autoPlay playsInline style={{width:'100%',maxHeight:'60vh',marginTop:16,background:'#000'}}/>{!isAppleVideoDevice() && <button className="fullscreen-btn" onClick={requestVideoFullscreen}><Maximize2 size={17}/> Schermo intero</button>}</div></div></div>}
      {renameItem && <div className="modal-backdrop" onClick={() => !renameBusy && setRenameItem(null)}><div className="share-modal" onClick={e => e.stopPropagation()}><button className="modal-close" onClick={() => !renameBusy && setRenameItem(null)}><X size={18}/></button><div className="modal-icon"><Pencil size={21}/></div><div className="section-kicker">MODIFICA VIDEO</div><h2>Rinomina video</h2><p>Modifica il nome con cui compare nella tua libreria. Il contenuto cifrato non viene modificato.</p><form onSubmit={saveRename}><input className="rename-input" value={renameValue} onChange={e => setRenameValue(e.target.value)} maxLength={100} autoFocus placeholder="Nome del video"/><button className="primary-btn copy-btn" disabled={renameBusy}>{renameBusy ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>} Salva nome</button></form></div></div>}
      {shareItem && <div className="modal-backdrop" onClick={() => {setShareItem(null);setShareUrl('');setCopyFile(null);}}><div className="share-modal" onClick={e => e.stopPropagation()}><button className="modal-close" onClick={() => {setShareItem(null);setShareUrl('');setCopyFile(null);}}><X size={18}/></button><div className="modal-icon"><Share2 size={21}/></div><div className="section-kicker">CONDIVISIONE SICURA</div><h2>Condividi questo video</h2><p>Scegli se inviare un link temporaneo oppure una copia del file, che resterà sul dispositivo di chi la riceve.</p><div className="share-file"><Film size={17}/><span>{shareItem.displayName || getDisplayName(shareItem.name)}</span></div><button className="secondary-share-btn" disabled={shareBusy} onClick={createTemporaryLink}>{shareBusy && !copyFile ? <LoaderCircle className="spin" size={16}/> : <Clock3 size={16}/>} Crea link valido 1 ora</button>{shareUrl && <><div className="share-link">{shareUrl}</div><button className="primary-btn copy-btn" onClick={copyShare}>{copied ? <><Check size={17}/> Link copiato</> : <><Copy size={17}/> Copia link</>}</button></>}<div className="share-divider">OPPURE</div><button className="primary-btn copy-btn" disabled={shareBusy} onClick={copyFile ? sendPreparedCopy : prepareCopy}>{shareBusy ? <><LoaderCircle className="spin" size={17}/> Preparo la copia…</> : copyFile ? <><Share2 size={17}/> Invia la copia</> : <><Download size={17}/> Prepara una copia da inviare</>}</button><div className="expiry-note"><ShieldCheck size={14}/> La copia inviata non dipende da Vault e non scade. Il link invece dura 60 minuti.</div></div></div>}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
