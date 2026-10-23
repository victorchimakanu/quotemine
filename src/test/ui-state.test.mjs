import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const checkedQuote = {
  status: 'draft_ready', problems: [], currency: 'USD',
  request: { message: 'Six blue chairs', sku: 'CHAIR-BLUE', quantity: 6, zone: 'central', deliveryDate: '2026-10-23' },
  facts: {
    check_stock: { name: 'Blue stack chair', available: 12, sufficient: true },
    get_price: { unitCents: 4250, currency: 'USD', taxBasisPoints: 750 },
    check_delivery: { supported: true, date: '2026-10-23', zone: 'central', window: '09:00 to 17:00' }
  },
  totals: { subtotalCents: 25500, taxCents: 1913, deliveryCents: 1500, totalCents: 28913 },
  text: 'DRAFT QUOTE\nTotal: $289.13 USD',
  trace: [{ round: 1, name: 'check_stock', arguments: { sku: 'CHAIR-BLUE', quantity: 6 }, ok: true, result: { sufficient: true }, durationMs: .012 }],
  largestBatch: 3, elapsedMs: 1000, assistantNote: 'Review the checked details.'
};

async function browserHarness() {
  class Element {
    constructor() { this.value = ''; this.children = []; this.listeners = {}; this.hidden = false; this.options = []; this.dataset = {}; this.textContent = ''; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    add(option) { this.options.push(option); if (!this.value) this.value = option.value; }
    setAttribute(name, value) { this[name] = value; }
    focus() {}
  }
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  element('quantity').value = '6';
  element('message').value = 'Six blue chairs';
  const responses = [];
  const reply = data => ({ ok: true, json: async () => data });
  await runInNewContext(`(async () => {${script}\n})()`, {
    document: { getElementById: element, createElement: () => new Element() },
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    fetch: async path => {
      if (path === '/api/status') return reply({ phase: 'ready', modelId: 'fixture-model', model: 'fixture' });
      if (path === '/api/catalog') return reply({ items: [{ name: 'Blue stack chair', sku: 'CHAIR-BLUE' }], zones: [{ name: 'Central zone', id: 'central' }], defaultDate: '2026-10-23', today: '2026-10-22', horizonDays: 30 });
      if (path === '/api/quote') return await responses.shift()();
      throw new Error(`Unexpected test URL: ${path}`);
    },
    setInterval: () => 1, setTimeout: () => 1, Intl, Date
  });
  return { element, responses, reply, submit: () => element('quote-form').listeners.submit({ preventDefault() {} }), click: id => element(id).listeners.click(), input: id => element(id).listeners.input() };
}

test('the visual estimate uses checked cents and retains the exact plain draft', async () => {
  const ui = await browserHarness();
  ui.responses.push(() => ui.reply(checkedQuote));
  await ui.submit();
  assert.equal(ui.element('estimate-total').textContent, '$289.13');
  assert.equal(ui.element('estimate-tax').textContent, '$19.13');
  assert.equal(ui.element('estimate-tax-label').textContent, 'Item tax (7.5%)');
  assert.equal(ui.element('quote-text').textContent, checkedQuote.text);
  assert.equal(ui.element('estimate-content').hidden, false);
  assert.equal(ui.element('copy-quote').disabled, false);
  assert.equal(ui.element('trace-body').children.length, 1);
  assert.equal(ui.element('verified-checks').children.length, 3);
});

test('low stock cannot leave a prior successful total or draft available', async () => {
  const ui = await browserHarness();
  ui.responses.push(() => ui.reply(checkedQuote));
  await ui.submit();
  ui.responses.push(() => ui.reply({ ...checkedQuote, status: 'needs_review', totals: null, text: null, problems: ['Only 3 units are available.'], facts: { ...checkedQuote.facts, check_stock: { name: 'Red stack chair', available: 3, sufficient: false } } }));
  await ui.submit();
  assert.equal(ui.element('result').dataset.state, 'review');
  assert.equal(ui.element('estimate-content').hidden, true);
  assert.equal(ui.element('copy-quote').disabled, true);
  assert.equal(ui.element('download-quote').disabled, true);
  assert.equal(ui.element('quote-text').textContent, '');
  assert.equal(ui.element('problems').hidden, false);
  assert.equal(ui.element('verified-checks').children[0].dataset.state, 'fail');
});

test('changing confirmed inputs or using low-stock sample invalidates the previous draft', async () => {
  const ui = await browserHarness();
  for (const id of ['message', 'sku', 'quantity', 'zone', 'date']) {
    ui.responses.push(() => ui.reply(checkedQuote));
    await ui.submit();
    ui.input(id);
    assert.equal(ui.element('result').hidden, true);
    assert.equal(ui.element('copy-quote').disabled, true);
    assert.equal(ui.element('download-quote').disabled, true);
    assert.equal(ui.element('trace-body').children.length, 0);
  }
  ui.responses.push(() => ui.reply(checkedQuote));
  await ui.submit();
  ui.click('short-stock');
  assert.equal(ui.element('sku').value, 'CHAIR-RED');
  assert.equal(ui.element('result').hidden, true);
  assert.equal(ui.element('copy-quote').disabled, true);
});
