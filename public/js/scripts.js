let currentUser = null;
let selectedGroupId = null;
let currentPage = 1;
const transactionsPerPage = 50;

// ==================== FUNÇÕES AUXILIARES ====================
function showLoading() {
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'flex';
}

function hideLoading() {
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'none';
}

function formatDateTime(dateTimeString) {
  if (!dateTimeString) return 'N/A';
  const date = new Date(dateTimeString);
  return date.toLocaleString('pt-BR');
}

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value || 0);
}

function showAlert(type, message) {
  const alertDiv = document.createElement('div');
  alertDiv.className = `alert alert-${type}`;
  alertDiv.textContent = message;
  document.body.prepend(alertDiv);
  
  setTimeout(() => alertDiv.remove(), 5000);
}

function escapeHtml(text) {
  return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

// ==================== FUNÇÕES PRINCIPAIS ====================
async function loadArchivedData() {
  try {
    const response = await fetch('/api/archives', {
      headers: getAuthHeaders()
    });
    const archives = await response.json();
    const tbody = document.getElementById('archivedData');
    tbody.innerHTML = archives.map(archive => `
      <tr>
        <td>${archive.month_year.replace('-', '/')}</td>
        <td>${formatCurrency(archive.total_dizimos)}</td>
        <td>${formatCurrency(archive.total_ofertas)}</td>
        <td>${formatCurrency(archive.final_balance)}</td>
        <td>${formatDateTime(archive.archived_at)}</td>
      </tr>
    `).join('');
  } catch (error) {
    showAlert(`Erro ao carregar dados históricos: ${error.message}`, 'error');
  }
}

async function loadTransactions(groupId = null) {
  try {
    showLoading();
    const token = localStorage.getItem('token');
    
    const cacheKey = `transactions-${groupId || 'all'}`;
    const cachedData = sessionStorage.getItem(cacheKey);
    
    if (cachedData) {
      updateTransactionsTable(JSON.parse(cachedData));
    }
    
    const url = groupId ? `/api/transactions?group_id=${groupId}` : '/api/transactions';
    const response = await fetch(url, {
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error('Erro ao carregar transações');
    }

    const transactions = await response.json();
    sessionStorage.setItem(cacheKey, JSON.stringify(transactions));
    updateTransactionsTable(transactions);

  } catch (error) {
    console.error('Erro ao carregar transações:', error);
    showAlert(`Erro ao carregar transações: ${error.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function updateTransactionsTable(transactions) {
  const tableBody = document.getElementById('transactionsTable');
  if (!tableBody) return;
  
  tableBody.innerHTML = '';
  
  transactions.forEach(transaction => {
    const row = document.createElement('tr');
    
    const typeMap = {
      'DIZIMO': 'Dízimo',
      'OFERTA': 'Oferta',
      'DEPOSITO': 'Depósito',
      'RETIRADA': 'Retirada',
      'Caixa Geral': 'Caixa Geral',
      'OUTROS': 'Outros'
    };
    
    // Usar transaction_type em vez de type
    const transactionType = transaction_type || 'OUTROS';
    
    row.innerHTML = `
      <td>${formatDateTime(transaction.transaction_date)}</td>
      <td>${typeMap[transactionType] || transactionType}</td>
      <td>${formatCurrency(transaction.amount)}</td>
      <td>${transaction.person_name}</td>
      <td>${transaction.description || '-'}</td>
      <td>${transaction.group_name || 'Geral'}</td>
      <button class="edit-btn" onclick="openEditTransactionModal(${transaction.id})">
          <i class="fas fa-edit"></i> Editar
        </button>
      </td>
    `;
    
    tableBody.appendChild(row);
  });
}

async function loadGroups() {
  try {
    showLoading();
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('currentUser'));
    
    if (!token || !user) {
      throw new Error('Sessão expirada. Por favor, faça login novamente.');
    }

    const response = await fetch(`/api/groups?ts=${new Date().getTime()}`, {
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      cache: 'no-store'
    });

    if (!response.ok) {
      if (response.status === 401) {
        logout();
        throw new Error('Sessão expirada. Redirecionando para login...');
      }
      const errorData = await response.json();
      throw new Error(errorData.message || 'Erro ao carregar grupos');
    }

    const groups = await response.json();
    const groupSelect = document.getElementById('groupSelect');
groupSelect.innerHTML = `
  <option value="" disabled selected>Selecione um grupo...</option>
  ${groups.map(g => `
    <option value="${g.id}" ${g.name === 'Caixa Geral' ? 'data-is-general="true"' : ''}>
      ${g.name} - Saldo: ${formatCurrency(g.balance)}
    </option>
  `).join('')}
`;
    
    // Adicionar verificação para grupos do tipo DEPOSITO
    groups.forEach(group => {
      group.displayName = group.name;
      if (group.group_type === 'Caixa Geral') {
        group.displayName = `💰 Caixa Geral (${group.branch_name})`;
      }
    });

    groups.sort((a, b) => {
      if (a.name === 'Caixa Geral') return -1;
      if (b.name === 'Caixa Geral') return 1;
      return a.name.localeCompare(b.name);
    });

    groupSelect.innerHTML = '<option value="" disabled selected>Selecione um grupo...</option>';
    
    if (groups && groups.length > 0) {
      const generalCash = groups.find(g => g.name === 'Caixa Geral');
      if (generalCash) {
        const generalBalanceEl = document.getElementById('generalBalanceAmount');
        if (generalBalanceEl && generalCash) {
          generalBalanceEl.textContent = formatCurrency(generalCash.balance);
        }
        if (!generalCash) {
          console.error('Grupo "Caixa Geral" não encontrado para esta congregação');
          showAlert('warning', 'Grupo "Caixa Geral" não encontrado. Contate o administrador.');
        }
      }

      groups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = `${group.displayName} - Saldo: ${formatCurrency(group.balance)}`;
        
        if (group.name === 'Caixa Geral') {
          option.style.fontWeight = 'bold';
          option.dataset.isGeneral = 'true';
        }
        
        groupSelect.appendChild(option);
      });
    } else {
      const option = document.createElement('option');
      option.textContent = 'Nenhum grupo disponível';
      option.disabled = true;
      groupSelect.appendChild(option);
    }

    if (selectedGroupId) {
      groupSelect.value = selectedGroupId;
    }

    groupSelect.onchange = () => {
      selectedGroupId = groupSelect.value;
      if (selectedGroupId) {
        loadTransactions(selectedGroupId);
      }
    };

  } catch (error) {
    console.error('Erro ao carregar grupos:', error);
    const userFriendlyMessage = error.message.includes('Failed to fetch') 
      ? 'Erro de conexão com o servidor' 
      : error.message;
    
    showAlert(userFriendlyMessage, 'error');
    
    if (error.message.includes('Sessão expirada')) {
      setTimeout(() => logout(), 2000);
    }
  } finally {
    hideLoading();
  }
}

async function newTransaction(type) {
  try {
    const user = JSON.parse(localStorage.getItem('currentUser'));
    const token = localStorage.getItem('token');
    if (!user?.id || !token) {
      showAlert('Erro: Usuário não autenticado corretamente', 'error');
      return;
    }

    // 1. Buscar o Caixa Geral uma única vez
    const [caixaGeral] = await (await fetch(`/api/groups?branch_id=${user.id}&name=Caixa Geral`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })).json();

    if (!caixaGeral) {
      throw new Error('Grupo Caixa Geral não encontrado');
    }

    const config = {
      'DIZIMO': { 
        amountLabel: 'valor do dízimo', 
        personLabel: 'dizimista',
        needsGroup: false ,
        groupType: 'DIZIMO' 
      },
      'OFERTA': { 
        amountLabel: 'valor da oferta', 
        personLabel: 'ofertante',
        needsGroup: false ,
        groupType: 'OFERTA'
      },
      'DEPOSITO': { 
        amountLabel: 'valor do depósito', 
        personLabel: 'que fez o depósito',
        needsGroup: true ,
        groupType: 'DEPOSITO'
      },
      'RETIRADA': { 
        amountLabel: 'valor da retirada', 
        personLabel: 'que recebeu a retirada',
        needsGroup: true ,
        groupType: 'RETIRADA'
      }
    };
   
    const { amountLabel, personLabel, needsGroup } = config[type];
    
    if (needsGroup && !selectedGroupId) {
      showAlert('Para esta operação, selecione um grupo primeiro!', 'warning');
      return;
    }

    // 2. Validação de entrada melhorada
    const amountInput = prompt(`Informe o ${amountLabel}:`);
    const amount = parseFloat(amountInput?.replace(/[^0-9,]/g, '').replace(',', '.'));
    
    if (isNaN(amount)) {
      showAlert('Valor inválido! Digite apenas números.', 'error');
      return;
    }

    if (amount <= 0) {
      showAlert('O valor deve ser maior que zero!', 'error');
      return;
    }

    const personName = prompt(`Nome da pessoa ${personLabel}:`)?.trim();
    if (!personName) {
      showAlert('O nome é obrigatório!', 'error');
      return;
    }

    const description = prompt('Descrição (opcional):')?.trim() || '';

    showLoading();
    
    // 3. Montagem correta da transação
    const transactionData = {
      group_id: ['DIZIMO', 'OFERTA'].includes(type) ? caixaGeral.id : selectedGroupId,
      type: config[type].groupType, 
      amount: amount.toFixed(2),
      person_name: personName,
      description: description,
      branch_id: user.id
    };

    const response = await fetch('/api/transactions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` 
      },
      body: JSON.stringify(transactionData)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `Erro ao registrar transação`);
    }

    // 4. Atualização otimizada
    await Promise.all([
      loadGroups(), // Atualiza a lista de grupos
      selectedGroupId ? loadTransactions(selectedGroupId) : Promise.resolve()
    ]);

    showAlert('Transação registrada com sucesso!', 'success');
    

  } catch (error) {
    console.error('Erro na transação:', error);
    showAlert(`Erro: ${error.message}`, 'error');
  } finally {
    hideLoading();
  }
}
async function generatePDF(archiveId) {
  try {
    // Abrir em nova aba
    const url = `/api/admin/archives/${archiveId}/pdf`;
    window.open(url, '_blank');
    
  } catch (error) {
    console.error('Erro ao gerar PDF:', error);
    showAlert('Erro ao gerar relatório PDF', 'error');
  }
}
// ==================== FUNÇÕES DE EDIÇÃO DE TRANSAÇÕES ====================
// Abrir modal de edição
async function openEditTransactionModal(transactionId) {
  try {
    const response = await fetch(`/api/transactions/${transactionId}`, {
      headers: getAuthHeaders()
    });
    
    const transaction = await response.json();
    
    document.getElementById('editTransId').value = transaction.id;
    document.getElementById('editAmount').value = transaction.amount;
    document.getElementById('editDescription').value = transaction.description || '';
    document.getElementById('editPerson').value = transaction.person_name;
    
    document.getElementById('editTransactionModal').style.display = 'block';
  } catch (error) {
    showAlert(`Erro: ${error.message}`, 'error');
  }
}

// Atualizar transação
async function updateTransaction(e) {
  e.preventDefault();
  
  const transactionId = document.getElementById('editTransId').value;
  const amount = document.getElementById('editAmount').value;
  const description = document.getElementById('editDescription').value;
  const person = document.getElementById('editPerson').value;

  try {
    const response = await fetch(`/api/transactions/${transactionId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ amount, description, person_name: person })
    });

    if (!response.ok) throw new Error('Erro ao atualizar transação');
    
    showAlert('Transação atualizada com sucesso!', 'success');
    closeModal('editTransactionModal');
    
    // Recarregar dados
    if (selectedGroupId) {
      await loadTransactions(selectedGroupId);
    }
    await loadGroups();
  } catch (error) {
    showAlert(`Erro: ${error.message}`, 'error');
  }
}
function closeModal(modalId) {
  document.getElementById(modalId).style.display = 'none';
}

// ==================== FUNÇÕES ADMINISTRATIVAS ====================
async function loadAdminPanel() {
  try {
    const user = JSON.parse(localStorage.getItem('currentUser'));
    const token = localStorage.getItem('token');
    
    if (!user || !token || !user.isAdmin) {
      window.location.href = '/';
      return;
    }

    document.getElementById('adminWelcome').textContent = `Bem-vindo, ${user.name}`;
    await loadCongregations();
    await loadBalances();
    await loadAllTransactions(1);
    await loadArchives();
  } catch (error) {
    console.error('Erro ao carregar painel admin:', error);
    alert('Erro ao carregar painel admin');
    window.location.href = '/';
  }
}

async function loadCongregations() {
  try {
    showLoading();
    const token = localStorage.getItem('token');
    const response = await fetch('/api/congregations', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) throw new Error('Erro ao carregar congregações');
    
    const congregations = await response.json();
    const congregationsList = document.getElementById('congregationsList');
    
    if (congregationsList) {
      congregationsList.innerHTML = congregations.map(cong => `
        <tr>
          <td>${cong.id}</td>
          <td>${cong.name}</td>
          <td>${cong.created_at ? new Date(cong.created_at).toLocaleDateString('pt-BR') : 'N/A'}</td>
          <td class="actions">
            <button class="edit-btn" onclick="editCongregation(${cong.id})">
              <i class="fas fa-edit"></i> Editar
            </button>
            <button class="reset-btn" onclick="openChangePasswordModal(${cong.id})">
  <i class="fas fa-key"></i> Alterar Senha
</button>
          </td>
        </tr>
      `).join('');
    }
  } catch (error) {
    console.error('Erro ao carregar congregações:', error);
    showAlert(error.message, 'error');
  } finally {
    hideLoading();
  }
}

async function loadBalances() {
  try {
    showLoading();
    const token = localStorage.getItem('token');
    
    const response = await fetch('/api/admin/balances', {
      headers: { 'Authorization': `Bearer ${token}` },
      cache: 'no-store'
    });

    if (!response.ok) throw new Error('Erro ao carregar saldos');

    const { branches, typeBalances, totalBalance } = await response.json();

    // Atualiza totais
    document.getElementById('totalBalance').textContent = formatCurrency(totalBalance);
    
    // Atualiza totais por tipo
    const dizimoTotal = typeBalances.reduce((acc, curr) => curr.type === 'DIZIMO' ? acc + curr.total : acc, 0);
    const ofertaTotal = typeBalances.reduce((acc, curr) => curr.type === 'OFERTA' ? acc + curr.total : acc, 0);
    
    document.getElementById('totalBalance').textContent = formatCurrency(totalBalance);
    document.getElementById('dizimoBalance').innerHTML = `
      <i class="fas fa-hand-holding-usd"></i> Dízimos: ${formatCurrency(dizimoTotal)}
    `;
    document.getElementById('ofertaBalance').innerHTML = `
      <i class="fas fa-gift"></i> Ofertas: ${formatCurrency(ofertaTotal)}
    `;

    // Atualiza lista de congregações
    const branchesList = document.getElementById('branchesList');
    branchesList.innerHTML = branches.map(branch => `
      <div class="branch-card" onclick="loadBranchGroups(${branch.id})">
        <h3>${branch.name}</h3>
        <div class="branch-balance">${formatCurrency(branch.balance)}</div>
      </div>
    `).join('');

  } catch (error) {
    console.error('Erro ao carregar saldos:', error);
    showAlert('error', 'Erro ao atualizar saldos: ' + error.message);
  } finally {
    hideLoading();
  }
}

async function loadBranchGroups(branchId) {
  try {
    showLoading();
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('currentUser'));
    
    if (!user || !token) {
      throw new Error('Usuário não autenticado');
    }

    const branchResponse = await fetch(`/api/congregations/${branchId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!branchResponse.ok) {
      throw new Error('Erro ao carregar congregação');
    }
    
    const branch = await branchResponse.json();

    const titleElement = document.getElementById('selectedBranchTitle');
    titleElement.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h3><i class="fas fa-church"></i> ${branch.name}</h3>
        <button class="reset-all-btn" onclick="resetAllGroups(${branch.id}, '${escapeHtml(branch.name)}')">
          <i class="fas fa-broom"></i> Zerar Todos os Grupos
        </button>
      </div>
    `;
    titleElement.style.display = 'block';
    titleElement.dataset.branchId = branch.id;

    const groupsResponse = await fetch(`/api/admin/branches/${branchId}/groups`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!groupsResponse.ok) {
      throw new Error('Erro ao carregar grupos');
    }
    
    const groups = await groupsResponse.json();
    const tableBody = document.getElementById('groupBalancesTable');
    tableBody.innerHTML = '';

    groups.forEach(group => {
      const row = document.createElement('tr');
      
      const nameCell = document.createElement('td');
      nameCell.textContent = group.name;
      row.appendChild(nameCell);
      
      const balanceCell = document.createElement('td');
      balanceCell.textContent = formatCurrency(group.balance);
      row.appendChild(balanceCell);
      
      tableBody.appendChild(row);
    });

  } catch (error) {
    console.error('Erro ao carregar grupos:', error);
    showAlert('error', `Erro: ${error.message}`);
  } finally {
    hideLoading();
  }
}

async function resetAllGroups(branchId, branchName) {
  if (!confirm(`Tem certeza que deseja zerar TODOS os saldos financeiros de ${branchName}?\nIsso inclui dízimos, ofertas e saldos de grupos!\n\nEsta ação não pode ser desfeita!`)) {
    return;
  }

  try {
    showLoading();
    const token = localStorage.getItem('token');
    
    const response = await fetch(`/api/admin/branches/${branchId}/reset-all-groups`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Erro ao zerar saldos');
    }

    const result = await response.json();
    const total = result.balances?.total || 0;
    const dizimos = result.balances?.dizimos || 0;
    const ofertas = result.balances?.ofertas || 0;
    
    // Atualizações de UI
    document.getElementById('totalBalance').textContent = formatCurrency(total);
    document.getElementById('dizimoBalance').textContent = `Dízimos: ${formatCurrency(dizimos)}`;
    document.getElementById('ofertaBalance').textContent = `Ofertas: ${formatCurrency(ofertas)}`;
    
    // Recarrega dados
    await loadBalances();
    await loadBranchGroups(branchId);
    await loadAllTransactions(1);
    
    showAlert('success', result.message);

  } catch (error) {
    console.error('Erro ao zerar saldos:', error);
    showAlert('error', error.message);
  } finally {
    hideLoading();
  }
}
async function runMonthlyArchive() {
  if (!confirm('Tem certeza que deseja executar o arquivamento mensal?\n\nEsta ação irá:\n1. Arquivar todas as transações do mês anterior\n2. Zerar todos os saldos\n3. Iniciar um novo ciclo contábil\n\nEsta operação não pode ser desfeita!')) {
    return;
  }

  try {
    showLoading();
    
    const response = await fetch('/api/admin/monthly-archive', {
      method: 'POST',
      headers: getAuthHeaders()
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Erro no arquivamento');
    }
    
    const result = await response.json();
    showAlert('success', result.message);
    
    // Atualizar a interface
    await loadBalances();
    await loadAllTransactions(1);
    
  } catch (error) {
    console.error('Erro no arquivamento:', error);
    showAlert('error', error.message);
  } finally {
    hideLoading();
  }
}
async function loadArchives() {
  try {
    showLoading();
    const monthFilter = document.getElementById('archiveMonthFilter').value;
    
    const response = await fetch(`/api/admin/archives${monthFilter ? `?month=${monthFilter}` : ''}`, {
      headers: getAuthHeaders()
    });

    if (!response.ok) throw new Error('Erro ao carregar arquivos');
    
    const archives = await response.json();
    const tbody = document.getElementById('archivesList');
    
    tbody.innerHTML = archives.map(archive => `
      <tr>
        <td>${archive.month_year.replace('-', '/')}</td>
        <td>${archive.branch_name}</td>
        <td>${formatCurrency(archive.total_dizimos)}</td>
        <td>${formatCurrency(archive.total_ofertas)}</td>
        <td>${formatCurrency(archive.final_balance)}</td>
        <td>${formatDateTime(archive.archived_at)}</td>
        <td>
          <button class="details-btn" onclick="showArchiveDetails(${archive.id})">
            <i class="fas fa-search"></i> Detalhes
          </button>
          <button class="pdf-btn" onclick="generatePDF(${archive.id})">
            <i class="fas fa-file-pdf"></i> PDF
          </button>
        </td>
      </tr>
    `).join('');

  } catch (error) {
    showAlert('error', `Erro: ${error.message}`);
  } finally {
    hideLoading();
  }
}
async function showArchiveDetails(archiveId) {
  try {
    showLoading();
    const response = await fetch(`/api/admin/archives/${archiveId}`, {
      headers: getAuthHeaders()
    });
    
    if (!response.ok) throw new Error('Erro ao carregar detalhes');
    
    const details = await response.json();
    
    document.getElementById('modalMonthYear').textContent = details.month_year.replace('-', '/');
    
    const groupsHtml = details.groups.map(group => `
      <div class="group-card">
        <h4>${group.group_name}</h4>
        <div class="balance-flow">
          <span>Saldo Inicial: ${formatCurrency(group.initial_balance)}</span>
          <span>Saldo Final: ${formatCurrency(group.final_balance)}</span>
        </div>
      </div>
    `).join('');
    
    document.getElementById('archiveGroupsDetails').innerHTML = groupsHtml;
    document.getElementById('archiveDetailsModal').style.display = 'block';

  } catch (error) {
    showAlert('error', `Erro: ${error.message}`);
  } finally {
    hideLoading();
  }
}

async function loadAllTransactions(page = 1) {
  try {
    showLoading();
    currentPage = page;
    document.getElementById('currentPage').textContent = currentPage;
    
    const token = localStorage.getItem('token');
    const response = await fetch(`/api/admin/all-transactions?page=${page}&limit=${transactionsPerPage}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) throw new Error('Erro ao carregar transações');
    
    const { transactions, total, totalPages } = await response.json();
    const transactionsList = document.getElementById('allTransactionsList');
    
    if (transactionsList) {
      transactionsList.innerHTML = transactions.map(t => {
        const amount = parseFloat(t.amount) || 0;
        const displayType = t.transaction_type === 'DIZIMO' ? 'Dízimo' : 
                  t.transaction_type === 'OFERTA' ? 'Oferta' : 
                  t.transaction_type === 'DEPOSITO' ? 'Depósito' : 
                  t.transaction_type === 'RETIRADA' ? 'Retirada' : 
                  'Outros';
        
        return `
          <tr>
            <td>${formatDateTime(t.transaction_date)}</td>
            <td>${t.branch_name || 'N/A'}</td>
            <td>${t.group_name || 'N/A'}</td>
            <td>${displayType}</td>
            <td>${formatCurrency(amount)}</td>
            <td>${t.person_name || 'N/A'}</td>
          </tr>
        `;
      }).join('');
    }
    
    document.getElementById('prevPage').disabled = page <= 1;
    document.getElementById('nextPage').disabled = page >= totalPages;
    
  } catch (error) {
    console.error('Erro ao carregar transações:', error);
    showAlert('Erro ao carregar transações: ' + error.message, 'error');
  } finally {
    hideLoading();
  }
}

function changePage(delta) {
  const newPage = currentPage + delta;
  if (newPage > 0) {
    loadAllTransactions(newPage);
  }
}

function searchCongregations() {
  try {
    const input = document.getElementById('searchCongregation')?.value.toLowerCase();
    const rows = document.querySelectorAll('#congregationsTable tbody tr');
    
    if (!rows || rows.length === 0) {
      return;
    }
    
    rows.forEach(row => {
      const name = row.cells[1]?.textContent.toLowerCase();
      const id = row.cells[0]?.textContent.toLowerCase();
      
      if (name?.includes(input) || id?.includes(input)) {
        row.style.display = '';
      } else {
        row.style.display = 'none';
      }
    });
    
  } catch (error) {
    console.error('Erro ao buscar congregações:', error);
    showAlert('Erro ao filtrar congregações', 'error');
  }
}

async function editCongregation(id) {
  try {
    const token = localStorage.getItem('token');
    const response = await fetch(`/api/congregations/${id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Erro ao buscar dados da congregação');
    }
    
    const congregation = await response.json();
    
    const modal = document.getElementById('editCongregationModal');
    const form = document.getElementById('editCongregationForm');
    
    form.elements['editId'].value = congregation.id;
    form.elements['editName'].value = congregation.name;
    
    form.onsubmit = async (e) => {
      e.preventDefault();
      
      const name = form.elements['editName'].value.trim();
      
      if (!name) {
        showAlert('O nome da congregação é obrigatório', 'error');
        return;
      }
      
      try {
        showLoading();
        const updateResponse = await fetch(`/api/congregations/${id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ name })
        });
        
        if (!updateResponse.ok) {
          const error = await updateResponse.json();
          throw new Error(error.error || 'Erro ao atualizar congregação');
        }
        
        showAlert('Congregação atualizada com sucesso!', 'success');
        closeModal('editCongregationModal');
        await loadCongregations();
      } catch (error) {
        console.error('Erro ao atualizar:', error);
        showAlert(error.message, 'error');
      } finally {
        hideLoading();
      }
    };
    
    modal.style.display = 'block';
    
  } catch (error) {
    console.error('Erro ao editar congregação:', error);
    showAlert(error.message, 'error');
  }
}

function closeModal(modalId) {
  document.getElementById(modalId).style.display = 'none';
  
  // Limpe os campos se for o modal de senha
  if (modalId === 'changePasswordModal') {
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
  }
}


function openChangePasswordModal(congregationId) {
  document.getElementById('congregationId').value = congregationId;
  document.getElementById('changePasswordModal').style.display = 'block';
}

async function handleChangePassword(e) {
  e.preventDefault();
  const congregationId = document.getElementById('congregationId').value;
  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;

  try {
    const response = await fetch(`/api/congregations/${congregationId}/change-password`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      },
      body: JSON.stringify({ currentPassword, newPassword })
    });

    const data = await response.json();
    
    if (!response.ok) throw new Error(data.error);
    
    alert('Senha alterada com sucesso!');
    closeModal('changePasswordModal');
  } catch (error) {
    alert(`Erro: ${error.message}`);
  }
}

function logout() {
  localStorage.removeItem('currentUser');
  localStorage.removeItem('token');
  window.location.href = '/';
}

// ==================== INICIALIZAÇÃO ====================
function setupLoginPage() {
  const loginForm = document.getElementById('loginForm');
  
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    try {
      const congregation = document.getElementById('congregation').value.trim();
      const password = document.getElementById('password').value.trim();

      if (!congregation || !password) {
        throw new Error('Preencha todos os campos!');
      }

      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Entrando...';

      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ congregation, password })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Erro no login');
      }
      
      const userData = await response.json();
      localStorage.setItem('currentUser', JSON.stringify(userData));
      localStorage.setItem('token', userData.token);
      
      if (userData.isAdmin) {
        window.location.href = '/admin.html';
      } else {
        window.location.href = '/dashboard.html';
      }
      
    } catch (error) {
      console.error('Erro no login:', error);
      alert(error.message);
    } finally {
      const submitBtn = document.querySelector('#loginForm button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Entrar';
      }
    }
  });
}

async function loadDashboard() {
  try {
    const user = JSON.parse(localStorage.getItem('currentUser'));
    const token = localStorage.getItem('token');
    
    if (!user || !token) {
      window.location.href = '/';
      return;
    }

    document.getElementById('congregationName').textContent = user.name;
    await loadGroups(true);
    await loadArchivedData();
    
  } catch (error) {
    console.error('Erro ao carregar dashboard:', error);
    alert('Erro ao carregar dashboard');
    window.location.href = '/';
  }
}
async function showArchiveDetails(archiveId) {
  try {
    showLoading();
    const response = await fetch(`/api/admin/archives/${archiveId}`, {
      headers: getAuthHeaders()
    });
    
    if (!response.ok) throw new Error('Erro ao carregar detalhes');
    
    const details = await response.json();
    
    // Atualize o modal para incluir a busca
    document.getElementById('modalMonthYear').textContent = details.month_year.replace('-', '/');
    
    const groupsHtml = details.groups.map(group => `
      <div class="group-card">
        <div class="group-header">
          <h4>${group.group_name}</h4>
          <button class="search-btn" onclick="toggleGroupSearch('${group.group_id}')">
            <i class="fas fa-search"></i> Pesquisar
          </button>
        </div>
        <div class="balance-flow">
          <span>Saldo Inicial: ${formatCurrency(group.initial_balance)}</span>
          <span>Saldo Final: ${formatCurrency(group.final_balance)}</span>
        </div>
        <div id="searchContainer-${group.group_id}" class="search-container" style="display:none;">
          <input type="text" id="searchInput-${group.group_id}" 
                 placeholder="Digite o nome para pesquisar">
          <button onclick="searchTransactions('${group.group_id}', '${details.branch_id}')">
            <i class="fas fa-search"></i> Buscar
          </button>
        </div>
        <div id="results-${group.group_id}" class="results-table"></div>
      </div>
    `).join('');

    document.getElementById('archiveGroupsDetails').innerHTML = groupsHtml;
    document.getElementById('archiveDetailsModal').style.display = 'block';

  } catch (error) {
    showAlert('error', `Erro: ${error.message}`);
  } finally {
    hideLoading();
  }
}

function showGroupSearch(groupId, branchId) {
  const container = document.getElementById(`searchContainer-${groupId}`);
  container.style.display = container.style.display === 'none' ? 'block' : 'none';
}
function submitTransaction() {
  const typeElement = document.getElementById('transactionType');
  if (!typeElement) return;
  const type = typeElement.value;
   newTransaction(type);
};
function filterArchiveResults(groupId, query) {
  const resultsContainer = document.getElementById(`results-${groupId}`);
  resultsContainer.innerHTML = `<p>Busca por: <strong>${query}</strong> (simulação)</p>`;
}
function toggleGroupSearch(groupId) {
  const container = document.getElementById(`searchContainer-${groupId}`);
  container.style.display = container.style.display === 'none' ? 'block' : 'none';
}


async function searchTransactions(groupId, branchId) {
  try {
    const searchInput = document.getElementById(`searchInput-${groupId}`);
    const name = searchInput.value.trim();
    
    if (!name) {
      showAlert('warning', 'Digite um nome para pesquisar');
      return;
    }

    showLoading();
    const response = await fetch(`/api/groups/${groupId}/transactions?name=${encodeURIComponent(name)}&branchId=${branchId}`, {
      headers: getAuthHeaders()
    });

    if (!response.ok) throw new Error('Erro na pesquisa');
    
    const transactions = await response.json();
    
    const resultsDiv = document.getElementById(`results-${groupId}`);
    resultsDiv.innerHTML = `
      <h5>Resultados para: ${name}</h5>
      <table class="results-table">
        <thead>
          <tr>
            <th>Data</th>
            <th>Tipo</th>
            <th>Valor</th>
            <th>Descrição</th>
            <th>Congregação</th>
          </tr>
        </thead>
        <tbody>
          ${transactions.map(t => `
            <tr>
              <td>${formatDateTime(t.transaction_date)}</td>
              <td>${t.type}</td>
              <td>${formatCurrency(t.amount)}</td>
              <td>${t.description || '-'}</td>
              <td>${t.branch_name}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    if (transactions.length === 0) {
      resultsDiv.innerHTML += '<p class="no-results">Nenhuma transação encontrada</p>';
    }

  } catch (error) {
    showAlert('error', `Erro: ${error.message}`);
  } finally {
    hideLoading();
  }
}
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM completamente carregado');

  if (document.getElementById('loginForm')) {
    setupLoginPage();
  }
  if (document.getElementById('groupSelect')) {
    loadDashboard();
  }
  if (document.getElementById('congregationsTable')) {
    loadAdminPanel();
  }
  const transactionTypeElement = document.getElementById('transactionType');
  console.log('transactionTypeElement:', transactionTypeElement);
  setTimeout(() => {
    const transactionTypeElement = document.getElementById('transactionType');
    console.log('transactionTypeElement após 1 segundo:', transactionTypeElement);
  if (transactionTypeElement) {
    transactionTypeElement.addEventListener('change', function() {
      const type = this.value;
      const groupSelection = document.getElementById('groupSelection');
      console.log('groupSelection:', groupSelection);
      
      if (groupSelection) {
        groupSelection.style.display = (type === 'DEPOSITO' || type === 'RETIRADA') ? 'block' : 'none';
      }
    });
  }
}, 1000);
});