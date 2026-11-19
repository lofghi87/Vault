import {
  googleConfigReady, getAdmin, redirectUri, appUrl, hashHex,
  encryptRefreshToken, userFromCallbackState, googleApi, createVaultDriveFolder,
} from '../_google-drive.js';

function redirect(res, query) {
  res.status(302).setHeader('Location', appUrl() + '/?' + new URLSearchParams(query).toString());
  res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).end('Method not allowed');
    return;
  }
  if (!googleConfigReady()) {
    res.status(503).end('Google Drive is not configured on Vault yet.');
    return;
  }

  const admin = getAdmin();
  const state = String(req.query?.state || '');
  try {
    if (req.query?.error) throw new Error('Google non ha autorizzato il collegamento. Puoi riprovare dalle impostazioni di Vault.');
    const pending = await userFromCallbackState(admin, state);
    const code = String(req.query?.code || '');
    if (!code) throw new Error('Google non ha restituito il codice di autorizzazione.');

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        code_verifier: pending.code_verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(),
      }),
    });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokens.access_token) throw new Error('Google non ha completato l’autorizzazione. Riprova a collegare l’account.');

    const profileResponse = await googleApi(tokens.access_token, 'https://www.googleapis.com/oauth2/v3/userinfo'.replace('https://www.googleapis.com', ''));
    const profile = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok || !profile.sub || !profile.email) throw new Error('Non riesco a identificare l’account Google autorizzato.');

    const { data: previous, error: previousError } = await admin
      .from('vault_google_accounts')
      .select('id,refresh_token_enc,folder_id')
      .eq('user_id', pending.user_id)
      .eq('google_sub', profile.sub)
      .maybeSingle();
    if (previousError) throw new Error('Non riesco a verificare un eventuale collegamento Google precedente.');

    let folderId = previous?.folder_id || '';
    if (!folderId) {
      const folder = await createVaultDriveFolder(tokens.access_token);
      folderId = folder.id;
    }

    let refreshTokenEnc = tokens.refresh_token ? encryptRefreshToken(tokens.refresh_token) : previous?.refresh_token_enc;
    if (!refreshTokenEnc) throw new Error('Google non ha restituito un token di accesso continuativo. Riprova il collegamento e conferma le autorizzazioni richieste.');

    const { error: saveError } = await admin.from('vault_google_accounts').upsert({
      user_id: pending.user_id,
      google_sub: profile.sub,
      email: profile.email,
      refresh_token_enc: refreshTokenEnc,
      folder_id: folderId,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,google_sub' });
    if (saveError) throw new Error('Non riesco a salvare il collegamento Google in modo sicuro.');

    redirect(res, { drive: 'connected' });
  } catch (error) {
    console.error('[Vault Google Drive callback]', error);
    redirect(res, { drive_error: error?.message || 'Collegamento Google non riuscito.' });
  }
}
