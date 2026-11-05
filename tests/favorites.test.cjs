// Run with: node tests/favorites.test.cjs (no packages or real accounts needed).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const menu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'menu.json'), 'utf8'));
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);
scripts.forEach(source => new vm.Script(source));
const source = scripts.find(script => script.includes('const GUEST_FAVORITES_KEY'));
let document;
class Node {
  constructor(tag = '') { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.value = ''; this.hidden = false; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || ''; }
  append(...nodes) { nodes.forEach(node => { this.children.push(node); node.parent = this; }); }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  focus() { document.activeElement = this; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll() { return this.children.flatMap(child => [...(child.dataset.favoriteKey ? [child] : []), ...child.querySelectorAll()]); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
}
const ids = {};
for (const match of html.matchAll(/id="([^"]+)"/g)) ids[match[1]] = new Node(match[1]);
document = {
  activeElement: null,
  getElementById: id => ids[id],
  createElement: tag => new Node(tag),
  querySelectorAll: () => Object.values(ids).flatMap(node => node.querySelectorAll())
};
const storage = new Map();
let storageFails = false;
const localStorage = {
  getItem: key => storage.get(key) || null,
  setItem(key, value) { if (storageFails) throw Error('quota'); storage.set(key, value); },
  removeItem: key => storage.delete(key)
};
const backend = {
  rows: new Map(), calls: [], failNext: false, holdNext: false, release: null,
  async run(query) {
    this.calls.push(query);
    if (this.holdNext) { this.holdNext = false; return new Promise(resolve => { this.release = resolve; }); }
    if (this.failNext) { this.failNext = false; return {error: Error('network')}; }
    if (query.operation === 'select') {
      const userId = query.filters.user_id;
      return {data: [...this.rows.values()].filter(row => row.user_id === userId).slice(query.start, query.end + 1), error: null};
    }
    if (query.operation === 'insert') {
      for (const row of [query.body].flat()) {
        const key = row.user_id + '/' + row.recipe_key;
        if (!this.rows.has(key)) this.rows.set(key, {...row, created_at: new Date().toISOString()});
      }
    } else if (query.operation === 'delete') this.rows.delete(query.filters.user_id + '/' + query.filters.recipe_key);
    return {error: null};
  }
};
class Query {
  constructor() { this.filters = {}; this.start = 0; this.end = 99; }
  select() { this.operation = 'select'; return this; }
  upsert(body, options) { this.operation = 'insert'; this.body = body; assert.equal(options.ignoreDuplicates, true); return this; }
  delete() { this.operation = 'delete'; return this; }
  eq(key, value) { this.filters[key] = value; return this; }
  order() { return this; }
  range(start, end) { this.start = start; this.end = end; return this; }
  then(resolve, reject) { return backend.run(this).then(resolve, reject); }
}
const windowListeners = {};
const context = vm.createContext({
  document, localStorage, Blob, Date,
  window: {addEventListener: (type, listener) => { windowListeners[type] = listener; }},
  location: {protocol: 'http:'},
  authClient: {from: table => { assert.equal(table, 'favorites'); return new Query(); }},
  fetch: async () => ({ok: true, json: async () => menu})
});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);
context.recipeA = menu.recipes[0]; context.recipeB = menu.recipes[1]; context.recipeC = menu.recipes[2];
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  await tick();
  const keyA = run('recipeFavoriteKey(recipeA)');
  const keyB = run('recipeFavoriteKey(recipeB)');
  const storageKey = run('GUEST_FAVORITES_KEY');
  await run('toggleFavorite({...recipeA,alternative_notes:["private preference"],score:99})');
  assert.equal(run('favoriteEntries.size'), 1);
  assert(!storage.get(storageKey).includes('private preference'));
  assert(!storage.get(storageKey).includes('score'));
  assert.equal(backend.calls.length, 0, 'Guest favorites must not use the account API');
  await run('toggleFavorite(recipeA)');
  assert.equal(run('favoriteEntries.size'), 0);
  storageFails = true;
  await run('toggleFavorite(recipeA)');
  assert.equal(run('favoriteEntries.size'), 0, 'Quota failure must roll back optimistic add');
  storageFails = false;
  await run('toggleFavorite(recipeA)'); await run('toggleFavorite(recipeB)');
  const savedGuestJSON = storage.get(storageKey);
  await run('switchFavoriteUser({id:"user-a"})');
  assert.equal(run('favoriteEntries.size'), 0, 'Account view must not expose guest items as server-saved');
  assert.equal(storage.get(storageKey), savedGuestJSON);
  backend.holdNext = true;
  const pendingAdd = run('toggleFavorite(recipeA)'); await tick();
  assert.equal(run('favoriteEntries.has(recipeFavoriteKey(recipeA))'), true, 'Heart updates before the network response');
  assert.equal(run('favoritePending.size'), 1);
  backend.release({error: Error('offline')}); await pendingAdd;
  assert.equal(run('favoriteEntries.size'), 0, 'Rejected add rolls back');
  await run('toggleFavorite(recipeA)');
  assert(backend.rows.has('user-a/' + keyA));
  backend.holdNext = true;
  const pendingDelete = run('toggleFavorite(recipeA)'); await tick();
  assert.equal(run('favoriteEntries.size'), 0, 'Delete is optimistic');
  backend.release({error: Error('offline')}); await pendingDelete;
  assert.equal(run('favoriteEntries.size'), 1, 'Rejected delete restores the recipe');
  backend.rows.set('user-b/' + keyB, {user_id: 'user-b', recipe_key: keyB, recipe: menu.recipes[1], created_at: new Date().toISOString()});
  backend.holdNext = true;
  const staleWrite = run('toggleFavorite(recipeC)'); await tick();
  await run('switchFavoriteUser({id:"user-b"})');
  backend.release({error: Error('old user request')}); await staleWrite;
  assert.equal(run('favoriteEntries.size'), 1);
  assert.equal(run('favoriteEntries.has(recipeFavoriteKey(recipeB))'), true, 'An old account response cannot overwrite the new account');
  await run('switchFavoriteUser(null)');
  assert.equal(run('favoriteEntries.size'), 2, 'Logout restores guest favorites, not account cache');
  await run('switchFavoriteUser({id:"user-a"})');
  await run('importGuestFavorites()');
  assert.equal(run('favoriteEntries.size'), 2);
  assert.equal(storage.has(storageKey), false, 'Guest storage is cleared after successful explicit import');
  assert(backend.rows.has('user-a/' + keyA)); assert(backend.rows.has('user-a/' + keyB));
  storage.set(storageKey, savedGuestJSON);
  backend.failNext = true;
  await run('importGuestFavorites()');
  assert.equal(storage.get(storageKey), savedGuestJSON, 'Failed import preserves source records');
  backend.failNext = true;
  await run('loadAccountFavorites(favoriteEpoch,favoriteUserId)');
  assert.equal(run('favoriteLoadError'), true);
  assert.equal(run('makeFavoriteButton(recipeA).disabled'), true, 'An incomplete server list cannot be toggled');
  await run('loadAccountFavorites(favoriteEpoch,favoriteUserId)');
  assert.equal(run('favoriteLoadError'), false);
  await run('switchFavoriteUser(null)');
  storage.set(storageKey, '[]'); windowListeners.storage({key: storageKey});
  assert.equal(run('favoriteEntries.size'), 0, 'Guest updates synchronize across tabs');
  run('setFavoritesView(true)'); assert.equal(ids['favorites-view'].hidden, false); assert.equal(ids['menu-view'].hidden, true);
  run('setFavoritesView(false)'); assert.equal(ids['menu-view'].hidden, false);
  assert.notEqual(run('recipeFavoriteKey(basicSeasonalRecipes(1,["무"])[0])'), run('recipeFavoriteKey(basicSeasonalRecipes(1,["시금치"])[0])'));
  for (const recipe of menu.supplemental.months.flatMap(month => month.recipes)) { context.testRecipe = recipe; assert(run('recipeFavoriteKey(testRecipe).length <= 512')); }
  console.log('PASS: guest save/remove/persistence/quota rollback; private snapshot fields omitted; optimistic account add/delete and rollback; user-switch race isolation; explicit import/idempotency/source preservation; load failure/retry; cross-tab guest sync; library navigation; generated recipe identity.');
})().catch(error => { console.error(error); process.exitCode = 1; });
