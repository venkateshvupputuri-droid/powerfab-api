const state = { instances: [], statuses: [], selected: null };
const $ = (selector) => document.querySelector(selector);
const connectButton = $('#connect-button');
const siteSelect = $('#site-select');
const plantSelect = $('#plant-select');
const unitSelect = $('#unit-select');
const jobSelect = $('#job-select');
const statusSelect = $('#status-select');
function formatStatus(status) { return status.replaceAll('_', ' '); }
function setMessage(text) { $('#message').textContent = text; }
function valuesFor(field, instances) { return [...new Set(instances.map((instance) => instance[field]).filter(Boolean))].sort(); }
function fillSelect(select, values, emptyLabel) { select.replaceChildren(new Option(emptyLabel, ''), ...values.map((value) => new Option(value, value))); select.disabled = values.length === 0; }
function scope() { return state.instances.filter((instance) => (!siteSelect.value || instance.site === siteSelect.value) && (!plantSelect.value || instance.plant === plantSelect.value) && (!unitSelect.value || instance.unit === unitSelect.value) && (!jobSelect.value || instance.jobNumber === jobSelect.value)); }
function refreshFilters() {
  const selectedSite = siteSelect.value;
  const selectedPlant = plantSelect.value;
  const selectedUnit = unitSelect.value;
  const selectedJob = jobSelect.value;
  const sites = state.instances;
  fillSelect(siteSelect, valuesFor('site', sites), 'Select a site');
  siteSelect.value = selectedSite;
  const siteInstances = sites.filter((instance) => !siteSelect.value || instance.site === siteSelect.value);
  fillSelect(plantSelect, valuesFor('plant', siteInstances), 'Select a plant');
  plantSelect.value = selectedPlant;
  const plantInstances = siteInstances.filter((instance) => !plantSelect.value || instance.plant === plantSelect.value);
  fillSelect(unitSelect, valuesFor('unit', plantInstances), 'Select a unit');
  unitSelect.value = selectedUnit;
  const unitInstances = plantInstances.filter((instance) => !unitSelect.value || instance.unit === unitSelect.value);
  fillSelect(jobSelect, valuesFor('jobNumber', unitInstances), 'Select a job');
  jobSelect.value = selectedJob;
  renderAssemblies(scope());
}
function renderAssemblies(instances) {
  $('#assembly-list').hidden = !jobSelect.value;
  $('#assembly-count').textContent = `${instances.length} ${instances.length === 1 ? 'assembly' : 'assemblies'}`;
  $('#model-count').textContent = `${instances.length} model${instances.length === 1 ? '' : 's'}`;
  $('#assembly-items').replaceChildren(...instances.map((instance) => { const item = document.createElement('button'); item.className = 'assembly-item'; item.type = 'button'; item.innerHTML = `<span><strong>${instance.assemblyNumber || instance.modelNumber}</strong><small>${instance.name} · ${formatStatus(instance.status)}</small></span><span aria-hidden="true">&#8594;</span>`; item.addEventListener('click', () => { state.selected = instance; renderInstance(); $('#model-panel').scrollIntoView({ behavior: 'smooth' }); }); return item; }));
}
function renderInstance() {
  const instance = state.selected; if (!instance) { $('#model-panel').hidden = true; return; }
  $('#model-panel').hidden = false; $('#model-number').textContent = instance.assemblyNumber || instance.modelNumber; $('#model-name').textContent = instance.name; $('#model-description').textContent = instance.description || 'No description provided.'; $('#model-location').textContent = [instance.site, instance.plant, instance.unit, instance.location].filter(Boolean).join(' / '); $('#model-qr').textContent = instance.qrCode; $('#status-badge').textContent = formatStatus(instance.status); $('#qr-image').src = instance.qrImageUrl; statusSelect.value = instance.status;
}
async function connect() {
  connectButton.disabled = true; connectButton.innerHTML = 'Connecting <span aria-hidden="true">...</span>';
  try { const health = await fetch('/health'); if (!health.ok) throw new Error('PowerFab database is unavailable'); const [instances, statuses] = await Promise.all([fetch('/api/instances'), fetch('/api/statuses')]); if (!instances.ok || !statuses.ok) throw new Error('Unable to load PowerFab data'); state.instances = (await instances.json()).instances; state.statuses = (await statuses.json()).statuses; statusSelect.replaceChildren(...state.statuses.map((status) => new Option(formatStatus(status), status))); refreshFilters(); $('#connection-dot').classList.add('live'); $('#connection-label').textContent = 'Connected'; connectButton.innerHTML = 'PowerFab connected <span aria-hidden="true">&#10003;</span>'; setMessage('Select a site, plant, unit, and job to show assemblies.'); } catch (error) { setMessage(error.message); connectButton.disabled = false; connectButton.innerHTML = 'Try again <span aria-hidden="true">&#8594;</span>'; }
}
async function updateStatus() {
  if (!state.selected) return; const button = $('#update-button'); button.disabled = true; button.textContent = 'Updating...';
  try { const response = await fetch(`/api/instances/${state.selected.qrCode}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: statusSelect.value, updatedBy: 'PowerFab dashboard' }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Status update failed'); state.selected = result; state.instances = state.instances.map((instance) => instance.qrCode === result.qrCode ? result : instance); refreshFilters(); renderInstance(); setMessage(`Status updated to ${formatStatus(result.status)}.`); } catch (error) { setMessage(error.message); } button.disabled = false; button.textContent = 'Update status';
}
connectButton.addEventListener('click', connect);
siteSelect.addEventListener('change', () => { plantSelect.value = ''; unitSelect.value = ''; jobSelect.value = ''; state.selected = null; refreshFilters(); renderInstance(); });
plantSelect.addEventListener('change', () => { unitSelect.value = ''; jobSelect.value = ''; state.selected = null; refreshFilters(); renderInstance(); });
unitSelect.addEventListener('change', () => { jobSelect.value = ''; state.selected = null; refreshFilters(); renderInstance(); });
jobSelect.addEventListener('change', () => { state.selected = null; renderAssemblies(scope()); renderInstance(); });
$('#update-button').addEventListener('click', updateStatus);
$('#print-button').addEventListener('click', () => { if (state.selected) window.open(state.selected.printUrl, '_blank', 'noopener'); });
