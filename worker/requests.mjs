// Booking requests (the "заявки") on Cloudflare KV.
//   req:<id>       the request record (owner view is the whole record)
//   cl:<tokenHash> {ids:[...]}  the requests of one client, found by their private token
// Single owner, low volume: plain read-modify-write, no locking.
// Retention: records live 400 days after they are written.
import { randomToken, sha256Hex } from './auth.mjs';

export const STATUSES = ['new', 'needs_details', 'confirmed', 'declined', 'cancelled', 'done'];
export const OPEN_STATUSES = ['new', 'needs_details'];
export const RETENTION_S = 400 * 86400;
const MAX_LIST = 300;

const putJson = (kv, key, v) => kv.put(key, JSON.stringify(v), { expirationTtl: RETENTION_S });

export async function getRequest(kv, id) {
  return (await kv.get(`req:${id}`, 'json')) ?? null;
}

export async function saveRequest(kv, rec) {
  await putJson(kv, `req:${rec.id}`, rec);
  return rec;
}

// Stores a new record and links it to a client token. A client who already has
// a token (sent by their browser) keeps it, so all their requests show together.
export async function createRequest(kv, rec, existingToken) {
  let token = existingToken ?? null;
  let hash = token ? await sha256Hex(token) : null;
  let index = hash ? await kv.get(`cl:${hash}`, 'json') : null;
  if (!index) { token = randomToken(); hash = await sha256Hex(token); index = { ids: [] }; }
  const record = { ...rec, clientHash: hash, ownerNote: '', messageToClient: '', reminders: [], updatedAt: rec.createdAt };
  await saveRequest(kv, record);
  index.ids = [...index.ids, record.id].slice(-50);
  await putJson(kv, `cl:${hash}`, index);
  return { record, token };
}

export async function listForClient(kv, token) {
  const index = await kv.get(`cl:${await sha256Hex(token)}`, 'json');
  if (!index) return null;
  const recs = await Promise.all(index.ids.map((id) => getRequest(kv, id)));
  return recs.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// What a client may see: nothing owner-private (notes, reminders, hashes).
export function clientView(r) {
  return {
    id: r.id, createdAt: r.createdAt, status: r.status, serviceLabel: r.serviceLabel, hours: r.hours,
    addons: r.addons, totalAed: r.totalAed, start: r.start, notes: r.notes,
    message: r.messageToClient || '',
  };
}

export async function listAll(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'req:', cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && keys.length < MAX_LIST);
  const recs = await Promise.all(keys.slice(0, MAX_LIST).map((k) => kv.get(k, 'json')));
  return recs.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const adminView = ({ clientHash, ...r }) => r;
