import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {mode:0o600});
  fs.renameSync(tmp, file);
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/,'')); } catch { return fallback; }
}
export function digest(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
export function isInside(root, file) {
  const r = path.relative(root, file);
  return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r));
}
export function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new HttpError(400, '无效的标识');
  return value;
}
export function redact(text) {
  return String(text).replace(/(Bearer\s+)[^\s"']+/gi,'$1[hidden]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|cookie)\s*[=:]\s*["']?)[^\s,"'}]+/gi,'$1[hidden]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[hidden]');
}
export function jsonResponse(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
}
export async function bodyJson(req, max = 128 * 1024) {
  let size = 0; const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, '请求过大');
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'JSON 格式错误'); }
}
export function originCheck(req, localPort) {
  const host = req.headers.host || '';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const localHost = [`localhost:${localPort}`,`127.0.0.1:${localPort}`,`[::1]:${localPort}`].includes(host);
  const origin = req.headers.origin;
  if (origin) {
    let o; try { o = new URL(origin); } catch { throw new HttpError(403, '来源不匹配'); }
    // A request from the HTTPS Tailscale reverse proxy retains the external Host.
    if (o.host !== host) throw new HttpError(403, '来源不匹配');
  }
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && !origin && req.headers['x-bridges-client'] !== '1') {
    throw new HttpError(403, '缺少请求来源');
  }
  return local && localHost && !req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'];
}
