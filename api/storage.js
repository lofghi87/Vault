import { createClient } from '@supabase/supabase-js';
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

function safeKey(value, userId) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('..') || value.includes('\\')) {
    throw new Error('Percorso file non valido.');
  }
  if (!value.startsWith(userId + '/')) throw new Error('Accesso non autorizzato al percorso.');
  return value;
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
        Bucket: bucket, Prefix: prefix, Delimiter: '/', MaxKeys: 1000,
      }));
      const items = (result.Contents || [])
        .filter(item => item.Key && item.Key !== prefix)
        .map(item => {
          const name = item.Key.slice(prefix.length);
          if (!name || name.includes('/')) return null;
          return {
            name,
            id: item.ETag || item.Key,
            created_at: item.LastModified?.toISOString?.() || new Date().toISOString(),
            updated_at: item.LastModified?.toISOString?.() || new Date().toISOString(),
            metadata: { size: item.Size || 0, mimetype: 'application/octet-stream' },
          };
        }).filter(Boolean);
      items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(1000, Math.max(1, Number(body.limit) || 100));
      return send(res, 200, { data: items.slice(offset, offset + limit) });
    }

    if (action === 'verify') {
      const key = safeKey(body.path, userId);
      try {
        const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return send(res, 200, { data: { size: result.ContentLength || 0, etag: result.ETag || null } });
      } catch (error) {
        if (error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
          return send(res, 404, { error: 'File non presente su Backblaze.' });
        }
        throw error;
      }
    }

    if (action === 'uploadUrl') {
      const key = safeKey(body.path, userId);
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
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: destination,
        CopySource: encodeURIComponent(bucket + '/' + source).replace(/%2F/g, '/'),
        MetadataDirective: 'COPY',
      }));
      if (action === 'move') {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: source }], Quiet: true } }));
      }
      return send(res, 200, { data: { path: destination } });
    }

    return send(res, 400, { error: 'Operazione non riconosciuta.' });
  } catch (error) {
    console.error('Vault B2 storage error:', error);
    return send(res, 500, { error: error?.message || 'Errore dello storage.' });
  }
}
