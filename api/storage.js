import { createClient } from '@supabase/supabase-js';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const endpoint = process.env.B2_ENDPOINT;
const bucket = process.env.B2_BUCKET_NAME;
const s3 = new S3Client({
  region: 'eu-central-003',
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});

function send(res, status, body) {
  res.status(status).json(body);
}

const PERSONAL_QUOTA_BYTES = 2_000_000_000;
const GLOBAL_SAFE_LIMIT_BYTES = 8_000_000_000;

// Counts all current objects, including temporary share copies, across the bucket.
async function getBucketUsage(userId) {
  let totalBytes = 0;
  let userBytes = 0;
  let continuationToken;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      MaxKeys: 1000,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }));
    for (const item of result.Contents || []) {
      const size = Number(item.Size || 0);
      totalBytes += size;
      if (item.Key?.startsWith(userId + '/')) userBytes += size;
    }
    if (!result.IsTruncated) break;
    if (!result.NextContinuationToken) throw new Error('Paginazione dello spazio Backblaze incompleta.');
    continuationToken = result.NextContinuationToken;
  } while (true);
  return { totalBytes, userBytes };
}

async function deleteObject(key) {
  await s3.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: [{ Key: key }], Quiet: true },
  }));
}

function safeKey(value, userId) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('..') || value.includes('\\')) {
    throw new Error('Percorso file non valido.');
  }
  if (!value.startsWith(userId + '/')) throw new Error('Accesso non autorizzato al percorso.');
  return value;
}

async function sha256Stream(stream) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Metodo non consentito.' });
  try {
    if (!endpoint || !bucket || !process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY) {
      return send(res, 503, { error: 'Storage Backblaze non configurato.' });
    }
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return send(res, 401, { error: 'Sessione non valida.' });
    const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData?.user?.id) return send(res, 401, { error: 'Sessione scaduta. Accedi di nuovo.' });
    const userId = authData.user.id;
    const body = req.body || {};
    const action = body.action;

    if (action === 'list') {
      const prefix = userId + '/';
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ...(typeof body.continuationToken === 'string' && body.continuationToken
          ? { ContinuationToken: body.continuationToken }
          : {}),
      }));
      const items = (result.Contents || [])
        .filter(item => item.Key && item.Key.startsWith(prefix) && !item.Key.startsWith(prefix + '_shares/'))
        .map(item => {
          const path = item.Key;
          const name = path.slice(path.lastIndexOf('/') + 1);
          if (!name) return null;
          return {
            name,
            path,
            id: item.ETag || path,
            created_at: item.LastModified?.toISOString?.() || new Date().toISOString(),
            updated_at: item.LastModified?.toISOString?.() || new Date().toISOString(),
            metadata: { size: item.Size || 0, mimetype: 'application/octet-stream' },
          };
        }).filter(Boolean);
      return send(res, 200, {
        data: items,
        nextContinuationToken: result.IsTruncated ? (result.NextContinuationToken || null) : null,
      });
    }

    if (action === 'migrate') {
      const requestId = req.headers['x-vercel-id'] || 'unknown';
      const startedAt = Date.now();
      console.info('[Vault B2 migration] started', { requestId, userId });
      const sourceClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: 'Bearer ' + token } },
      });
      const copied = [];
      const skipped = [];
      const failures = [];
      const pageSize = 100;
      let scanned = 0;
      let pages = 0;
      for (let offset = 0; ; offset += pageSize) {
        pages += 1;
        const { data: page, error: listError } = await sourceClient.storage.from('vault-videos').list(userId, {
          limit: pageSize, offset, sortBy: { column: 'created_at', order: 'asc' },
        });
        if (listError) throw new Error('Lettura elenco Supabase non riuscita: ' + listError.message);
        const items = (page || []).filter(item => item?.name && item?.id);
        scanned += items.length;
        for (const item of items) {
          const key = safeKey(userId + '/' + item.name, userId);
          const expectedSize = Number(item.metadata?.size || 0);
          try {
            let existing = null;
            try {
              existing = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
            } catch (headError) {
              if (!(headError?.name === 'NotFound' || headError?.name === 'NoSuchKey' || headError?.$metadata?.httpStatusCode === 404)) throw headError;
            }
            if (existing) {
              if (Number(existing.ContentLength) !== expectedSize) {
                failures.push({ name: item.name, error: 'Esiste già una copia con dimensione diversa; file originale conservato.' });
              } else {
                skipped.push(item.name);
              }
              continue;
            }
            const { data: signed, error: signedError } = await sourceClient.storage.from('vault-videos').createSignedUrl(key, 300);
            if (signedError || !signed?.signedUrl) throw new Error('Link di lettura Supabase non disponibile: ' + (signedError?.message || 'nessun URL'));
            const sourceResponse = await fetch(signed.signedUrl);
            if (!sourceResponse.ok || !sourceResponse.body) throw new Error('Download server-to-server da Supabase fallito (HTTP ' + sourceResponse.status + ').');
            const sourceLength = Number(sourceResponse.headers.get('content-length') || expectedSize);
            if (!Number.isFinite(sourceLength) || sourceLength <= 0) throw new Error('Dimensione del file non valida o non disponibile.');
            if (expectedSize && sourceLength !== expectedSize) throw new Error('Dimensione ricevuta da Supabase diversa da quella attesa.');
            const bodyStream = Readable.fromWeb(sourceResponse.body);
            await s3.send(new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: bodyStream,
              ContentLength: sourceLength,
              ContentType: 'application/octet-stream',
              CacheControl: 'no-store',
            }));
            const verified = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
            if (Number(verified.ContentLength) !== sourceLength) {
              failures.push({ name: item.name, error: 'Verifica dimensionale Backblaze non superata; originale conservato.' });
            } else {
              copied.push(item.name);
            }
          } catch (itemError) {
            failures.push({ name: item.name, error: itemError?.message || 'Errore sconosciuto' });
          }
        }
        if (items.length < pageSize) break;
      }
      const summary = {
        requestId,
        userId,
        pages,
        scanned,
        copied: copied.length,
        skipped: skipped.length,
        failures: failures.length,
        durationMs: Date.now() - startedAt,
      };
      console.info('[Vault B2 migration] finished', summary);
      if (failures.length) console.warn('[Vault B2 migration] failures', failures.map(item => ({ error: item.error })));
      return send(res, failures.length ? 207 : 200, {
        data: { copied, skipped, failures, total: copied.length + skipped.length + failures.length },
        summary,
        message: failures.length ? 'Copia parziale: gli originali su Supabase sono rimasti intatti.' : 'Copia completata e verificata. Gli originali su Supabase sono rimasti intatti.',
      });
    }

    if (action === 'verifyMigration') {
      const startedAt = Date.now();
      const sourceClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: 'Bearer ' + token } },
      });
      const checked = [];
      const failures = [];
      const pageSize = 100;
      let scanned = 0;
      for (let offset = 0; ; offset += pageSize) {
        const { data: page, error: listError } = await sourceClient.storage.from('vault-videos').list(userId, {
          limit: pageSize, offset, sortBy: { column: 'created_at', order: 'asc' },
        });
        if (listError) throw new Error('Lettura elenco Supabase non riuscita: ' + listError.message);
        const items = (page || []).filter(item => item?.name && item?.id);
        scanned += items.length;
        for (const item of items) {
          const key = safeKey(userId + '/' + item.name, userId);
          try {
            const { data: signed, error: signedError } = await sourceClient.storage.from('vault-videos').createSignedUrl(key, 300);
            if (signedError || !signed?.signedUrl) throw new Error('Link Supabase non disponibile: ' + (signedError?.message || 'nessun URL'));
            const sourceResponse = await fetch(signed.signedUrl);
            if (!sourceResponse.ok || !sourceResponse.body) throw new Error('Lettura originale Supabase fallita (HTTP ' + sourceResponse.status + ').');
            const sourceHash = await sha256Stream(Readable.fromWeb(sourceResponse.body));
            const target = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            if (!target.Body) throw new Error('File assente o vuoto su Backblaze.');
            const targetHash = await sha256Stream(target.Body);
            const matches = sourceHash.size === targetHash.size && sourceHash.sha256 === targetHash.sha256;
            checked.push({ name: item.name, size: sourceHash.size, matches });
            if (!matches) failures.push({ name: item.name, error: 'Il contenuto su Backblaze non coincide byte per byte con l’originale.' });
          } catch (itemError) {
            failures.push({ name: item.name, error: itemError?.message || 'Errore sconosciuto durante la verifica.' });
          }
        }
        if (items.length < pageSize) break;
      }
      const summary = {
        scanned,
        checked: checked.length,
        verified: checked.filter(item => item.matches).length,
        failures: failures.length,
        durationMs: Date.now() - startedAt,
      };
      console.info('[Vault B2 integrity] finished', summary);
      return send(res, failures.length ? 207 : 200, {
        data: { checked, failures },
        summary,
        message: failures.length ? 'Verifica integrità non superata per tutti i file.' : 'Tutti i file verificati: SHA-256 identico tra Supabase e Backblaze.',
      });
    }

    if (action === 'purgeSupabaseVerified') {
      const sourceClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: 'Bearer ' + token } },
      });
      const paths = [];
      const failures = [];
      let scanned = 0;
      const pageSize = 100;
      for (let offset = 0; ; offset += pageSize) {
        const { data: page, error: listError } = await sourceClient.storage.from('vault-videos').list(userId, {
          limit: pageSize, offset, sortBy: { column: 'created_at', order: 'asc' },
        });
        if (listError) throw new Error('Lettura elenco Supabase non riuscita: ' + listError.message);
        const items = (page || []).filter(item => item?.name && item?.id);
        scanned += items.length;
        for (const item of items) {
          const key = safeKey(userId + '/' + item.name, userId);
          try {
            const { data: signed, error: signedError } = await sourceClient.storage.from('vault-videos').createSignedUrl(key, 300);
            if (signedError || !signed?.signedUrl) throw new Error('Link Supabase non disponibile: ' + (signedError?.message || 'nessun URL'));
            const sourceResponse = await fetch(signed.signedUrl);
            if (!sourceResponse.ok || !sourceResponse.body) throw new Error('Lettura originale Supabase fallita (HTTP ' + sourceResponse.status + ').');
            const sourceHash = await sha256Stream(Readable.fromWeb(sourceResponse.body));
            const target = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            if (!target.Body) throw new Error('Copia assente su Backblaze.');
            const targetHash = await sha256Stream(target.Body);
            if (sourceHash.size !== targetHash.size || sourceHash.sha256 !== targetHash.sha256) {
              throw new Error('SHA-256 o dimensione diversi: originale mantenuto.');
            }
            paths.push(key);
          } catch (itemError) {
            failures.push({ name: item.name, error: itemError?.message || 'Errore di verifica sconosciuto.' });
          }
        }
        if (items.length < pageSize) break;
      }
      if (failures.length || paths.length !== scanned) {
        console.warn('[Vault Supabase cleanup] aborted; originals retained', { userId, scanned, verified: paths.length, failures: failures.length });
        return send(res, 409, {
          error: 'Pulizia annullata: non tutti i file hanno superato la verifica SHA-256. Nessun originale è stato eliminato.',
          summary: { scanned, verified: paths.length, failures },
        });
      }
      for (let offset = 0; offset < paths.length; offset += 100) {
        const batch = paths.slice(offset, offset + 100);
        const { data: removed, error: removeError } = await sourceClient.storage.from('vault-videos').remove(batch);
        if (removeError) throw new Error('Verifica completata, ma Supabase non ha consentito la rimozione di un gruppo di file: ' + removeError.message);
        if (!Array.isArray(removed) || removed.length !== batch.length) {
          throw new Error('Supabase non ha confermato la rimozione di tutti i file del gruppo. Verificare lo stato dello storage.');
        }
      }
      console.info('[Vault Supabase cleanup] completed', { userId, scanned, verified: paths.length, removed: paths.length });
      return send(res, 200, {
        data: { removed: paths },
        summary: { scanned, verified: paths.length, removed: paths.length },
        message: 'Originali Supabase rimossi solo dopo verifica SHA-256 identica su Backblaze.',
      });
    }

    if (action === 'quota') {
      const usage = await getBucketUsage(userId);
      return send(res, 200, { data: {
        usedBytes: usage.userBytes,
        personalLimitBytes: PERSONAL_QUOTA_BYTES,
      } });
    }

    if (action === 'verify') {
      const key = safeKey(body.path, userId);
      try {
        const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const actualSize = Number(result.ContentLength || 0);
        const expectedSize = Number(body.expectedSize || 0);
        if (expectedSize > 0 && actualSize !== expectedSize) {
          await deleteObject(key);
          return send(res, 422, { error: 'La dimensione caricata non coincide con quella prevista. Il file incompleto è stato rimosso.' });
        }
        const usage = await getBucketUsage(userId);
        if (usage.userBytes > PERSONAL_QUOTA_BYTES || usage.totalBytes > GLOBAL_SAFE_LIMIT_BYTES) {
          await deleteObject(key);
          return send(res, usage.userBytes > PERSONAL_QUOTA_BYTES ? 413 : 507, {
            error: usage.userBytes > PERSONAL_QUOTA_BYTES
              ? 'Hai superato lo spazio personale di 2 GB. Il nuovo caricamento è stato annullato.'
              : 'Vault ha raggiunto il limite di sicurezza dello spazio condiviso. Il nuovo caricamento è stato annullato.',
          });
        }
        return send(res, 200, { data: { size: actualSize, etag: result.ETag || null } });
      } catch (error) {
        if (error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
          return send(res, 404, { error: 'File non presente su Backblaze.' });
        }
        throw error;
      }
    }

    if (action === 'uploadUrl') {
      const key = safeKey(body.path, userId);
      const requestedSize = Number(body.size);
      if (!Number.isSafeInteger(requestedSize) || requestedSize <= 0) {
        return send(res, 400, { error: 'Dimensione del caricamento non valida.' });
      }
      if (requestedSize > PERSONAL_QUOTA_BYTES) {
        return send(res, 413, { error: 'Il singolo video supera lo spazio massimo di 2 GB del tuo account.' });
      }
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return send(res, 409, { error: 'Esiste già un file con questo percorso. Riprova il caricamento.' });
      } catch (headError) {
        if (!(headError?.name === 'NotFound' || headError?.name === 'NoSuchKey' || headError?.$metadata?.httpStatusCode === 404)) throw headError;
      }
      const usage = await getBucketUsage(userId);
      if (usage.userBytes + requestedSize > PERSONAL_QUOTA_BYTES) {
        return send(res, 413, { error: 'Hai esaurito i 2 GB di spazio personale. Elimina un video per liberare spazio.' });
      }
      if (usage.totalBytes + requestedSize > GLOBAL_SAFE_LIMIT_BYTES) {
        return send(res, 507, { error: 'Lo spazio disponibile di Vault è temporaneamente esaurito. I tuoi video restano accessibili, ma per ora non è possibile caricarne altri.' });
      }
      const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'application/octet-stream', CacheControl: 'no-store' });
      const url = await getSignedUrl(s3, command, { expiresIn: 300 });
      return send(res, 200, { url });
    }

    if (action === 'downloadUrl' || action === 'sign') {
      const key = safeKey(body.path, userId);
      const seconds = action === 'sign' ? Math.min(3600, Math.max(60, Number(body.seconds) || 3600)) : 300;
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: seconds });
      return send(res, 200, { url });
    }

    if (action === 'delete') {
      const paths = (Array.isArray(body.paths) ? body.paths : []).map(path => safeKey(path, userId));
      if (!paths.length) return send(res, 200, { data: [] });
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: paths.map(Key => ({ Key })), Quiet: true },
      }));
      return send(res, 200, { data: paths });
    }

    if (action === 'copy' || action === 'move') {
      const source = safeKey(body.from, userId);
      const destination = safeKey(body.to, userId);
      const sourceHead = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: source }));
      const sourceSize = Number(sourceHead.ContentLength || 0);
      if (action === 'copy') {
        try {
          await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: destination }));
          return send(res, 409, { error: 'La destinazione esiste già.' });
        } catch (headError) {
          if (!(headError?.name === 'NotFound' || headError?.name === 'NoSuchKey' || headError?.$metadata?.httpStatusCode === 404)) throw headError;
        }
        const usage = await getBucketUsage(userId);
        if (usage.userBytes + sourceSize > PERSONAL_QUOTA_BYTES) {
          return send(res, 413, { error: 'Non c’è abbastanza spazio personale per creare una copia temporanea di condivisione.' });
        }
        if (usage.totalBytes + sourceSize > GLOBAL_SAFE_LIMIT_BYTES) {
          return send(res, 507, { error: 'Lo spazio condiviso di Vault è temporaneamente esaurito: non è possibile creare altre copie di condivisione.' });
        }
      }
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: destination,
        CopySource: encodeURIComponent(bucket + '/' + source).replace(/%2F/g, '/'),
        MetadataDirective: 'COPY',
      }));
      if (action === 'move') {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: source }], Quiet: true } }));
      } else {
        const afterCopy = await getBucketUsage(userId);
        if (afterCopy.userBytes > PERSONAL_QUOTA_BYTES || afterCopy.totalBytes > GLOBAL_SAFE_LIMIT_BYTES) {
          await deleteObject(destination);
          return send(res, afterCopy.userBytes > PERSONAL_QUOTA_BYTES ? 413 : 507, {
            error: 'La copia temporanea supererebbe il limite di spazio di Vault. Non è stata conservata.',
          });
        }
      }
      return send(res, 200, { data: { path: destination } });
    }

    return send(res, 400, { error: 'Operazione non riconosciuta.' });
  } catch (error) {
    console.error('Vault B2 storage error:', error);
    return send(res, 500, { error: error?.message || 'Errore dello storage.' });
  }
}
