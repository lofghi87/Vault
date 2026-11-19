import { createClient } from '@supabase/supabase-js';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';
const APP_URL = process.env.APP_URL || 'https://vault-private.vercel.app';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || APP_URL + '/api/google-drive/callback';

export function googleConfigReady() {
  return Boolean(
    process.env.VITE_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
  );
}

export function getAdmin() {
  if (!googleConfigReady()) throw new Error('Google Drive non è ancora configurato sul server.');
  return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function redirectUri() {
  return REDIRECT_URI;
}

export function appUrl() {
  return APP_URL;
}

export function hashHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function encryptionKey() {
  const key = Buffer.from(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('Chiave di cifratura dei token Google non valida: deve essere una chiave Base64 di 32 byte.');
  return key;
}

export function encryptRefreshToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(part => part.toString('base64url')).join('.');
}

export function decryptRefreshToken(value) {
  const [ivText, tagText, cipherText] = String(value || '').split('.');
  if (!ivText || !tagText || !cipherText) throw new Error('Token Google salvato in formato non valido.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export async function requireUser(req) {
  const token = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  if (!token) throw new Error('Sessione Vault non valida. Accedi di nuovo.');
  const admin = getAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user?.id) throw new Error('Sessione Vault scaduta. Accedi di nuovo.');
  return { admin, user: data.user };
}

export async function getGoogleAccount(admin, userId, accountId) {
  if (typeof accountId !== 'string' || !accountId) throw new Error('Seleziona un account Google Drive.');
  const { data, error } = await admin
    .from('vault_google_accounts')
    .select('id,user_id,google_sub,email,refresh_token_enc,folder_id,connected_at')
    .eq('id', accountId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error('Non riesco a leggere l’account Google collegato: ' + error.message);
  if (!data) throw new Error('Account Google Drive non trovato. Ricollegalo dalle impostazioni di archiviazione.');
  return data;
}

export async function getGoogleAccessToken(admin, account) {
  const refreshToken = decryptRefreshToken(account.refresh_token_enc);
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) {
    if (result.error === 'invalid_grant') {
      throw new Error('L’autorizzazione Google è scaduta o è stata revocata. Ricollega questo account Drive.');
    }
    throw new Error('Google Drive non è momentaneamente raggiungibile. Riprova.');
  }
  if (result.refresh_token) {
    const { error } = await admin.from('vault_google_accounts')
      .update({ refresh_token_enc: encryptRefreshToken(result.refresh_token), updated_at: new Date().toISOString() })
      .eq('id', account.id)
      .eq('user_id', account.user_id);
    if (error) console.error('[Vault Google Drive] refresh token update failed:', error.message);
  }
  return result.access_token;
}

export async function googleApi(accessToken, path, options = {}) {
  const response = await fetch('https://www.googleapis.com' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      ...(options.headers || {}),
    },
  });
  return response;
}

export async function startGoogleOAuth(admin, userId) {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error: cleanupError } = await admin
    .from('vault_google_oauth_states')
    .delete()
    .lt('expires_at', new Date().toISOString());
  if (cleanupError) console.warn('[Vault Google Drive] expired OAuth state cleanup failed:', cleanupError.message);

  const { error } = await admin.from('vault_google_oauth_states').insert({
    state_hash: hashHex(state),
    user_id: userId,
    code_verifier: codeVerifier,
    expires_at: expiresAt,
  });
  if (error) throw new Error('Non riesco ad avviare il collegamento Google: ' + error.message);

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile ' + DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

export async function createVaultDriveFolder(accessToken) {
  const response = await googleApi(accessToken, '/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Vault - video cifrati',
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { vaultApp: 'Vault', vaultEncrypted: 'true' },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) {
    throw new Error('Non riesco a creare la cartella Vault su Google Drive.');
  }
  return result;
}

export async function listGoogleFiles(accessToken, folderId) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: "'" + folderId.replace(/'/g, "\\'") + "' in parents and trashed = false",
      pageSize: '1000',
      orderBy: 'createdTime desc',
      fields: 'nextPageToken,files(id,name,size,mimeType,createdTime,modifiedTime)',
      spaces: 'drive',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await googleApi(accessToken, '/drive/v3/files?' + params.toString());
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Non riesco a leggere i video da Google Drive. Controlla il collegamento.');
    files.push(...(result.files || []));
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return files;
}

export async function userFromCallbackState(admin, state) {
  if (!state) throw new Error('Collegamento Google non valido: manca lo stato di sicurezza.');
  const { data, error } = await admin
    .from('vault_google_oauth_states')
    .select('state_hash,user_id,code_verifier,expires_at')
    .eq('state_hash', hashHex(state))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error || !data) throw new Error('Richiesta di collegamento scaduta. Torna su Vault e riprova.');
  const { error: deleteError } = await admin.from('vault_google_oauth_states').delete().eq('state_hash', data.state_hash);
  if (deleteError) throw new Error('Non riesco a completare il controllo di sicurezza del collegamento Google.');
  return data;
}
