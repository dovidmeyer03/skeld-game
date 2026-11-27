// End to end through the worker's real fetch handler, offline: in-memory Durable Object stubs, DRYRUN=1, no AI binding.
import worker, { BudgetCounter, TestRoom } from '../src/index.js';
function stubNamespace(Cls) {
  const objs = new Map();
  const storage = () => { const m = new Map(); const api = { get: async k => m.get(k), put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); } }; return Object.assign({ transaction: async fn => fn(api) }, api); };
  return { idFromName: n => n, get: id => { if (!objs.has(id)) objs.set(id, new Cls({ storage: storage() })); const o = objs.get(id); return { fetch: (url, init) => o.fetch(new Request(url, init)) }; } };
}
export function makeEnv() { return { DRYRUN: '1', TEST_KEY: 'offline-test-key', BUDGET: stubNamespace(BudgetCounter), ROOMS: stubNamespace(TestRoom) }; }
export async function post(env, body) {
  const r = await worker.fetch(new Request('https://x/room/TESTAI1/ai', { method: 'POST', headers: { 'X-Test-Key': 'offline-test-key', 'X-Host-Token': 'offline_host_token_0123456789' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env);
  return { status: r.status, json: await r.json() };
}
