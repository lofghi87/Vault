import { Readable } from 'node:stream';
import {
  googleConfigReady, requireUser, getGoogleAccount, getGoogleAccessToken,
  decryptRefreshToken, googleApi, startGoogleOAuth, listGoogleFiles,
} from '../lib/google-drive.js';

function send(res, status, body) {
  res.status(status).json(body);
}

function getDriveName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\\/<>:"|?*\u0000-\u001f]/g, '-').slice(0, 180);
}

export default async function handler(req, res) {
  try {
    if (!googleConfigReady()) return send(res, 503, { error: 'Google Drive non è ancora configurato. Il salvataggio su Backblaze continua a funzionare.' });

    const { admin, user } = await requireUser(req);

    if (req.method === 'GET' && req.query?.action === 'download') {
      const account = await getGoogleAccount(admin, user.id, String(req.query.accountId || ''));
      const fileId = String(req.query.fileId || '');
      if (!fileId || fileId.includes('/')) return send(res, 400, { error: 'File Google Drive non valido.' });
      const accessToken = await getGoogleAccessToken(admin, account);
      const metadataResponse = await googleApi(accessToken, '/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id,parents');
      const metadata = await metadataResponse.json().catch(() => ({}));
      if (!metadataResponse.ok || !(metadata.parents || []).includes(account.folder_id)) {
        return send(res, 404, { error: 'Video non trovato nella cartella Vault di questo account.' });
      }
      const driveResponse = await googleApi(accessToken, '/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media');
      if (!driveResponse.ok || !driveResponse.body) return send(res, driveResponse.status || 502, { error: 'Non riesco a scaricare il video cifrato da Google Drive.' });
      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      const length = driveResponse.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      Readable.fromWeb(driveResponse.body).pipe(res);
      return;
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'Metodo non consentito.' });
    const action = req.body?.action;

    if (action === 'connect') {
      const url = await startGoogleOAuth(admin, user.id);
      return send(res, 200, { url });
    }

    if (action === 'accounts') {
      const { data, error } = await admin
        .from('vault_google_accounts')
        .select('id,email,folder_id,connected_at')
        .eq('user_id', user.id)
        .order('connected_at', { ascending: true });
      if (error) throw new Error('Non riesco a leggere gli account Drive: ' + error.message);
      return send(res, 200, { data: (data || []).map(account => ({
        id: account.id,
        email: account.email,
        folderId: account.folder_id,
        connectedAt: account.connected_at,
      })) });
    }

    if (action === 'list') {
      const account = await getGoogleAccount(admin, user.id, req.body.accountId);
      const accessToken = await getGoogleAccessToken(admin, account);
      const files = await listGoogleFiles(accessToken, account.folder_id);
      return send(res, 200, { data: files.map(file => ({
        id: file.id,
        name: file.name,
        size: Number(file.size || 0),
        created_at: file.createdTime || file.modifiedTime || new Date().toISOString(),
        mime: 'video/mp4',
        encrypted: file.name?.endsWith('.vlt'),
      })) });
    }

    if (action === 'startUpload') {
      const account = await getGoogleAccount(admin, user.id, req.body.accountId);
      const name = getDriveName(req.body.name);
      const size = Number(req.body.size);
      if (!name || !name.endsWith('.vlt') || !Number.isSafeInteger(size) || size <= 0) {
        return send(res, 400, { error: 'Dati del video cifrato non validi.' });
      }
      const accessToken = await getGoogleAccessToken(admin, account);
      const metadata = {
        name,
        mimeType: 'application/octet-stream',
        parents: [account.folder_id],
        appProperties: { vaultApp: 'Vault', vaultEncrypted: 'true' },
      };
      const response = await googleApi(accessToken, '/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,createdTime,mimeType', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify(metadata),
      });
      if (!response.ok) return send(res, response.status, { error: 'Google Drive non ha accettato il caricamento. Riprova.' });
      const uploadUrl = response.headers.get('location');
      if (!uploadUrl || !uploadUrl.startsWith('https://www.googleapis.com/upload/drive/')) {
        return send(res, 502, { error: 'Google Drive non ha restituito una sessione di caricamento valida.' });
      }
      return send(res, 200, { uploadUrl });
    }

    if (action === 'verify') {
      const account = await getGoogleAccount(admin, user.id, req.body.accountId);
      const fileId = String(req.body.fileId || '');
      if (!fileId || fileId.includes('/')) return send(res, 400, { error: 'File Google Drive non valido.' });
      const accessToken = await getGoogleAccessToken(admin, account);
      const response = await googleApi(accessToken, '/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id,name,size,createdTime,parents');
      const file = await response.json().catch(() => ({}));
      if (!response.ok || !file.id) return send(res, 404, { error: 'Non riesco a verificare il video su Google Drive.' });
      const expectedSize = Number(req.body.expectedSize || 0);
      if (expectedSize && Number(file.size || 0) !== expectedSize) {
        await googleApi(accessToken, '/drive/v3/files/' + encodeURIComponent(fileId), { method: 'DELETE' });
        return send(res, 422, { error: 'La verifica dimensionale del video su Google Drive non è riuscita. Il file incompleto è stato rimosso.' });
      }
      if (!(file.parents || []).includes(account.folder_id) || !file.name?.endsWith('.vlt')) {
        return send(res, 403, { error: 'Il file non appartiene alla cartella Vault prevista.' });
      }
      return send(res, 200, { data: { id: file.id, name: file.name, size: Number(file.size || 0), created_at: file.createdTime } });
    }

    if (action === 'rename') {
      const account = await getGoogleAccount(admin, user.id, req.body.accountId);
      const fileId = String(req.body.fileId || '');
      const name = getDriveName(req.body.name);
      if (!fileId || fileId.includes('/') || !name.endsWith('.vlt')) return send(res, 400, { error: 'Nuovo nome del video non valido.' });
      const accessToken = await getGoogleAccessToken(admin, account);
      const check = await googleApi(accessToken, '/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id,parents');
      const existing = await check.json().catch(() => ({}));
      if (!check.ok || !(existing.parents || []).includes(account.folder_id)) return send(res, 404, { error: 'Video non trovato nella cartella Vault di questo account.' });
      const response = await googleApi(accessToken, '/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id,name', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return send(res, 502, { error: 'Non riesco a rinominare il video su Google Drive.' });
      return send(res, 200, { data: result });
    }

    if (action === 'delete') {
      const account = await getGoogleAccount(admin, user.id, req.body.accountId);
      const fileId = String(req.body.fileId || '');
      if (!fileId || fileId.includes('/')) return send(res, 400, { error: 'Video Google Drive non valido.' });
      const accessToken = await getGoogleAccessToken(admin, account);
      const check = await googleApi(accessToken, '/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id,parents');
      const existing = await check.json().catch(() => ({}));
      if (!check.ok || !(existing.parents || []).includes(account.folder_id)) return send(res, 404, { error: 'Video non trovato nella cartella Vault di questo account.' });
      const response = await googleApi(accessToken, '/drive/v3/files/' + encodeURIComponent(fileId), { method: 'DELETE' });
      if (!response.ok && response.status !== 204) return send(res, 502, { error: 'Non riesco a eliminare il video da Google Drive.' });
      return send(res, 200, { data: { deleted: true } });
    }

    if (action === 'disconnect') {
      const account = await getGoogleAccount(admin, user.id, req.body.accountId);
      let revokeResult = null;
      try {
        const refreshToken = decryptRefreshToken(account.refresh_token_enc);
        revokeResult = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken }),
        });
      } catch (revokeError) {
        console.warn('[Vault Google Drive] revoke failed during disconnect:', revokeError.message);
      }
      const { error } = await admin.from('vault_google_accounts').delete().eq('id', account.id).eq('user_id', user.id);
      if (error) throw new Error('Non riesco a scollegare questo account Google: ' + error.message);
      return send(res, 200, { data: { disconnected: true, revokeAttempted: Boolean(revokeResult) } });
    }

    return send(res, 400, { error: 'Operazione Google Drive non riconosciuta.' });
  } catch (error) {
    console.error('[Vault Google Drive]', error);
    return send(res, 400, { error: error?.message || 'Operazione Google Drive non riuscita.' });
  }
}
