const state = { instances: [], statuses: [], selected: null };
const connectButton = document.querySelector('#connect-button');
const connectionDot = document.querySelector('#connection-dot');
const connectionLabel = document.querySelector('#connection-label');
const modelSelect = document.querySelector('#model-select');
const modelCount = document.querySelector('#model-count');
const message = document.querySelector('#message');
const modelPanel = document.querySelector('#model-panel');
const statusSelect = document.querySelector('#status-select');

function setMessage(text) { message.textContent = text; }
function formatStatus(status) { return status.replaceAll('_', ' '); }
function selectInstance(qrCode) { state.selected = state.instances.find((instance) => instance.qrCode === qrCode); renderInstance(); }

function renderInstance() {
  const instance = state.selected;
  if (!instance) { modelPanel.hidden = true; return; }
  modelPanel.hidden = false;
  document.querySelector('#model-number').textContent = instance.modelNumber;
  document.querySelector('#model-name').textContent = instance.name;
  document.querySelector('#model-description').textContent = instance.description || 'No description provided.';
  document.querySelector('#model-location').textContent = instance.location || 'Unassigned';
  document.querySelector('#model-qr').textContent = instance.qrCode;
  document.querySelector('#status-badge').textContent = formatStatus(instance.status);
  document.querySelector('#status-badge').dataset.status = instance.status;
  document.querySelector('#qr-image').src = instance.qrImageUrl;
  statusSelect.value = instance.status;
}

async function connect() {
  connectButton.disabled = true;
  connectButton.innerHTML = 'Connecting <span aria-hidden="true">...</span>';
  try {
    const health = await fetch('/health');
    if (!health.ok) throw new Error('PowerFab is unavailable');
    const [instanceResponse, statusResponse] = await Promise.all([fetch('/api/instances'), fetch('/api/statuses')]);
    if (!instanceResponse.ok || !statusResponse.ok) throw new Error('Unable to load PowerFab data');
    state.instances = (await instanceResponse.json()).instances;
    state.statuses = (await statusResponse.json()).statuses;
    modelSelect.replaceChildren(...state.instances.map((instance) => new Option(`${instance.modelNumber}  /  ${instance.name}`, instance.qrCode)));
    modelSelect.disabled = state.instances.length === 0;
    modelCount.textContent = `${state.instances.length} model${state.instances.length === 1 ? '' : 's'}`;
    statusSelect.replaceChildren(...state.statuses.map((status) => new Option(formatStatus(status), status)));
    connectionDot.classList.add('live');
    connectionLabel.textContent = 'Connected';
    connectButton.innerHTML = 'Connected <span aria-hidden="true">&#10003;</span>';
    setMessage(state.instances.length ? 'Select a model instance to view its QR code and fabrication status.' : 'No model instances found.');
    if (state.instances.length) { modelSelect.value = state.instances[0].qrCode; selectInstance(modelSelect.value); }
  } catch (error) {
    setMessage(error.message);
    connectButton.disabled = false;
    connectButton.innerHTML = 'Try again <span aria-hidden="true">&#8594;</span>';
  }
}

async function updateStatus() {
  if (!state.selected) return;
  const updateButton = document.querySelector('#update-button');
  updateButton.disabled = true;
  updateButton.textContent = 'Updating...';
  try {
    const response = await fetch(`/api/instances/${state.selected.qrCode}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: statusSelect.value, updatedBy: 'PowerFab dashboard' }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Status update failed');
    state.selected = result;
    state.instances = state.instances.map((instance) => instance.qrCode === result.qrCode ? result : instance);
    setMessage(`Status updated to ${formatStatus(result.status)}.`);
    renderInstance();
  } catch (error) { setMessage(error.message); }
  updateButton.disabled = false;
  updateButton.textContent = 'Update status';
}

connectButton.addEventListener('click', connect);
modelSelect.addEventListener('change', () => selectInstance(modelSelect.value));
document.querySelector('#update-button').addEventListener('click', updateStatus);
document.querySelector('#print-button').addEventListener('click', () => { if (state.selected) window.open(state.selected.printUrl, '_blank', 'noopener'); });
