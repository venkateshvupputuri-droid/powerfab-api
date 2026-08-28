const state = { instances: [], statuses: [], selected: null, project: '' };
const $ = (selector) => document.querySelector(selector);
const connectButton = $('#connect-button');
const connectionDot = $('#connection-dot');
const connectionLabel = $('#connection-label');
const projectSelect = $('#project-select');
const plantSelect = $('#plant-select');
const unitSelect = $('#unit-select');
const jobSelect = $('#job-select');
const statusSelect = $('#status-select');

function formatStatus(status) { return status.replaceAll('_', ' '); }
function setMessage(text) { $('#message').textContent = text; }
function valuesFor(field, instances) { return [...new Set(instances.map((instance) => instance[field]).filter(Boolean))].sort(); }
function currentScope() {
  return state.instances.filter((instance) => (!state.project || instance.projectName === state.project) && (!plantSelect.value || instance.plant === plantSelect.value) && (!unitSelect.value || instance.unit === unitSelect.value) && (!jobSelect.value || instance.jobNumber === jobSelect.value));
}
function fillSelect(select, values, emptyLabel) { select.replaceChildren(new Option(emptyLabel, ''), ...values.map((value) => new Option(value, value))); select.disabled = values.length === 0; }
function renderFilters() {
  const projectValues = valuesFor('projectName', state.instances);
  fillSelect(projectSelect, projectValues, 'Select a project');
  projectSelect.value = state.project;
  const projectInstances = state.instances.filter((instance) => !state.project || instance.projectName === state.project);
  fillSelect(plantSelect, valuesFor('plant', projectInstances), 'All plants');
  fillSelect(unitSelect, valuesFor('unit', projectInstances.filter((instance) => !plantSelect.value || instance.plant === plantSelect.value)), 'All units');
  fillSelect(jobSelect, valuesFor('jobNumber', currentScope()), 'All jobs');
  renderAssemblies(currentScope());
}
function renderAssemblies(instances) {
  const list = $('#assembly-list'); const items = $('#assembly-items'); list.hidden = !state.project;
  $('#assembly-count').textContent = `${instances.length} ${instances.length === 1 ? 'assembly' : 'assemblies'}`;
  items.replaceChildren(...instances.map((instance) => { const item = document.createElement('button'); item.className = 'assembly-item'; item.type = 'button'; item.innerHTML = `<span><strong>${instance.assemblyNumber || instance.modelNumber}</strong><small>${instance.name} · ${formatStatus(instance.status)}</small></span><span aria-hidden="true">&#8594;</span>`; item.addEventListener('click', () => { state.selected = instance; renderInstance(); $('#model-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }); return item; }));
  $('#model-count').textContent = `${instances.length} model${instances.length === 1 ? '' : 's'}`;
}
function renderInstance() {
  const instance = state.selected; if (!instance) { $('#model-panel').hidden = true; return; }
  $('#model-panel').hidden = false; $('#model-number').textContent = instance.assemblyNumber || instance.modelNumber; $('#model-name').textContent = instance.name; $('#model-description').textContent = instance.description || 'No description provided.'; $('#model-location').textContent = [instance.plant, instance.unit, instance.location].filter(Boolean).join(' / ') || 'Unassigned'; $('#model-qr').textContent = instance.qrCode; $('#status-badge').textContent = formatStatus(instance.status); $('#qr-image').src = instance.qrImageUrl; statusSelect.value = instance.status;
}
async function connect() {
  connectButton.disabled = true; connectButton.innerHTML = 'Connecting <span aria-hidden="true">...</span>';
  try {
    const health = await fetch('/health'); if (!health.ok) throw new Error('PowerFab database is unavailable');
    const [instanceResponse, statusResponse] = await Promise.all([fetch('/api/instances'), fetch('/api/statuses')]); if (!instanceResponse.ok || !statusResponse.ok) throw new Error('Unable to load PowerFab data');
    state.instances = (await instanceResponse.json()).instances; state.statuses = (await statusResponse.json()).statuses; statusSelect.replaceChildren(...state.statuses.map((status) => new Option(formatStatus(status), status))); state.project = valuesFor('projectName', state.instances)[0] || ''; renderFilters(); connectionDot.classList.add('live'); connectionLabel.textContent = 'Connected'; connectButton.innerHTML = 'PowerFab connected <span aria-hidden="true">&#10003;</span>'; setMessage(state.instances.length ? 'Project opened. Choose a plant, unit, job, then assembly.' : 'No projects found in the database.');
  } catch (error) { setMessage(error.message); connectButton.disabled = false; connectButton.innerHTML = 'Try again <span aria-hidden="true">&#8594;</span>'; }
}
async function updateStatus() {
  if (!state.selected) return; const button = $('#update-button'); button.disabled = true; button.textContent = 'Updating...';
  try { const response = await fetch(`/api/instances/${state.selected.qrCode}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: statusSelect.value, updatedBy: 'PowerFab dashboard' }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Status update failed'); state.selected = result; state.instances = state.instances.map((instance) => instance.qrCode === result.qrCode ? result : instance); renderFilters(); renderInstance(); setMessage(`Status updated to ${formatStatus(result.status)}.`); } catch (error) { setMessage(error.message); } button.disabled = false; button.textContent = 'Update status';
}
connectButton.addEventListener('click', connect);
projectSelect.addEventListener('change', () => { state.project = projectSelect.value; plantSelect.value = ''; unitSelect.value = ''; jobSelect.value = ''; state.selected = null; renderFilters(); renderInstance(); });
plantSelect.addEventListener('change', () => { unitSelect.value = ''; jobSelect.value = ''; renderFilters(); });
unitSelect.addEventListener('change', () => { jobSelect.value = ''; renderFilters(); });
jobSelect.addEventListener('change', () => renderAssemblies(currentScope()));
$('#update-button').addEventListener('click', updateStatus);
$('#print-button').addEventListener('click', () => { if (state.selected) window.open(state.selected.printUrl, '_blank', 'noopener'); });
