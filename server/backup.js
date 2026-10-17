// Offsite backups of the data volume.
//
// Everything durable (accounts, tournaments, rooms, packets, stats, archived
// games) lives on one Fly volume. Fly snapshots that volume, but the snapshots
// live with Fly in the same region; this copies a gzipped tar of the whole
// volume to S3-compatible object storage (Fly's Tigris bucket, whose
// credentials `fly storage create` sets as AWS_* + BUCKET_NAME secrets) once
// a day, in the early-morning US quiet hours, and keeps the last 30 days.
//
// Off unless BUCKET_NAME and the AWS_* credentials are set.
//
// From a shell on the machine (fly ssh console -a klaxon-buzz):
//   node server/backup.js list            every backup, newest first
//   node server/backup.js now             take one now
//   node server/backup.js get KEY FILE    download one (then restore with
//                                         tar xzf FILE -C /data while stopped)
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PREFIX = 'klaxon-data/';
const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Back up once the newest copy is this old, inside the quiet window (UTC
// hours: 08-14 UTC is 1-7am Pacific); and at any hour once it's twice that,
// so restarts that keep missing the window can't skip days.
const DUE_MS = 23 * 60 * 60 * 1000;
const QUIET_UTC = [8, 14];
const CHECK_MS = 60 * 60 * 1000;

export function backupConfig(env = process.env) {
  const bucket = env.BUCKET_NAME;
  const key = env.AWS_ACCESS_KEY_ID;
  const secret = env.AWS_SECRET_ACCESS_KEY;
  if (!bucket || !key || !secret) return null;
  return {
    bucket, key, secret,
    endpoint: (env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev').replace(/\/+$/, ''),
    region: env.AWS_REGION || 'auto',
  };
}

// --- S3 requests, signed with AWS Signature Version 4 ------------------------
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (k, data) => createHmac('sha256', k).update(data).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function s3(cfg, method, key = '', { query = {}, body = null } = {}) {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key.split('/').map(enc).join('/')}`);
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body || '');
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = [method, url.pathname, qs, signed.map((h) => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secret, day), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  const res = await fetch(`${url.origin}${url.pathname}${qs ? '?' + qs : ''}`, {
    method,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.key}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
      ...(body ? { 'content-type': 'application/gzip' } : {}),
    },
    body,
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`${method} ${key || '/'}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function listBackups(cfg) {
  const out = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix: PREFIX, ...(token ? { 'continuation-token': token } : {}) };
    const xml = await (await s3(cfg, 'GET', '', { query })).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const field = (name) => (m[1].match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [])[1];
      out.push({ key: field('Key'), size: Number(field('Size')), lastModified: Date.parse(field('LastModified')) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xml.match(/<NextContinuationToken>([^<]*)</) || [])[1] : null;
  } while (token);
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

// The whole volume as one .tar.gz in memory (tens of MB). tar runs in its own
// process, so the event loop only collects the chunks.
function tarVolume(dataDir) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['czf', '-', '-C', dataDir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    tar.stdout.on('data', (c) => chunks.push(c));
    tar.stderr.on('data', (c) => { err += c; });
    tar.on('error', reject);
    tar.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      // 1 = "a file changed as we read it": the live server rewrote a record
      // mid-archive. The archive is still whole; that file is a moment newer.
      if ((code === 0 || code === 1) && buf.length > 0) resolve(buf);
      else reject(new Error(`tar exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

export async function runBackup(cfg, dataDir, { now = Date.now() } = {}) {
  const archive = await tarVolume(dataDir);
  const key = `${PREFIX}${new Date(now).toISOString().replace(/[:.]/g, '-')}.tar.gz`;
  await s3(cfg, 'PUT', key, { body: archive });
  let pruned = 0;
  for (const b of await listBackups(cfg)) {
    if (now - b.lastModified > KEEP_DAYS * DAY_MS) { await s3(cfg, 'DELETE', b.key); pruned++; }
  }
  return { key, bytes: archive.length, pruned };
}

// Hourly: back up when the newest copy is due (see DUE_MS/QUIET_UTC). Waits
// for pending record writes first, so the archive has the latest state.
export function startBackups({ dataDir, beforeBackup = async () => {}, onFailure = () => {}, cfg = backupConfig() }) {
  if (!cfg) { console.log('[backup] off (no BUCKET_NAME / AWS credentials)'); return null; }
  let running = false;
  let lastFailureAt = 0;
  async function check() {
    if (running) return;
    running = true;
    try {
      const newest = (await listBackups(cfg))[0];
      const age = newest ? Date.now() - newest.lastModified : Infinity;
      const hour = new Date().getUTCHours();
      const quiet = hour >= QUIET_UTC[0] && hour < QUIET_UTC[1];
      if (age < DUE_MS || (!quiet && age < 2 * DUE_MS)) return;
      await beforeBackup();
      const t0 = Date.now();
      const r = await runBackup(cfg, dataDir);
      console.log(`[backup] ${r.key}: ${(r.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        (r.pruned ? `, ${r.pruned} old one(s) removed` : ''));
    } catch (e) {
      console.error('[backup] failed:', e);
      // At most one email a day, however many hourly retries fail.
      if (Date.now() - lastFailureAt > DAY_MS) { lastFailureAt = Date.now(); onFailure(e); }
    } finally {
      running = false;
    }
  }
  setTimeout(check, 2 * 60 * 1000).unref();
  setInterval(check, CHECK_MS).unref();
  return { check };
}

// --- command line -------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = backupConfig();
  if (!cfg) { console.error('BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set'); process.exit(1); }
  const [cmd, a, b] = process.argv.slice(2);
  const dataDir = process.env.KLAXON_DATA_DIR || '/data';
  try {
    if (cmd === 'list') {
      for (const x of await listBackups(cfg)) console.log(`${new Date(x.lastModified).toISOString()}  ${(x.size / 1e6).toFixed(1).padStart(7)} MB  ${x.key}`);
    } else if (cmd === 'now') {
      console.log(await runBackup(cfg, dataDir));
    } else if (cmd === 'get' && a && b) {
      const res = await s3(cfg, 'GET', a);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(b, Buffer.from(await res.arrayBuffer()));
      console.log(`saved ${a} to ${b}`);
    } else {
      console.error('usage: node server/backup.js list | now | get KEY FILE');
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
