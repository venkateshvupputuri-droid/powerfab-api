(() => {
  const loadStyle = document.createElement('style');
  loadStyle.textContent = '.load-totals{display:none!important}.load-details-grid{grid-template-columns:1fr!important}.ship-row{display:none!important}#new-load,#delete-load,#help-load{display:none!important}.load-footer-actions{display:block!important}.load-footer-actions #save-load{display:block!important;margin:18px 0 0;width:100%}';
  document.head.appendChild(loadStyle);
  const params = new URLSearchParams(window.location.search);
  const job = params.get('job') || '';
  const load = Number(params.get('load') || 0);
  const message = document.getElementById('message');
  const value = id => document.getElementById(id)?.value || '';
  const request = async (url, options) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Request failed.');
    return payload;
  };

  if (!load || !job) return;
  document.getElementById('load-detail')?.classList.remove('hidden');
  document.querySelector('[data-tab="loaded"]')?.remove();
  document.querySelector('[data-tab="additional"]')?.remove();
  document.querySelector('[data-panel="loaded"]')?.remove();
  document.querySelector('[data-panel="additional"]')?.remove();
  const shipDate = document.querySelector('.ship-row label');
  const fields = document.querySelector('.load-fields');
  if (shipDate && fields) fields.appendChild(shipDate);

  const refreshAssignedInstances = async () => {
    const payload = await request(`/api/paint-loads?job=${encodeURIComponent(job)}&load=${load}`);
    const table = document.querySelector('[data-panel="material"] .drawings-table');
    const body = document.getElementById('assigned-rows');
    const currentLoad = (payload.loads || []).find(item => Number(item.TruckID) === load);
    const summaryActions = document.querySelector('.summary-actions');
    if (currentLoad?.Shipped && summaryActions && !document.getElementById('summary-reopen')) {
      const reopen = document.createElement('button');
      reopen.id = 'summary-reopen';
      reopen.type = 'button';
      reopen.className = 'detail-button';
      reopen.textContent = 'Reopen Load';
      reopen.onclick = async () => {
        message.textContent = 'Reopening load...';
        try {
          await request(`/api/paint-loads/${load}/reopen?job=${encodeURIComponent(job)}`, { method: 'POST' });
          message.textContent = 'Load reopened in PowerFab active loads.';
          reopen.remove();
        } catch (error) {
          message.textContent = error.message;
        }
      };
      summaryActions.appendChild(reopen);
    }
    if (!table || !body) return;
    table.querySelector('thead tr').innerHTML = '<th>Mark No.</th><th>Assembly instance</th><th>Weight</th>';
    const prefix = payload.jobPrefix || job;
    body.innerHTML = (payload.assignedAssemblies || []).length
      ? payload.assignedAssemblies.map(item => {
        const markNo = `${prefix}-${item.MainMark}`;
        const instanceMark = `${markNo}-${item.InstanceNumber}`;
        return `<tr><td>${markNo}</td><td>${instanceMark}</td><td>${Number(item.Weight || 0).toLocaleString(undefined, { maximumFractionDigits: 3 })} kg</td></tr>`;
      }).join('')
      : '<tr><td colspan="3">No assemblies have been assigned to this load.</td></tr>';
  };
  refreshAssignedInstances().catch(error => { message.textContent = error.message; });
  document.getElementById('if')?.addEventListener('submit', () => {
    window.setTimeout(() => refreshAssignedInstances().catch(error => { message.textContent = error.message; }), 500);
  });

  document.getElementById('save-load').onclick = async () => {
    message.textContent = 'Saving load...';
    try {
      await request(`/api/paint-loads/${load}?job=${encodeURIComponent(job)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          loadNumber: value('detail-number'),
          topTextDescription: value('detail-top'),
          shippedFrom: value('detail-from'),
          destinationGroupId: value('detail-dest'),
          plannedShipDate: value('ship-date'),
          capacity: value('detail-capacity'),
          trailerNumber: value('detail-carrier'),
          carrier: value('detail-truck'),
          driverName: value('detail-driver'),
          pickupLocation: value('detail-pickup'),
          receivingLocation: value('detail-receiving')
        })
      });
      message.textContent = 'Load updated.';
    } catch (error) {
      message.textContent = error.message;
    }
  };

  const ship = async () => {
    message.textContent = 'Shipping load...';
    try {
      await request(`/api/paint-loads/${load}/ship?job=${encodeURIComponent(job)}`, { method: 'POST' });
      message.textContent = 'Load marked as shipped.';
    } catch (error) {
      message.textContent = error.message;
    }
  };
  document.getElementById('ship').onclick = ship;
  document.getElementById('summary-ship').onclick = ship;

  const createTicket = async () => {
    message.textContent = 'Creating shipping ticket...';
    try {
      const payload = await request(`/api/paint-loads/${load}/shipping-ticket?job=${encodeURIComponent(job)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: value('detail-to') })
      });
      const rows = [...document.querySelectorAll('#summary-assemblies tr')].map(row => row.innerHTML).join('');
      const popup = window.open('', 'shipping-ticket', 'width=900,height=700');
      if (!popup) throw new Error('Allow pop-ups to print the shipping ticket.');
      popup.document.write(`<!doctype html><title>Shipping Ticket ${payload.ticketNumber}</title><style>body{font:14px Arial;padding:28px}table{width:100%;border-collapse:collapse;margin-top:22px}th,td{border:1px solid #777;padding:8px;text-align:left}th{background:#eee}</style><h1>Shipping Ticket</h1><p><b>Job:</b> ${job}<br><b>Load:</b> ${value('detail-number')}<br><b>Ticket:</b> ${payload.ticketNumber}<br><b>Planned ship date:</b> ${value('ship-date') || '—'}</p><table><thead><tr><th>Assembly instance</th><th>Assembly</th><th>Weight</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No assemblies assigned</td></tr>'}</tbody></table>`);
      popup.document.close();
      popup.focus();
      popup.print();
      message.textContent = `Shipping ticket ${payload.ticketNumber} created.`;
    } catch (error) {
      message.textContent = error.message;
    }
  };
  document.getElementById('ticket').onclick = createTicket;
  document.getElementById('summary-ticket').onclick = createTicket;
})();
