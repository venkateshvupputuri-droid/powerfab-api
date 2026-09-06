document.addEventListener('DOMContentLoaded', () => {
  const rowsContainer = document.getElementById('job-rows');
  const toolbarSiteSelect = document.getElementById('toolbar-site-select');
  const toolbarPlantSelect = document.getElementById('toolbar-plant-select');
  const toolbarUnitSelect = document.getElementById('toolbar-unit-select');
  const searchInput = document.getElementById('job-search');
  const connectButton = document.getElementById('connect-powerfab');
  const projectsOpen = document.getElementById('projects-open');
  const projectsPage = document.getElementById('projects-page');
  const loginForm = document.getElementById('contractor-login');
  const loginError = document.getElementById('login-error');
  const sessionPanel = document.getElementById('contractor-session');
  const contractorName = document.getElementById('contractor-name');
  const logoutButton = document.getElementById('contractor-logout');

  const state = {
    allProjects: [],
    currentSelection: null,
    loggedIn: false
  };

  function showSession(contractor) {
    state.loggedIn = true;
    loginForm.classList.add('hidden');
    sessionPanel.classList.remove('hidden');
    contractorName.textContent = contractor.contractorName || contractor.username;
    connectButton.classList.remove('hidden');
    projectsOpen.classList.remove('hidden');
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.textContent = '';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('contractor-username').value, password: document.getElementById('contractor-password').value })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to sign in');
      showSession(payload.contractor);
      connectButton.click();
      const returnUrl = new URLSearchParams(window.location.search).get('return');
      if (returnUrl) window.location.href = returnUrl;
    } catch (error) {
      loginError.textContent = error.message || 'Unable to sign in';
    }
  });

  logoutButton.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.reload();
  });

  function syncSelectOptions(source, target) {
    const values = [...new Set(source.map((item) => item).filter(Boolean))].sort();
    target.innerHTML = '<option value="">Select option</option>' + values.map((value) => `<option value="${value}">${value}</option>`).join('');
  }

  function renderProjects() {
    const siteValue = (toolbarSiteSelect.value || '').trim();
    const plantValue = (toolbarPlantSelect.value || '').trim();
    const unitValue = (toolbarUnitSelect.value || '').trim();
    const q = (searchInput.value || '').trim().toLowerCase();

    const filtered = state.allProjects.filter((project) => {
      const matchesSite = !siteValue || (project.site || '').toLowerCase() === siteValue.toLowerCase();
      const matchesPlant = !plantValue || (project.plant || '').toLowerCase() === plantValue.toLowerCase();
      const matchesUnit = !unitValue || (project.unit || '').toLowerCase() === unitValue.toLowerCase();
      const searchText = `${project.jobNumber || ''} ${project.name || ''} ${project.description || ''} ${project.location || ''}`.toLowerCase();
      const matchesSearch = !q || searchText.includes(q);
      return matchesSite && matchesPlant && matchesUnit && matchesSearch;
    });

    rowsContainer.innerHTML = filtered.map((project) => `
      <div class="table-row job-row ${state.currentSelection === project.jobNumber ? 'selected' : ''}" data-job-no="${project.jobNumber || ''}" data-description="${(project.description || project.name || '').replace(/\"/g, '&quot;')}" data-location="${project.location || ''}" role="row">
        <span>${project.jobNumber || '—'}</span>
        <span>${project.description || project.name || '—'}</span>
        <span>${project.location || '—'}</span>
        <button type="button" class="open-project">Open Project</button>
      </div>
    `).join('');

    rowsContainer.querySelectorAll('.open-project').forEach((button) => {
      button.addEventListener('click', () => {
        const row = button.closest('.job-row');
        const jobNumber = row.dataset.jobNo || '';
        state.currentSelection = jobNumber;
        renderProjects();

        if (jobNumber) {
          const targetUrl = `/project.html?job=${encodeURIComponent(jobNumber)}`;
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
        }
      });
    });
  }

  function populateFilters(projects) {
    const sites = [...new Set(projects.map((project) => project.site).filter(Boolean))];
    const plants = [...new Set(projects.map((project) => project.plant).filter(Boolean))];
    const units = [...new Set(projects.map((project) => project.unit).filter(Boolean))];

    syncSelectOptions(sites, toolbarSiteSelect);
    syncSelectOptions(plants, toolbarPlantSelect);
    syncSelectOptions(units, toolbarUnitSelect);
  }

  function bindFilterChanges() {
    [toolbarSiteSelect, toolbarPlantSelect, toolbarUnitSelect].forEach((element) => {
      element.addEventListener('change', renderProjects);
    });

    searchInput.addEventListener('input', renderProjects);
  }

  projectsOpen.addEventListener('click', () => {
    if (!state.loggedIn) return;
    document.querySelector('.landing-actions').classList.add('hidden');
    projectsPage.classList.remove('hidden');
  });

  bindFilterChanges();

  connectButton.addEventListener('click', async () => {
    connectButton.disabled = true;
    connectButton.textContent = 'Connecting...';

    try {
      const response = await fetch('/api/projects');
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load PowerFab data');
      }

      state.allProjects = Array.isArray(payload.projects) ? payload.projects : [];
      populateFilters(state.allProjects);
      renderProjects();
      connectButton.textContent = 'Connected';
      connectButton.classList.add('is-connected');
    } catch (error) {
      console.error(error);
      connectButton.textContent = 'Retry PowerFab';
      connectButton.disabled = false;
      alert(error.message || 'Unable to connect to PowerFab. Check the API server and database connection.');
    }
  });

  rowsContainer.innerHTML = '<div class="empty-state">Sign in to view assigned projects.</div>';
  fetch('/api/auth/me').then(async (response) => {
    if (!response.ok) return;
    const payload = await response.json();
    showSession(payload.contractor);
    connectButton.click();
  }).catch(() => undefined);
});
