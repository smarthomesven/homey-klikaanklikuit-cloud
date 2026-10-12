'use strict';

const crypto = require('crypto');
const axios = require('axios');
const qs = require('querystring');
const util = require('util');

const BASE = 'https://trustsmartcloud2.com/ics2000_api';
const HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ktor-client' };
const POLL_MS = 20000;

// `device` code in the decrypted module data -> driver type.
const DEVICE_TYPES = { 
    33: 'plug',
    41: 'socket-switch'
  };

class KakuApi {
  constructor(homey) {
    this.homey = homey;
    this.homes = new Map(); // home_id -> { home_id, home_name, mac, aes_key, counters }
    this.subs = new Map();  // home_id -> Map(moduleId -> { cb, version })
    this._chain = Promise.resolve();
    this._polling = false;
    this._timer = null;
  }

  homeIds() {
    return [...this.homes.keys()];
  }

  // ---------- account ----------

  async login(email, password) {
    const data = await this._post('account.php', {
      email,
      password_hash: password,
      platform: 'Android',
      fcm_token: null,
      device_unique_id: this.homey.settings.get('unique_id'),
      action: 'login',
    });
    if (!data || !Array.isArray(data.homes) || data.homes.length === 0) {
      throw new Error('Login failed or no homes on this account');
    }
    this.homey.settings.set('email', email);
    this.homey.settings.set('password', password);
    this.homes = new Map(data.homes.map((h) => [String(h.home_id), { ...h, counters: [0, 0, 0] }]));
    return data;
  }

  async _home(homeId) {
    if (!this.homes.has(String(homeId))) {
      await this.login(this.homey.settings.get('email'), this.homey.settings.get('password'));
    }
    const home = this.homes.get(String(homeId));
    if (!home) throw new Error(`Unknown home ${homeId}`);
    return home;
  }

  _cred() {
    return { email: this.homey.settings.get('email'), password: this.homey.settings.get('password') };
  }

  // ---------- reading ----------

  // Returns every decrypted `module` object from a sync. Rooms and zones decode to
  // {room: ...} / {zone: ...} and are skipped. The caller filters by DEVICE_TYPES.
  async listModules(homeId) {
    const home = await this._home(homeId);
    const { email, password } = this._cred();
    const entities = await this._post('gateway.php', {
      email, mac: home.mac, password_hash: password, home_id: home.home_id, action: 'sync',
    });
    const modules = [];
    for (const e of entities) {
      if (!e.data) continue;
      const decoded = this._decrypt(home, e.data);
      if (decoded.module) modules.push(decoded.module);
    }
    return modules;
  }

  async getStatuses(homeId, ids) {
    const home = await this._home(homeId);
    const { email, password } = this._cred();
    return this._post('entity.php', {
      email, mac: home.mac, password_hash: password, home_id: home.home_id,
      entity_id: JSON.stringify(ids), action: 'get-multiple',
    });
  }

  // ---------- commands ----------

  // Commands are serialized because each packet echoes the counters from the previous confirmation.
  setFunction(homeId, entityId, fn, value, timeoutMs = 10000) {
    return this._enqueue(async () => {
      const home = await this._home(homeId);
      const { email, password } = this._cred();
      const auth = { email, mac: home.mac, password_hash: password, home_id: home.home_id };

      const [commandId] = await this._post('command.php', {
        ...auth, command: this._packet(home, entityId, fn, value), action: 'add',
      });

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [state, hex] = await this._post('command.php', {
          ...auth, action: 'hex-check', command_id: commandId,
        });
        if (state === 'confirmed') {
          const r = Buffer.from(hex, 'hex');
          home.counters = [13, 17, 21].map((o) => r.readUInt32LE(o));
          return r.readUInt32LE(37) === Number(commandId);
        }
        if (state !== 'pending') throw new Error(`Command ${commandId} ended as "${state}"`);
        await new Promise((resolve) => this.homey.setTimeout(resolve, 300));
      }
      throw new Error(`Command ${commandId} was not confirmed in time`);
    });
  }

  // ---------- polling ----------

  subscribe(homeId, moduleId, cb) {
    const key = String(homeId);
    if (!this.subs.has(key)) this.subs.set(key, new Map());
    this.subs.get(key).set(Number(moduleId), { cb, version: null });
    if (!this._timer) this._timer = this.homey.setInterval(() => this.poll(), POLL_MS);
    this.homey.setTimeout(() => this.poll(), 1000);
    return () => this.subs.get(key)?.delete(Number(moduleId));
  }

  async poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      for (const [homeId, subs] of this.subs) {
        if (subs.size === 0) continue;
        const list = await this.getStatuses(homeId, [...subs.keys()]);
        const home = this.homes.get(homeId);
        for (const s of list) {
          const sub = subs.get(Number(s.id));
          if (!sub || !s.status || s.status_version === sub.version) continue;
          sub.version = s.status_version;
          sub.cb(this._decrypt(home, s.status).module.functions);
        }
      }
    } catch (err) {
      console.error('Poll failed:', err.message);
    } finally {
      this._polling = false;
    }
  }

  // ---------- internals ----------

  async _post(file, params) {
    try {
        const res = await axios.post(`${BASE}/${file}`, qs.stringify(params), { headers: HEADERS, timeout: 15000 });
        return res.data;
    } catch (error) {
        if (error.response?.data) {
            const sent = { ...params };
            for (const k of ['password', 'password_hash']) if (sent[k] !== undefined) sent[k] = '***';
            if (sent.command) sent.command = `${sent.command.slice(0, 12)}… (${sent.command.length} chars)`;
            throw new Error(`${file} ${params.action}: HTTP ${error.response?.status} ${JSON.stringify(error.response?.data)} | sent ${util.inspect(sent, { breakLength: Infinity })}`);
        } else {
            throw new Error(`HTTP request failed: ${error.message}`);
        }
    }
  }

  _enqueue(fn) {
    const run = this._chain.then(fn);
    this._chain = run.catch(() => {});
    return run;
  }

  // Payload framing: 16 random bytes + JSON, AES-128-CBC, zero IV, PKCS#7.
  _decrypt(home, b64) {
    const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(home.aes_key, 'hex'), Buffer.alloc(16));
    const buf = Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]);
    return JSON.parse(buf.subarray(16).toString('utf8'));
  }

  _encrypt(home, obj) {
    const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(home.aes_key, 'hex'), Buffer.alloc(16));
    const plain = Buffer.concat([crypto.randomBytes(16), Buffer.from(JSON.stringify(obj))]);
    return Buffer.concat([c.update(plain), c.final()]);
  }

  // Command packet layout:
  //   0   3  01 00 80
  //   3   6  gateway MAC
  //   9   4  unknown, differs per packet (sent as random bytes here)
  //   13  4  u32 LE counter  \
  //   17  4  u32 LE counter   > echoed from the previous confirmation (0 right after app start)
  //   21  4  u32 LE (always 4) /
  //   25  4  zeros
  //   29  4  entity id, u32 LE
  //   33  8  zeros
  //   41  2  u16 LE payload length
  //   43  n  encrypted {"module":{"id":..,"function":..,"value":..}}
  _packet(home, entityId, fn, value) {
    const payload = this._encrypt(home, { module: { id: Number(entityId), function: fn, value } });
    const b = Buffer.alloc(43 + payload.length);
    b[0] = 0x01; b[1] = 0x00; b[2] = 0x80;
    Buffer.from(home.mac, 'hex').copy(b, 3);
    crypto.randomBytes(4).copy(b, 9);
    home.counters.forEach((v, i) => b.writeUInt32LE(v, 13 + i * 4));
    b.writeUInt32LE(Number(entityId), 29);
    b.writeUInt16LE(payload.length, 41);
    payload.copy(b, 43);
    return b.toString('hex').toUpperCase();
  }
}

module.exports = { KakuApi, DEVICE_TYPES };