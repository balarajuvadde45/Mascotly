// Minimal zero-dependency Redis client (RESP2 over TCP).
// Supports the commands Mascotly needs: SET/SETEX/GET/DEL/EXPIRE, HSET/HGETALL,
// LPUSH/LTRIM/LRANGE, SADD/SMEMBERS, PING. Enough for memory + KV usage without
// pulling a dependency; for advanced needs use the Upstash REST adapter instead.
import net from 'node:net';

export class RedisClient {
  constructor(url) {
    const u = new URL(url);
    if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new Error('MASCOT_REDIS_URL must be redis:// or rediss://');
    this.host = u.hostname || '127.0.0.1';
    this.port = Number(u.port) || 6379;
    this.password = u.password ? decodeURIComponent(u.password) : (u.searchParams.get('password') || '');
    this.tls = u.protocol === 'rediss:';
    this.connected = false;
    this._queue = [];
    this._buf = Buffer.alloc(0);
    this._waiters = [];
    this._socket = null;
  }

  connect() {
    if (this.connected) return Promise.resolve();
    if (this._connecting) return this._connecting;
    this._connecting = new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port, tls: this.tls ? { ...{} } : undefined });
      this._socket = socket;
      socket.setTimeout(8000, () => { socket.destroy(new Error('redis connect timeout')); });
      socket.on('error', (err) => { this.connected = false; reject(err); this._failWaiters(err); });
      socket.on('connect', () => {
        socket.setTimeout(0);
        const finish = () => { this.connected = true; resolve(); };
        if (this.password) {
          this._raw(['AUTH', this.password]).then(finish).catch(reject);
        } else finish();
      });
      socket.on('data', (chunk) => this._onData(chunk));
    });
    return this._connecting;
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    // Drain all complete replies currently buffered.
    while (this._waiters.length) {
      const parsed = this._tryParse();
      if (!parsed) break;
      const waiter = this._waiters.shift();
      waiter(parsed);
    }
  }

  _failWaiters(err) {
    while (this._waiters.length) this._waiters.shift()(null, err);
  }

  /** Try to parse one RESP reply from the buffer; null when incomplete. */
  _tryParse() {
    let pos = 0;
    const buf = this._buf;
    const readLine = () => {
      const idx = buf.indexOf('\r\n', pos);
      if (idx === -1) return null;
      const line = buf.slice(pos, idx).toString();
      pos = idx + 2;
      return line;
    };
    const parseReply = () => {
      if (pos >= buf.length) return null;
      const type = String.fromCharCode(buf[pos]);
      pos += 1;
      const line = readLine();
      if (line === null) return null;
      if (type === '+' || type === '-' || type === ':') return { value: line, simple: true };
      if (type === '$') {
        const len = parseInt(line, 10);
        if (len === -1) return { value: null };
        if (buf.length < pos + len + 2) return null;
        const value = buf.slice(pos, pos + len).toString();
        pos += len + 2;
        return { value };
      }
      if (type === '*') {
        const count = parseInt(line, 10);
        if (count === -1) return { value: null };
        const arr = [];
        for (let i = 0; i < count; i++) {
          const item = parseReply();
          if (item === null) return null;
          arr.push(item.value);
        }
        return { value: arr };
      }
      throw new Error(`Unexpected RESP type: ${type}`);
    };
    const parsed = parseReply();
    if (parsed === null) return null;
    this._buf = buf.slice(pos);
    return parsed;
  }

  _raw(args) {
    return new Promise((resolve, reject) => {
      if (!this._socket || this._socket.destroyed) {
        reject(new Error('redis not connected'));
        return;
      }
      const out = [`*${args.length}\r\n`];
      for (const a of args) {
        const s = String(a);
        out.push(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
      }
      this._waiters.push((reply, err) => {
        if (err) reject(err);
        else if (reply && reply.simple && String(reply.value).startsWith('-')) {
          reject(new Error('redis: ' + String(reply.value)));
        } else resolve(reply ? reply.value : null);
      });
      this._socket.write(out.join(''));
    });
  }

  async ensure() {
    await this.connect();
  }

  // ── command helpers (all async) ──
  async set(key, value, ttlSec) {
    await this.ensure();
    const args = ttlSec ? ['SET', key, value, 'EX', String(ttlSec)] : ['SET', key, value];
    return this._raw(args);
  }
  async get(key) { await this.ensure(); return this._raw(['GET', key]); }
  async del(key) { await this.ensure(); return this._raw(['DEL', key]); }
  async hset(key, field, value) { await this.ensure(); return this._raw(['HSET', key, field, value]); }
  async hgetall(key) {
    await this.ensure();
    const flat = await this._raw(['HGETALL', key]);
    const out = {};
    if (Array.isArray(flat)) {
      for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    }
    return out;
  }
  async lpush(key, value) { await this.ensure(); return this._raw(['LPUSH', key, value]); }
  async ltrim(key, start, stop) { await this.ensure(); return this._raw(['LTRIM', key, String(start), String(stop)]); }
  async lrange(key, start, stop) { await this.ensure(); return this._raw(['LRANGE', key, String(start), String(stop)]); }
  async ping() { await this.ensure(); return this._raw(['PING']); }

  close() {
    try { this._socket?.end(); } catch { /* noop */ }
    this.connected = false;
  }
}

let shared = null;
export function getRedis() {
  const url = process.env.MASCOT_REDIS_URL || process.env.REDIS_URL || '';
  if (!url) return null;
  if (!shared) {
    try {
      shared = new RedisClient(url);
    } catch (err) {
      console.warn(`[redis] ${err.message} — memory falls back to local storage`);
      shared = null;
    }
  }
  return shared;
}
