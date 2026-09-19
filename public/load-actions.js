(() => {
  const loadStyle = document.createElement('style');
  loadStyle.textContent = '.load-totals{display:none!important}.load-details-grid{grid-template-columns:1fr!important}.ship-row{display:none!important}#new-load,#delete-load,#help-load{display:none!important}.load-footer-actions{display:block!important}.load-footer-actions #save-load{display:block!important;margin:18px 0 0;width:100%}';
  document.head.appendChild(loadStyle);
  const params = new URLSearchParams(window.location.search);
  const job = params.get('job') || '';
  const load = Number(params.get('load') || 0);
  const destinationMode = params.get('destination') || '';
  const message = document.getElementById('message');
  let coatingReadOnly = false;
  const value = id => document.getElementById(id)?.value || '';
  const request = async (url, options) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Request failed.');
    return payload;
  };

  const scanButton = document.createElement('button');
  scanButton.type = 'button';
  scanButton.className = 'secondary-button';
  scanButton.textContent = 'Scan Shipping Ticket QR';
  scanButton.onclick = () => { window.location.href = `/shipping-scan.html?job=${encodeURIComponent(job)}`; };
  document.getElementById('title')?.insertAdjacentElement('afterend', scanButton);
  const title = document.getElementById('title');
  if (title) {
    title.textContent = title.textContent.replace(/Shift to Paint/g, 'Shipping');
    new MutationObserver(() => {
      if (title.textContent.includes('Shift to Paint')) title.textContent = title.textContent.replace(/Shift to Paint/g, 'Shipping');
    }).observe(title, { childList: true, characterData: true, subtree: true });
  }
  document.title = document.title.replace(/Shift to Paint/g, 'Shipping');
  fetch('/api/auth/me').then(response => response.ok ? response.json() : null).then(auth => {
    if (!auth?.permissions?.canConfirmReceipt) scanButton.remove();
  }).catch(() => scanButton.remove());

  if (destinationMode) {
    const destinationSelect = document.getElementById('dest');
    const detailDestinationSelect = document.getElementById('detail-dest');
    const desiredDestination = destinationMode === 'site' ? 'SITE' : 'LAYDOWN';
    const selectDestination = select => {
      if (!select) return;
      const option = [...select.options].find(item => item.textContent.trim().toUpperCase().includes(desiredDestination));
      if (option) select.value = option.value;
    };
    selectDestination(destinationSelect);
    selectDestination(detailDestinationSelect);
    window.setTimeout(() => {
      selectDestination(document.getElementById('dest'));
      selectDestination(document.getElementById('detail-dest'));
    }, 500);
  }
  if (!load || !job) return;
  document.querySelectorAll('#loads a').forEach(link => { link.textContent = 'View Details'; });
  new MutationObserver(() => document.querySelectorAll('#loads a').forEach(link => { link.textContent = 'View Details'; })).observe(document.getElementById('loads'), { childList: true });
  document.getElementById('loads-section')?.classList.add('hidden');
  document.getElementById('load-summary')?.classList.remove('hidden');
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
    if (currentLoad?.Shipped && summaryActions && !coatingReadOnly && !document.getElementById('summary-reopen')) {
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
      const printEscape = valueToEscape => String(valueToEscape ?? '—')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      const rows = [...document.querySelectorAll('#summary-assemblies tr')]
        .filter(row => row.querySelectorAll('td').length >= 3)
        .map(row => {
          const cells = [...row.querySelectorAll('td')].map(cell => printEscape(cell.textContent.trim()));
          return `<tr><td>${cells[1]}</td><td>${cells[0]}</td><td>${cells[2]}</td></tr>`;
        }).join('');
      const totalInstances = [...document.querySelectorAll('#summary-assemblies tr')]
        .filter(row => row.querySelectorAll('td').length >= 3).length;
      const totalWeight = [...document.querySelectorAll('#summary-assemblies tr')]
        .filter(row => row.querySelectorAll('td').length >= 3)
        .reduce((total, row) => total + (Number.parseFloat(row.querySelectorAll('td')[2].textContent) || 0), 0);
      const shipmentDetails = [
        ['Load #', value('detail-number')],
        ['Transporter', value('detail-carrier')],
        ['Truck', value('detail-truck')],
        ['Driver-name', value('detail-driver')],
        ['Pick_up_location', value('detail-pickup')],
        ['Receiving_location', value('detail-receiving')]
      ].map(([label, detail]) => `<b>${printEscape(label)}:</b> ${printEscape(detail)}<br>`).join('');
      const qrUrl = `/api/shipping-tickets/${encodeURIComponent(payload.ticketNumber)}/qr`;
      const popup = window.open('', 'shipping-ticket', 'width=900,height=700');
      if (!popup) throw new Error('Allow pop-ups to print the shipping ticket.');
      popup.document.write(`<!doctype html><title>Shipping Ticket ${printEscape(payload.ticketNumber)}</title><style>body{font:14px Arial;padding:28px}header{display:flex;justify-content:space-between;align-items:flex-start}header img{width:140px;height:140px}.ticket-details{line-height:1.45;margin-top:16px}.ticket-total{margin-top:14px;font-weight:700}table{width:100%;border-collapse:collapse;margin-top:22px}th,td{border:1px solid #777;padding:8px;text-align:left}th{background:#eee}@media print{button{display:none}}</style><header><div><h1>Shipping Ticket</h1><div><b>Job:</b> ${printEscape(job)}<br><b>Ticket:</b> ${printEscape(payload.ticketNumber)}<br><b>Planned ship date:</b> ${printEscape(value('ship-date') || '—')}</div><div class="ticket-details">${shipmentDetails}</div></div><img src="${qrUrl}" alt="Scan to confirm receipt"></header><p>Scan the QR code to confirm individual assembly receipt at the painting yard.</p><table><thead><tr><th>Assembly</th><th>Assembly instance</th><th>Weight</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No assemblies assigned</td></tr>'}</tbody></table><div class="ticket-total">Total instances: ${totalInstances}<br>Total weight: ${totalWeight.toLocaleString(undefined, { maximumFractionDigits: 3 })} kg</div>`);
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
