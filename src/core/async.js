// Array helpers for callbacks that wait (a database read inside .map, .filter ...). Each runs the
// callback for one item at a time, in order, exactly as the plain array method did when every read
// was synchronous: side effects keep their order and a transaction sees its writes in sequence.
// forEachAsync also walks a Map (value, key) and a Set (value, value) like their own forEach.

export async function mapAsync(list, fn) {
  const out = [];
  let i = 0;
  for (const x of list) out.push(await fn(x, i++, list));
  return out;
}

export async function flatMapAsync(list, fn) {
  return (await mapAsync(list, fn)).flat();
}

export async function filterAsync(list, fn) {
  const out = [];
  let i = 0;
  for (const x of list) if (await fn(x, i++, list)) out.push(x);
  return out;
}

export async function someAsync(list, fn) {
  let i = 0;
  for (const x of list) if (await fn(x, i++, list)) return true;
  return false;
}

export async function everyAsync(list, fn) {
  let i = 0;
  for (const x of list) if (!(await fn(x, i++, list))) return false;
  return true;
}

export async function findAsync(list, fn) {
  let i = 0;
  for (const x of list) if (await fn(x, i++, list)) return x;
  return undefined;
}

export async function findIndexAsync(list, fn) {
  let i = 0;
  for (const x of list) { if (await fn(x, i, list)) return i; i++; }
  return -1;
}

export async function reduceAsync(list, fn, ...init) {
  const items = [...list];
  let i = 0;
  let acc;
  if (init.length) acc = init[0];
  else {
    if (!items.length) throw new TypeError('Reduce of empty array with no initial value');
    acc = items[i++];
  }
  for (; i < items.length; i++) acc = await fn(acc, items[i], i, items);
  return acc;
}

export async function forEachAsync(list, fn) {
  if (list instanceof Map) { for (const [k, v] of list) await fn(v, k, list); return; }
  if (list instanceof Set) { for (const v of list) await fn(v, v, list); return; }
  let i = 0;
  for (const x of list) await fn(x, i++, list);
}
