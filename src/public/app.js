const $ = (id) => document.getElementById(id);
let modelStatus = null;
let working = false;
let loadingModel = false;
let draftText = '';
let catalogueReady = false;

async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}

function error(message = '') { $('request-error').textContent = message; $('request-error').hidden = !message; }
function updateButtons() {
  const busy = working || loadingModel || Boolean(modelStatus?.busy);
  $('load-model').disabled = busy || modelStatus?.phase === 'ready';
  $('unload-model').disabled = busy || !modelStatus?.modelId;
  $('prepare').disabled = busy || !catalogueReady || !modelStatus?.modelId;
  $('short-stock').disabled = busy;
  for (const id of ['message', 'sku', 'quantity', 'zone', 'date']) $(id).disabled = busy;
}

function setEmptyState(title, message) {
  $('empty-title').textContent = title;
  $('empty-message').textContent = message;
}

function clearDraft() {
  draftText = '';
  $('result').hidden = true;
  $('empty-result').hidden = false;
  setEmptyState('The details first. The quote next.', 'Your request has changed. Prepare a new draft to check the updated details.');
  $('copy-quote').disabled = true;
  $('download-quote').disabled = true;
  $('copy-status').textContent = '';
  $('trace-body').replaceChildren();
  $('trace-empty').hidden = false;
  $('trace-summary').textContent = 'No checks for this request yet. Prepare a draft to see the actual calls.';
  $('raw-details').hidden = true;
}

function renderEstimate(result) {
  const { facts = {}, totals, request } = result;
  const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: result.currency || facts.get_price?.currency || 'USD' }).format(cents / 100);
  const checks = [
    { label: 'Stock', fact: facts.check_stock, passed: facts.check_stock?.sufficient, detail: facts.check_stock ? `${facts.check_stock.available} available · ${request.quantity} requested` : 'Not verified' },
    { label: 'Price', fact: facts.get_price, passed: Boolean(facts.get_price), detail: facts.get_price ? `${money(facts.get_price.unitCents)} each` : 'Not verified' },
    { label: 'Delivery', fact: facts.check_delivery, passed: facts.check_delivery?.supported, detail: facts.check_delivery ? facts.check_delivery.supported ? 'Date available' : 'Unavailable' : 'Not verified' }
  ];
  $('verified-checks').replaceChildren(...checks.map((check) => {
    const item = document.createElement('div');
    item.className = 'verified-check';
    item.dataset.state = !check.fact ? 'pending' : check.passed ? 'pass' : 'fail';
    const title = document.createElement('strong');
    const symbol = document.createElement('span');
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = !check.fact ? '○' : check.passed ? '✓' : '×';
    const label = document.createElement('span');
    label.textContent = `${check.label}: ${!check.fact ? 'unverified' : check.passed ? 'checked' : 'review'}`;
    title.append(symbol, label);
    const detail = document.createElement('p');
    detail.textContent = check.detail;
    item.append(title, detail);
    return item;
  }));
  const ready = result.status === 'draft_ready' && Boolean(totals);
  $('result').dataset.state = ready ? 'ready' : 'review';
  $('estimate-content').hidden = !ready;
  if (!ready) return;
  const price = facts.get_price;
  const delivery = facts.check_delivery;
  $('estimate-item-name').textContent = facts.check_stock.name;
  $('estimate-item-detail').textContent = `${request.quantity} × ${money(price.unitCents)} each · ${request.sku}`;
  $('estimate-subtotal').textContent = money(totals.subtotalCents);
  $('estimate-tax-label').textContent = `Item tax (${price.taxBasisPoints / 100}%)`;
  $('estimate-tax').textContent = money(totals.taxCents);
  $('estimate-delivery').textContent = money(totals.deliveryCents);
  $('estimate-total').textContent = money(totals.totalCents);
  $('estimate-currency').textContent = result.currency;
  $('estimate-delivery-date').textContent = new Date(`${delivery.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const zone = [...$('zone').options].find((option) => option.value === delivery.zone)?.textContent || delivery.zone;
  $('estimate-delivery-window').textContent = `${delivery.window} UTC · ${zone}`;
}

async function refreshStatus() {
  try {
    modelStatus = await api('/api/status');
    const state = modelStatus;
    $('model-status').textContent = state.busy ? (state.stage || 'Preparing the quote…') : state.phase === 'ready' ? `${state.model} is loaded. Inference runs on this device.` : state.phase === 'loading' ? `Loading local model${state.progress == null ? '' : ` (${state.progress}%)`}…` : state.phase === 'error' ? `Model error: ${state.error}` : 'The model is not loaded.';
    $('engine-state').textContent = state.busy ? 'Working' : state.phase === 'ready' ? 'Ready' : state.phase === 'loading' ? 'Loading' : state.phase === 'error' ? 'Needs attention' : 'Not loaded';
    $('engine-state').dataset.state = state.busy ? 'loading' : state.phase;
    updateButtons();
  } catch (failure) {
    $('model-status').textContent = `Cannot reach the local app: ${failure.message}`;
    $('engine-state').textContent = 'Disconnected';
    $('engine-state').dataset.state = 'error';
  }
}

async function setup() {
  try {
    const catalog = await api('/api/catalog');
    for (const item of catalog.items) $('sku').add(new Option(item.name, item.sku));
    for (const zone of catalog.zones) $('zone').add(new Option(zone.name, zone.id));
    $('date').value = catalog.defaultDate;
    $('date').min = catalog.today;
    const max = new Date(`${catalog.today}T00:00:00Z`);
    max.setUTCDate(max.getUTCDate() + catalog.horizonDays);
    $('date').max = max.toISOString().slice(0, 10);
    catalogueReady = true;
    await refreshStatus();
  } catch (failure) { error(`Setup failed: ${failure.message}`); }
}

$('load-model').addEventListener('click', async () => {
  error();
  loadingModel = true;
  updateButtons();
  $('model-status').textContent = 'Starting QVAC and loading model weights…';
  $('engine-state').textContent = 'Loading';
  $('engine-state').dataset.state = 'loading';
  try { await api('/api/model/load', {}); }
  catch (failure) { error(`Model load failed: ${failure.message}`); }
  finally { loadingModel = false; await refreshStatus(); }
});

$('unload-model').addEventListener('click', async () => {
  error();
  loadingModel = true;
  updateButtons();
  try { await api('/api/model/unload', {}); }
  catch (failure) { error(`Unload failed: ${failure.message}`); }
  finally { loadingModel = false; await refreshStatus(); }
});

$('short-stock').addEventListener('click', () => {
  clearDraft();
  error();
  $('message').value = 'I need six red chairs delivered to the central zone.';
  $('sku').value = 'CHAIR-RED';
  $('quantity').value = '6';
  $('zone').value = 'central';
  $('quantity').focus();
});

for (const id of ['message', 'sku', 'quantity', 'zone', 'date']) $(id).addEventListener('input', () => { if (!working) clearDraft(); });

$('quote-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (working) return;
  error();
  working = true;
  draftText = '';
  $('copy-quote').disabled = true;
  $('download-quote').disabled = true;
  $('result-region').setAttribute('aria-busy', 'true');
  $('result').hidden = true;
  $('empty-result').hidden = false;
  setEmptyState('Checking the details.', 'Your local model is choosing tools. Checks run together when the model returns them in one turn.');
  $('trace-body').replaceChildren();
  $('trace-summary').textContent = 'Waiting for real model tool calls…';
  $('trace-empty').hidden = true;
  $('raw-details').hidden = true;
  $('copy-status').textContent = '';
  updateButtons();
  try {
    const request = { message: $('message').value, sku: $('sku').value, quantity: Number($('quantity').value), zone: $('zone').value, deliveryDate: $('date').value };
    const result = await api('/api/quote', request);
    $('empty-result').hidden = true;
    $('result').hidden = false;
    $('result-status').textContent = result.status === 'draft_ready' ? 'Draft ready for your review' : 'Needs review before a quote can be prepared';
    $('problems').replaceChildren(...result.problems.map((problem) => { const item = document.createElement('li'); item.textContent = problem; return item; }));
    $('problems').hidden = result.problems.length === 0;
    renderEstimate(result);
    draftText = result.text || '';
    $('quote-text').textContent = draftText;
    $('copy-quote').disabled = !draftText;
    $('download-quote').disabled = !draftText;
    $('model-note').textContent = result.assistantNoteError ? `The optional model note failed: ${result.assistantNoteError}. The quote uses verified tool results.` : result.assistantNote || 'The model did not add a note.';
    $('trace-summary').textContent = `${result.trace.length} real tool calls. Largest model-selected batch: ${result.largestBatch}. Total request time: ${(result.elapsedMs / 1000).toFixed(2)} seconds. Parallel calls were enabled; the model chooses the batch size. Handler timings measure local file checks, not cloud requests.`;
    for (const entry of result.trace) {
      const tr = document.createElement('tr');
      const outcome = !entry.ok ? `Refused: ${entry.error}` : entry.result.sufficient === false ? 'Insufficient stock' : entry.result.supported === false ? entry.result.reason : 'Checked';
      for (const [index, value] of [String(entry.round), entry.name, JSON.stringify(entry.arguments), outcome, `${entry.durationMs.toFixed(3)} ms`].entries()) { const td = document.createElement('td'); td.textContent = value; if (index === 3) td.dataset.outcome = !entry.ok || entry.result.sufficient === false || entry.result.supported === false ? 'fail' : 'pass'; tr.append(td); }
      $('trace-body').append(tr);
    }
    $('raw-output').textContent = JSON.stringify(result, null, 2);
    $('raw-details').hidden = false;
  } catch (failure) {
    error(`Quote failed: ${failure.message}`);
    setEmptyState('Let’s try that again.', 'No draft was prepared. Fix the problem shown by your request, then try again.');
    $('trace-empty').hidden = false;
    $('trace-summary').textContent = 'The request did not complete. No quote has been sent or reserved.';
  } finally {
    working = false;
    $('result-region').setAttribute('aria-busy', 'false');
    await refreshStatus();
  }
});

$('copy-quote').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(draftText); $('copy-status').textContent = 'Draft copied. Review it before sharing.'; }
  catch { $('copy-status').textContent = 'Clipboard access failed. Select the draft text and copy it, or download the draft.'; }
});

$('download-quote').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([draftText], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'quotemine-draft.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

await setup();
setInterval(() => { if (working || loadingModel || modelStatus?.phase === 'loading') void refreshStatus(); }, 1200);
