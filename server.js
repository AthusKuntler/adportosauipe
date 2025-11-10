require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const cors = require('cors');
const morgan = require('morgan');
const PDFDocument = require('pdfkit');
const fs = require('fs');


// Configuração do banco de dados
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'akmc2505',
  database: process.env.DB_NAME || 'sistema_contas',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 100,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

const db = mysql.createPool(dbConfig);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(morgan('combined'));

// Middleware de autenticação
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'segredo_temporario');
    const [user] = await db.query('SELECT id, name, is_admin FROM branches WHERE id = ?', [decoded.id]);
    
    if (!user.length) return res.status(403).json({ error: 'Token inválido' });

    req.user = {
      id: user[0].id,
      name: user[0].name,
      isAdmin: user[0].is_admin,
      branchId: user[0].id
    };
    next();
  } catch (error) {
    console.error('Erro na autenticação:', error);
    res.status(403).json({ error: 'Token inválido ou expirado' });
  }
};
// Rota de saúde do servidor
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date() });
});

// Rotas Públicas
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/login', async (req, res) => {
  const { congregation, password } = req.body;

  if (!congregation || !password) {
    return res.status(400).json({ error: 'Preencha todos os campos' });
  }

  try {
    const [rows] = await db.query(
      'SELECT id, name, password, is_admin FROM branches WHERE name = ?', 
      [congregation]
    );
    
    if (!rows.length) {
      return res.status(404).json({ error: 'Congregação não encontrada' });
    }
    
    const user = rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }

    // 🔥 Aqui garantimos que Caixa Geral será criado, se ainda não existir
    await initializeGeneralCash(user.id);
    

    const token = jwt.sign(
      { id: user.id, isAdmin: user.is_admin },
      process.env.JWT_SECRET || 'segredo_temporario',
      { expiresIn: '8h' }
    );
    
    res.json({ 
      id: user.id,
      name: user.name,
      isAdmin: user.is_admin,
      token
    });

  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});


// Rotas Protegidas
app.get('/api/group-types', authenticateToken, async (req, res) => {
  const { name } = req.query;
  try {
    const [types] = await db.query(
      'SELECT id FROM group_types WHERE name = ?', 
      [name]
    );
    res.json(types);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar tipo' });
  }
});

app.get('/api/balance', authenticateToken, async (req, res) => {
  if (req.user.isAdmin) {
    return res.status(403).json({ error: 'Apenas usuários comuns podem acessar esta rota' });
  }

  try {
    const branchId = req.user.id;

    const [result] = await db.query(`
      SELECT COALESCE(SUM(current_balance), 0) AS balance
      FROM congregation_groups
      WHERE branch_id = ?
    `, [branchId]);

    res.json({ balance: parseFloat(result[0].balance) });

  } catch (error) {
    console.error('Erro ao calcular saldo geral da congregação:', error);
    res.status(500).json({ error: 'Erro ao calcular saldo geral da congregação' });
  }
});

app.get('/api/transactions', authenticateToken, async (req, res) => { 
  try {
    const { group_id } = req.query;
    const user = req.user;

    let query = `
    SELECT 
      t.id,
      t.amount,
      t.transaction_date,
      t.description,
      t.person_name,
      gt.name as type,
      g.name as group_name,
      b.name as branch_name
    FROM transactions t
    JOIN congregation_groups g ON t.group_id = g.id
    JOIN branches b ON t.branch_id = b.id
    JOIN group_types gt ON t.group_type_id = gt.id
    WHERE t.branch_id = ?
    `;

    const params = [user.id];
    
    if (group_id) {
      query += ' AND t.group_id = ?';
      params.push(group_id);
    }

    query += ' ORDER BY t.transaction_date DESC';
    
    const [transactions] = await db.query(query, params);
    
    res.status(200).json(transactions);
    
  } catch (error) {
    console.error('Erro ao buscar transações:', error);
    res.status(500).json({ error: 'Erro ao buscar transações' });
  }
});

// Obter detalhes de uma transação
app.get('/api/transactions/:id', authenticateToken, async (req, res) => {
  try {
    const [transaction] = await db.query(`
      SELECT t.*, gt.name as type_name 
      FROM transactions t
      JOIN group_types gt ON t.group_type_id = gt.id
      WHERE t.id = ?
    `, [req.params.id]);
    
    if (!transaction.length) {
      return res.status(404).json({ error: 'Transação não encontrada' });
    }
    
    res.json(transaction[0]);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar transação' });
  }
});

// Atualizar uma transação
app.put('/api/transactions/:id', authenticateToken, async (req, res) => {
  try {
    const { amount, description, person_name } = req.body;
    
    // Buscar transação existente
    const [existing] = await db.query('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!existing.length) {
      return res.status(404).json({ error: 'Transação não encontrada' });
    }
    
    const transaction = existing[0];
    const difference = parseFloat(amount) - parseFloat(transaction.amount);
    
    // Atualizar transação
    await db.query(`
      UPDATE transactions SET
        amount = ?,
        description = ?,
        person_name = ?
      WHERE id = ?
    `, [amount, description, person_name, req.params.id]);
    
    // Atualizar saldo do grupo
    await db.query(`
      UPDATE congregation_groups 
      SET current_balance = current_balance + ?
      WHERE id = ?
    `, [difference, transaction.group_id]);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar transação' });
  }
});

app.get('/api/archives', authenticateToken, async (req, res) => {
  try {
    const { month } = req.query;
    const user = req.user;

    let query = `
      SELECT 
        m.id,
        m.month_year,
        b.name as branch_name,
        m.total_dizimos,
        m.total_ofertas,
        m.final_balance,
        m.archived_at
      FROM monthly_archives m
      JOIN branches b ON m.branch_id = b.id
      WHERE 1=1
    `;

    const params = [];

    // Filtro por mês
    if (month) {
      query += ' AND m.month_year = ?';
      params.push(month);
    }

    // Se não for admin, filtrar apenas pela congregação do usuário
    if (!user.isAdmin) {
      query += ' AND m.branch_id = ?';
      params.push(user.id);
    }

    query += ' ORDER BY m.month_year DESC, b.name';

    const [archives] = await db.query(query, params);
    
    // Formatar datas
    const formattedArchives = archives.map(archive => ({
      ...archive,
      archived_at: new Date(archive.archived_at).toISOString(),
      month_year: archive.month_year.replace(/(\d{4})-(\d{2})/, '$1/$2')
    }));

    res.json(formattedArchives);

  } catch (error) {
    console.error('Erro ao buscar arquivos:', error);
    res.status(500).json({ 
      error: 'Erro ao buscar arquivamentos',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/api/groups', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const { name } = req.query;
    
    // Construir a query base
    let query = `
      SELECT 
        g.id,
        g.name,
        gt.name as group_type,
        g.current_balance as balance,
        b.name as branch_name
      FROM congregation_groups g
      JOIN group_types gt ON g.group_type_id = gt.id
      JOIN branches b ON g.branch_id = b.id
      ${user.isAdmin ? '' : 'WHERE g.branch_id = ?'}
    `;

    const params = user.isAdmin ? [] : [user.id];
    
    // Adicionar filtro por nome se fornecido
    if (name) {
      query += user.isAdmin ? ' WHERE g.name = ?' : ' AND g.name = ?';
      params.push(name);
    }

    // Adicionar ordenação
    query += `
      ORDER BY
        g.is_system DESC,  -- Prioridade para Caixa Geral
        g.name ASC
    `;

    const [groups] = await db.query(`
      SELECT 
        g.id,
        g.name,
        gt.name as group_type,
        g.current_balance as balance,
        b.name as branch_name
      FROM congregation_groups g
      JOIN group_types gt ON g.group_type_id = gt.id
      JOIN branches b ON g.branch_id = b.id
      ${user.isAdmin ? '' : 'WHERE g.branch_id = ?'}
      ORDER BY g.is_system DESC, g.name ASC`,
      user.isAdmin ? [] : [user.id]
    );
    res.json(groups);
    
  } catch (error) {
    console.error('Erro ao buscar grupos:', error);
    res.status(500).json({ 
      error: 'Erro ao buscar grupos',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Rotas específicas para o admin
app.get('/api/admin/balances', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  try {
    // 1️⃣ Saldo por congregação (apenas transações após o último arquivamento)
    const [branches] = await db.query(`
      SELECT 
        b.id,
        b.name,
        COALESCE(SUM(
          CASE 
            WHEN gt.name IN ('DIZIMO', 'OFERTA', 'DEPOSITO') THEN t.amount
            WHEN gt.name = 'RETIRADA' THEN -t.amount
            ELSE 0
          END
        ), 0) AS balance
      FROM branches b
      LEFT JOIN congregation_groups g 
        ON b.id = g.branch_id
      LEFT JOIN transactions t 
        ON g.id = t.group_id
      LEFT JOIN group_types gt 
        ON t.group_type_id = gt.id
      LEFT JOIN (
        SELECT branch_id, MAX(archived_at) AS last_archive
        FROM monthly_archives
        GROUP BY branch_id
      ) ma ON ma.branch_id = b.id
      WHERE b.is_admin = FALSE
        AND (t.transaction_date IS NULL OR t.transaction_date > IFNULL(ma.last_archive, '1900-01-01'))
      GROUP BY b.id
    `);

    // 2️⃣ Totais por tipo (após último arquivamento geral)
    const [typeBalances] = await db.query(`
      SELECT 
        gt.name AS type,
        SUM(
          CASE 
            WHEN gt.name = 'RETIRADA' THEN -t.amount
            ELSE t.amount
          END
        ) AS total
      FROM transactions t
      JOIN group_types gt ON t.group_type_id = gt.id
      LEFT JOIN (
        SELECT branch_id, MAX(archived_at) AS last_archive
        FROM monthly_archives
        GROUP BY branch_id
      ) ma ON ma.branch_id = t.branch_id
      WHERE 
        gt.name IN ('DIZIMO', 'OFERTA')
        AND t.transaction_date > IFNULL(ma.last_archive, '1900-01-01')
      GROUP BY gt.name
    `);

    // 3️⃣ Total geral (somatório das congregações já filtradas)
    const totalBalance = branches.reduce((sum, branch) => sum + parseFloat(branch.balance), 0);

    res.json({ 
      branches,
      typeBalances,
      totalBalance
    });

  } catch (error) {
    console.error('Erro ao calcular saldos:', error);
    res.status(500).json({ 
      error: 'Erro ao calcular saldos',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


app.get('/api/admin/branches/:id/groups', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  try {
    const [groups] = await db.query(`
      SELECT 
        g.id,
        g.name,
        COALESCE(
          (SELECT new_balance 
           FROM transactions 
           WHERE group_id = g.id 
           ORDER BY id DESC LIMIT 1), 0
        ) as balance
      FROM congregation_groups g
      WHERE g.branch_id = ?
      ORDER BY g.name
    `, [req.params.id]);

    res.json(groups);
  } catch (error) {
    console.error('Erro ao buscar grupos:', error);
    res.status(500).json({ error: 'Erro ao buscar grupos' });
  }
});

app.get('/api/groups/:groupId/transactions', authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name } = req.query;

    const [transactions] = await db.query(`
      SELECT 
        t.id,
        t.amount,
        t.transaction_date,
        t.description,
        t.person_name,
        gt.name AS type,
        g.name AS group_name,
        b.name AS branch_name
      FROM transactions t
      JOIN group_types gt ON t.group_type_id = gt.id
      JOIN congregation_groups g ON t.group_id = g.id
      JOIN branches b ON t.branch_id = b.id
      WHERE t.group_id = ?
        AND t.person_name LIKE ?
      ORDER BY t.transaction_date DESC
    `, [groupId, `%${name}%`]);

    res.json(transactions);
  } catch (error) {
    console.error('Erro na busca:', error);
    res.status(500).json({ error: 'Erro na busca de transações' });
  }
});

app.post('/api/admin/monthly-archive', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Obter IDs dos tipos de transação necessários
    const [types] = await connection.query(
      'SELECT id, name FROM group_types WHERE name IN ("DIZIMO", "OFERTA", "DEPOSITO", "RETIRADA")'
    );
    const typeMap = types.reduce((acc, t) => ({ ...acc, [t.name]: t.id }), {});

    // 2. Obter todas as congregações (exceto admin)
    const [branches] = await connection.query(
      'SELECT id, name FROM branches WHERE is_admin = FALSE'
    );

    // 3. Definir período de referência (mês anterior)
    const previous = new Date();
    previous.setMonth(previous.getMonth() - 1);
    const year = previous.getFullYear();
    const month = String(previous.getMonth() + 1).padStart(2, '0');
    const monthYear = `${year}-${month}`;
    const archiveDate = new Date();

    // 4. Processar cada congregação
    for (const branch of branches) {
      const branchId = branch.id;

      // 5. Buscar todos os grupos da congregação
      const [groups] = await connection.query(`
        SELECT id, name, current_balance
        FROM congregation_groups
        WHERE branch_id = ?
      `, [branchId]);

      let totalDizimos = 0;
      let totalOfertas = 0;
      let finalBalance = 0;

      // 6. Armazenar cada grupo no histórico
      for (const group of groups) {
        await connection.query(`
          INSERT INTO monthly_group_archives (archive_id, group_id, group_name, initial_balance, final_balance)
          VALUES (NULL, ?, ?, ?, ?) 
        `, [group.id, group.name, group.current_balance, group.current_balance]);

        finalBalance += parseFloat(group.current_balance);
      }

      // 7. Calcular totais de dízimos e ofertas do mês
      const [dizimos] = await connection.query(`
        SELECT COALESCE(SUM(amount), 0) as total FROM transactions
        WHERE branch_id = ? 
        AND group_type_id = ?
        AND MONTH(transaction_date) = ?
        AND YEAR(transaction_date) = ?
      `, [branchId, typeMap['DIZIMO'], month, year]);
      totalDizimos = dizimos[0].total;

      const [ofertas] = await connection.query(`
        SELECT COALESCE(SUM(amount), 0) as total FROM transactions
        WHERE branch_id = ? 
        AND group_type_id = ?
        AND MONTH(transaction_date) = ?
        AND YEAR(transaction_date) = ?
      `, [branchId, typeMap['OFERTA'], month, year]);
      totalOfertas = ofertas[0].total;

      // 8. Inserir registro de arquivamento
      const [archiveResult] = await connection.query(`
        INSERT INTO monthly_archives (
          branch_id, month_year, 
          total_dizimos, total_ofertas, final_balance, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [branchId, monthYear, totalDizimos, totalOfertas, finalBalance, archiveDate]);

      const archiveId = archiveResult.insertId;

      // 9. Atualizar registros de grupos com ID de arquivamento
      await connection.query(`
        UPDATE monthly_group_archives
        SET archive_id = ?
        WHERE archive_id IS NULL AND group_id IN (
          SELECT id FROM congregation_groups WHERE branch_id = ?
        )
      `, [archiveId, branchId]);

      // 10. Zerar saldos dos grupos com transações de ajuste
      for (const group of groups) {
        const currentBalance = parseFloat(group.current_balance);
        
        // Pular grupos já zerados
        if (currentBalance === 0) continue;

        const type = currentBalance > 0 ? 'RETIRADA' : 'DEPOSITO';
        const amount = Math.abs(currentBalance);

        // Inserir transação de ajuste
        await connection.query(`
          INSERT INTO transactions (
            group_id, group_type_id, amount, description,
            person_name, branch_id, previous_balance, new_balance, transaction_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          group.id,
          typeMap[type],
          amount,
          'Ajuste mensal - Zeramento',
          'Sistema',
          branchId,
          currentBalance,
          0,
          archiveDate
        ]);

        // Atualizar saldo para zero
        await connection.query(`
          UPDATE congregation_groups SET current_balance = 0 WHERE id = ?
        `, [group.id]);
      }
    }
     await connection.commit();
    res.json({ 
      success: true, 
      message: 'Arquivamento mensal concluído com sucesso',
      monthYear: monthYear
    });

  } catch (error) {
    await connection.rollback();
    console.error('Erro no arquivamento mensal:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro no arquivamento mensal',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

app.get('/api/admin/archives/:id/pdf', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  try {
    const archiveId = req.params.id;

    const [archiveRows] = await db.query(`
      SELECT a.*, b.name AS branch_name
      FROM monthly_archives a
      JOIN branches b ON b.id = a.branch_id
      WHERE a.id = ?
    `, [archiveId]);

    if (!archiveRows.length) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }

    const archive = archiveRows[0];

    const [groups] = await db.query(`
      SELECT group_name, initial_balance, final_balance
      FROM monthly_group_archives
      WHERE archive_id = ?
    `, [archiveId]);

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50 });
    const fileName = `arquivo-${archive.month_year}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    doc.pipe(res);

    // === LOGO e CABEÇALHO INSTITUCIONAL ===
    const fs = require('fs');
    const path = require('path');

    try {
   const logoPath = path.join(__dirname, 'public', 'images', 'igreja-logo.png');
   if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 250, 30, { width: 100 });
  }
} catch (err) {
  console.warn('Erro ao carregar logo:', err.message);
}

    doc.moveDown(6);
    doc.fontSize(12).fillColor('#000').font('Helvetica-Bold')
      .text('IGREJA EVANGÉLICA ASSEMBLEIA DE DEUS EM PORTO DE SAUIPE – BAHIA', {
        align: 'center'
      });

    doc.fontSize(11).font('Helvetica')
      .text('RUA PRINCIPAL, LOTEAMENTO MARESIAS S/N – CNPJ: 22.188.443/0001-90', {
        align: 'center'
      });

    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(1.5);

    // === Cabeçalho principal ===
    doc.fontSize(18).fillColor('#004080').text('Relatório Mensal de Contas', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(14).fillColor('black');
    doc.text(`Congregação: ${archive.branch_name}`);
    doc.text(`Período: ${archive.month_year.replace('-', '/')}`);
    doc.text(`Data do Arquivamento: ${new Date(archive.archived_at).toLocaleDateString('pt-BR')}`);
    doc.moveDown(1);

    // === RESUMO ===
    doc.fontSize(16).fillColor('#333').text('Resumo Financeiro', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('black');
    doc.text(`Dízimos:       ${formatCurrency(archive.total_dizimos)}`);
    doc.text(`Ofertas:       ${formatCurrency(archive.total_ofertas)}`);
    doc.text(`Saldo Final:   ${formatCurrency(archive.final_balance)}`);
    doc.moveDown(1);

    // === Detalhamento por Grupo ===
    doc.fontSize(16).fillColor('#333').text('Detalhamento por Grupo', { underline: true });
    doc.moveDown(0.5);

    // Cabeçalho da "tabela"
    doc.fontSize(12).fillColor('#000').text('Grupo', 50)
      .text('Saldo Inicial', 250, doc.y - 15, { width: 100, align: 'right' })
      .text('Saldo Final', 400, doc.y - 15, { width: 100, align: 'right' });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#888');
    doc.moveDown(0.5);

    // Linhas por grupo
    groups.forEach(group => {
      doc.fillColor('#333').text(group.group_name, 50)
        .text(formatCurrency(group.initial_balance), 250, doc.y - 15, { width: 100, align: 'right' })
        .text(formatCurrency(group.final_balance), 400, doc.y - 15, { width: 100, align: 'right' });
      doc.moveDown(0.2);
    });

    // === ASSINATURAS ===
doc.moveDown(5);
const signatureY = doc.y;

doc.moveTo(80, signatureY).lineTo(230, signatureY).stroke();
doc.moveTo(330, signatureY).lineTo(480, signatureY).stroke();

doc.fontSize(11).fillColor('#000');
doc.text('1º Tesoureiro', 110, signatureY + 5);
doc.text('2º Tesoureiro', 365, signatureY + 5);

// Rodapé com data de geração
doc.moveDown(3);
doc.fontSize(10).fillColor('#888').text(`Relatório gerado em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}`, {
  align: 'center'
});

    doc.end();

  } catch (error) {
    console.error('Erro ao gerar PDF:', error);
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  }
});

app.get('/api/admin/branches/report/pdf', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  const { month } = req.query;
  if (!month) {
    return res.status(400).json({ error: 'Parâmetro "month" é obrigatório' });
  }

  try {
    const [branches] = await db.query(`
      SELECT b.id, b.name, COALESCE(SUM(mga.final_balance), 0) AS total_balance
      FROM monthly_archives ma
      JOIN branches b ON b.id = ma.branch_id
      LEFT JOIN monthly_group_archives mga ON mga.archive_id = ma.id
      WHERE ma.month_year = ?
      GROUP BY b.id, b.name
    `, [month]);

    const totalGeral = branches.reduce((sum, b) => sum + parseFloat(b.total_balance), 0);

    const doc = new PDFDocument({ margin: 50 });
    const fileName = `relatorio-saldos-congregacoes-${month}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    doc.pipe(res);

    // === LOGO e cabeçalho institucional ===
    const logoPath = path.join(__dirname, './public/images/igreja-logo.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 260, 30, { width: 90 });
    }

    doc.moveDown(6);
    doc.fontSize(12).fillColor('#000').font('Helvetica-Bold')
      .text('IGREJA EVANGÉLICA ASSEMBLEIA DE DEUS EM PORTO DE SAUIPE – BAHIA', { align: 'center' });

    doc.fontSize(11).font('Helvetica')
      .text('RUA PRINCIPAL, LOTEAMENTO MARESIAS S/N – CNPJ: 22.188.443/0001-90', { align: 'center' });

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(2);

    // Título
    doc.fontSize(18).fillColor('#004080').text(`Relatório de Saldos por Congregação`, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(12).fillColor('black').text(`Período: ${month.replace('-', '/')}`);
    doc.moveDown(1.5);

    // === TABELA DE SALDOS POR CONGREGAÇÃO ===
doc.moveDown(1);
doc.fontSize(14).fillColor('#333').text('Saldos por Congregação', { underline: true });
doc.moveDown(0.5);

branches.forEach(branch => {
  doc.fontSize(12).fillColor('#000');
  const yBefore = doc.y;
  doc.text(branch.name, 60, yBefore + 3);
  doc.text(formatCurrency(branch.total_balance), 400, yBefore + 3, { align: 'right' });
  doc.moveTo(50, yBefore + 18).lineTo(550, yBefore + 18).stroke('#ccc');
  doc.moveDown(1);
});


doc.moveDown(1);
doc.fontSize(13).fillColor('#000').text(`Saldo Geral: ${formatCurrency(totalGeral)}`, {
  underline: true,
  align: 'right'
});

// === ASSINATURAS ===
doc.moveDown(5);
const signatureY = doc.y;

doc.moveTo(80, signatureY).lineTo(230, signatureY).stroke();
doc.moveTo(330, signatureY).lineTo(480, signatureY).stroke();

doc.fontSize(11).fillColor('#000');
doc.text('1º Tesoureiro', 110, signatureY + 5);
doc.text('2º Tesoureiro', 365, signatureY + 5);

// Rodapé com data de geração
doc.moveDown(3);
doc.fontSize(10).fillColor('#888').text(`Relatório gerado em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}`, {
  align: 'center'
});

    doc.end();

  } catch (error) {
    console.error('Erro ao gerar relatório geral:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao gerar relatório geral' });
    }
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  }
});



// server.js - Atualize a rota reset-all-groups
app.post('/api/admin/branches/:id/reset-all-groups', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso não autorizado' });

  const connection = await db.getConnection();
  try {
    const branchId = parseInt(req.params.id);
    await connection.beginTransaction();

    // 1. Obter IDs dos tipos
    const [types] = await connection.query(
      'SELECT id, name FROM group_types WHERE name IN ("RETIRADA", "DEPOSITO")'
    );
    const typeMap = types.reduce((acc, t) => ({ ...acc, [t.name]: t.id }), {});

    // 2. Processar grupos
    const [groups] = await connection.query(
      'SELECT id, current_balance FROM congregation_groups WHERE branch_id = ?',
      [branchId]
    );

    for (const group of groups) {
      const currentBalance = parseFloat(group.current_balance);
      
      // Pular grupos já zerados
      if (currentBalance === 0) continue;

      const type = currentBalance > 0 ? 'RETIRADA' : 'DEPOSITO';
      const amount = Math.abs(currentBalance);

      // Validação crítica
      if (amount <= 0) {
        throw new Error(`Valor inválido para transação no grupo ${group.id}: ${amount}`);
      }
      // Inserir transação de zeramento
      const archiveDate = new Date();

      await connection.query(
        `INSERT INTO transactions (
          group_id, group_type_id, amount, description,
          person_name, branch_id, previous_balance, new_balance, transaction_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          group.id,
          typeMap[type],
          amount,
          'Zeramento administrativo',
          'Sistema',
          branchId,
          currentBalance,
          0,
          archiveDate
        ]
      );

      await connection.query(
        'UPDATE congregation_groups SET current_balance = 0 WHERE id = ?',
        [group.id]
      );
    }

    await connection.commit();
    res.json({ success: true, message: 'Zeramento concluído com sucesso' });

  } catch (error) {
    await connection.rollback();
    console.error('Erro ao zerar grupos:', error);
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

app.get('/api/admin/all-transactions', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Query principal com paginação
    const [transactions] = await db.query(`
      SELECT 
        t.*,
        b.name as branch_name,
        g.name as group_name,
        gt.name as transaction_type  -- Adicionado join com group_types
      FROM transactions t
      LEFT JOIN congregation_groups g ON t.group_id = g.id
      LEFT JOIN branches b ON t.branch_id = b.id
      LEFT JOIN group_types gt ON t.group_type_id = gt.id  -- Novo join
      ORDER BY t.transaction_date DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    // Query para contar o total
    const [totalCount] = await db.query(`
      SELECT COUNT(*) as total 
      FROM transactions
    `);

    res.json({
      transactions,
      total: totalCount[0].total,
      page,
      totalPages: Math.ceil(totalCount[0].total / limit)
    });
  } catch (error) {
    console.error('Erro ao buscar transações:', error);
    res.status(500).json({ error: 'Erro ao buscar transações' });
  }
});

app.get('/api/congregations', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  try {
    const [congregations] = await db.query(
      'SELECT id, name, created_at FROM branches WHERE is_admin = FALSE ORDER BY name'
    );
    res.json(congregations);
  } catch (error) {
    console.error('Erro ao buscar congregações:', error);
    res.status(500).json({ error: 'Erro ao buscar congregações' });
  }
});

app.get('/api/congregations/:id', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  try {
    const [congregation] = await db.query(
      'SELECT id, name FROM branches WHERE id = ? AND is_admin = FALSE',
      [req.params.id]
    );
    
    if (!congregation.length) {
      return res.status(404).json({ error: 'Congregação não encontrada' });
    }
    
    res.json(congregation[0]);
  } catch (error) {
    console.error('Erro ao buscar congregação:', error);
    res.status(500).json({ error: 'Erro ao buscar congregação' });
  }
});
// Obter lista de meses arquivados
app.get('/api/admin/archives', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  try {
    const { month } = req.query;

    // Lista de formatos possíveis para comparação no banco
    const monthCandidates = [];

    if (month) {
      // Caso o filtro venha no formato YYYY-MM (input type="month")
      const [year, mon] = month.split('-');
      monthCandidates.push(`${year}-${mon}`);   // formato YYYY-MM
      monthCandidates.push(`${mon}/${year}`);   // formato MM/YYYY
    } else {
      // 🔹 Se não tiver filtro, pega o mês anterior ao atual
      const now = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevYear = prev.getFullYear();
      const prevMonth = String(prev.getMonth() + 1).padStart(2, '0');

      monthCandidates.push(`${prevYear}-${prevMonth}`); // YYYY-MM
      monthCandidates.push(`${prevMonth}/${prevYear}`); // MM/YYYY
    }

    // Gera placeholders seguros (para evitar SQL injection)
    const placeholders = monthCandidates.map(() => '?').join(', ');

    const [archives] = await db.query(`
      SELECT 
        m.id, 
        m.month_year, 
        b.name AS branch_name,
        m.total_dizimos, 
        m.total_ofertas,
        m.final_balance, 
        m.archived_at
      FROM monthly_archives m
      JOIN branches b ON m.branch_id = b.id
      WHERE m.month_year IN (${placeholders})
      ORDER BY m.month_year DESC, b.name ASC
    `, monthCandidates);

    // Formata antes de enviar para o frontend
    const formatted = archives.map(a => {
      let monthYear = a.month_year;
      if (/^\d{4}-\d{2}$/.test(monthYear)) {
        monthYear = monthYear.replace('-', '/');
      }
      return {
        ...a,
        month_year: monthYear,
        archived_at: new Date(a.archived_at).toLocaleString('pt-BR')
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Erro ao buscar arquivos (admin):', error);
    res.status(500).json({ error: 'Erro ao buscar arquivamentos' });
  }
});

// Obter detalhes de um arquivo específico
app.get('/api/admin/archives/:id', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  try {
    // Dados principais
    const [archive] = await db.query(`
      SELECT 
        m.*, b.name as branch_name
      FROM monthly_archives m
      JOIN branches b ON m.branch_id = b.id
      WHERE m.id = ?
    `, [req.params.id]);
    
    if (!archive.length) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    
    // Grupos
    const [groups] = await db.query(`
      SELECT 
        g.group_id,
        g.group_name, 
        g.initial_balance, 
        g.final_balance
      FROM monthly_group_archives g
      WHERE g.archive_id = ?
      ORDER BY g.group_name
    `, [req.params.id]);

    res.json({
      ...archive[0],
      groups
    });
  } catch (error) {
    console.error('Erro ao buscar detalhes do arquivo:', error);
    res.status(500).json({ error: 'Erro ao buscar detalhes do arquivo' });
  }
});

app.put('/api/congregations/:id', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  const { name } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Nome é obrigatório' });
  }

  try {
    const [existing] = await db.query(
      'SELECT id FROM branches WHERE name = ? AND id != ?',
      [name, req.params.id]
    );
    
    if (existing.length) {
      return res.status(400).json({ error: 'Já existe uma congregação com este nome' });
    }

    await db.query(
      'UPDATE branches SET name = ? WHERE id = ?',
      [name, req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao atualizar congregação:', error);
    res.status(500).json({ error: 'Erro ao atualizar congregação' });
  }
});
app.put('/api/congregations/:id/change-password', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  const { currentPassword, newPassword } = req.body;

  try {
    // 1. Buscar congregação e verificar senha atual
    const [cong] = await db.query(
      'SELECT password FROM branches WHERE id = ?',
      [req.params.id]
    );

    if (!cong.length) {
      return res.status(404).json({ error: 'Congregação não encontrada' });
    }

    const validPassword = await bcrypt.compare(currentPassword, cong[0].password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }

    // 2. Validar nova senha
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'A nova senha não pode ser igual à atual' });
    }

    // 3. Criptografar e atualizar
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.query(
      'UPDATE branches SET password = ? WHERE id = ?',
      [hashedPassword, req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao alterar senha:', error);
    res.status(500).json({ error: 'Erro ao alterar senha' });
  }
});

app.post('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const { group_id, type, amount, description, person_name } = req.body;
    const user = req.user;

    // 1. VALIDAÇÕES INICIAIS
    if (!type || !amount || !person_name) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    // 2. BUSCAR CAIXA GERAL
    const [caixaGeral] = await db.query(
      'SELECT id, current_balance FROM congregation_groups WHERE name = "Caixa Geral" AND branch_id = ?',
      [user.id]
    );

    if (!caixaGeral.length) {
      return res.status(500).json({ error: 'Caixa Geral não configurado' });
    }

    // 3. VALIDAR TIPO DE TRANSAÇÃO
    const validTypes = ['DIZIMO', 'OFERTA', 'DEPOSITO', 'RETIRADA', 'OUTROS'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Tipo de transação inválido' });
    }

    // 4. OBTER ID DO TIPO DE TRANSAÇÃO
    const [groupType] = await db.query(
      'SELECT id FROM group_types WHERE name = ?',
      [type]
    );
    
    
    if (!groupType.length) {
      return res.status(400).json({ error: 'Tipo não registrado' });
    }
    const group_type_id = groupType[0].id;

    // 5. DETERMINAR GRUPO ALVO E OBTER SALDO ANTERIOR
    let targetGroupId = group_id;
    let previousBalance = 0;

    if (['DIZIMO', 'OFERTA'].includes(type)) {
      targetGroupId = caixaGeral[0].id;
      previousBalance = parseFloat(caixaGeral[0].current_balance);
    } else if (['DEPOSITO', 'RETIRADA'].includes(type)) {
      if (!targetGroupId) {
        return res.status(400).json({ error: 'Grupo obrigatório' });
      }

      const [group] = await db.query(
        'SELECT branch_id, current_balance FROM congregation_groups WHERE id = ?',
        [targetGroupId]
      );
      
      if (!group.length || (!user.isAdmin && group[0].branch_id !== user.id)) {
        return res.status(403).json({ error: 'Grupo não autorizado' });
      }

      previousBalance = parseFloat(group[0].current_balance);
    }

    // 6. TRATAMENTO DO VALOR
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) {
      return res.status(400).json({ error: 'Valor inválido' });
    }
    const preciseAmount = parseFloat(parsedAmount.toFixed(2));

    // 7. CALCULAR NOVO SALDO
    const newBalance = type === 'RETIRADA' 
      ? parseFloat((previousBalance - preciseAmount).toFixed(2))
      : parseFloat((previousBalance + preciseAmount).toFixed(2));

    if (newBalance < 0) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    // 8. INSERIR TRANSAÇÃO
    const [result] = await db.query(
      `INSERT INTO transactions (
        group_id,
        group_type_id,
        amount,
        description,
        person_name,
        branch_id,
        previous_balance,
        new_balance,
        transaction_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        targetGroupId,
        group_type_id,
        preciseAmount,
        description || null,
        person_name,
        user.id,
        previousBalance,
        newBalance
      ]
    );

    // 9. ATUALIZAR SALDO DO GRUPO
    await db.query(
      'UPDATE congregation_groups SET current_balance = ? WHERE id = ?',
      [newBalance, targetGroupId]
    );

    // 10. RESPOSTA
    res.status(201).json({
      success: true,
      transactionId: result.insertId,
      newBalance: newBalance,
      details: {
        previousBalance: previousBalance,
        transactionType: type,
        groupId: targetGroupId
      }
    });

  } catch (error) {
    console.error('Erro ao registrar transação:', error);
    res.status(500).json({ 
      error: 'Erro ao registrar transação',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// Verifica/Cria o grupo Caixa Geral ao iniciar o servidor
async function initializeGeneralCash(branchId) {
  try {
    if (!branchId) {
      throw new Error('branchId está vazio ou indefinido.');
    }

    // 1. Garantir que o tipo "Caixa Geral" exista com a grafia correta
    const [typeRows] = await db.query(
      'SELECT id FROM group_types WHERE name = "Caixa Geral"'
    );

    let groupTypeId;
    
    if (typeRows.length === 0) {
      // Criar com grafia exata se não existir
      const [result] = await db.query(
        'INSERT INTO group_types (name) VALUES ("Caixa Geral")'
      );
      groupTypeId = result.insertId;
      console.log('🟨 Tipo de grupo "Caixa Geral" criado automaticamente.');
    } else {
      groupTypeId = typeRows[0].id;
    }

    // 2. Verificar se o grupo já existe usando COLLATE para precisão
    const [existingRows] = await db.query(
      `SELECT id FROM congregation_groups 
       WHERE name = "Caixa Geral" COLLATE utf8mb4_unicode_ci 
       AND branch_id = ?`,
      [branchId]
    );

    if (existingRows.length === 0) {
      // 3. Criar grupo com valores iniciais explícitos
      await db.query(
        `INSERT INTO congregation_groups 
         (name, branch_id, group_type_id, current_balance, is_system)
         VALUES (?, ?, ?, ?, ?)`,
        ['Caixa Geral', branchId, groupTypeId, 0.00, true]
      );
      console.log(`✅ Caixa Geral criado para filial ID ${branchId}`);
    }
    
  } catch (err) {
    console.error('❌ Erro ao inicializar Caixa Geral:', err.message);
    
  }
}


// Inicia o servidor
app.listen(PORT, async () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  
  try {
    const conn = await db.getConnection();
    console.log('✅ Conexão com o banco estabelecida!');
    conn.release();
    
    // Verifica/Cria o grupo Caixa Geral para todas as congregações
    const [branches] = await db.query('SELECT id FROM branches');
    for (const branch of branches) {
      await initializeGeneralCash(branch.id);
    } 
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco:', error);
  }
});