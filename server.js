import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mysql from 'mysql2/promise';
import cors from 'cors';
import bcrypt from 'bcrypt';
import cron from 'node-cron';
import 'dotenv/config';

// ----------------------------------------
// CONFIGURAÇÃO DO SERVIDOR
// ----------------------------------------

const app = express();
const serverPort = process.env.PORT || 3000;

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }
});

app.use(cors({
    origin: ['http://127.0.0.1:5500',
             'https://barber-app-frontend-tawny.vercel.app'
    ], // Libera o seu Live Server local e o do vercel;
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
// ----------------------------------------
// BANCO DE DADOS
// ----------------------------------------

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 16319,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false // Obrigatório para o Aiven
    },
    connectTimeout: 20000, // Dá mais tempo para a conexão transatlântica
});

try {
    await pool.query('SELECT 1');
    console.log('✅ Conexão com o Banco Aiven estabelecida com sucesso!');
} catch (err) {
    console.error('❌ Erro real na conexão com o banco:', err.message);
}

pool.getConnection((err, connection) => {
    if (err) {
        console.error("❌ ERRO DE CONEXÃO NO AIVEN:");
        console.error("Código do Erro:", err.code);
        console.error("Mensagem:", err.message);
        console.error("Porta tentada:", pool.config.connectionConfig.port);
    } else {
        console.log("✅ CONECTADO COM SUCESSO NA PORTA:", pool.config.connectionConfig.port);
        connection.release();
    }
});


// ----------------------------------------
// WEBSOCKET
// ----------------------------------------

io.on('connection', (socket) => {
    console.log(`[Socket] Usuário conectado: ${socket.id}`);
    socket.on('disconnect', () => console.log(`[Socket] Usuário desconectado: ${socket.id}`));
});

// ----------------------------------------
// ROTAS DE AUTENTICAÇÃO
// ----------------------------------------

// POST /register — Cadastra um novo barbeiro ou cliente
app.post('/register', async (req, res) => {
    const { name, email, password, phone, userType } = req.body;

    if (!name || !email || !password || !phone || !userType) {
        return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        if (userType === 'client') {
            const [result] = await pool.execute(
                'INSERT INTO clients (name, email, password, phone) VALUES (?, ?, ?, ?)',
                [name, email, hashedPassword, phone]
            );
            return res.status(201).json({ message: 'Cliente cadastrado com sucesso!', userId: result.insertId });
        }

        if (userType === 'barber') {
            // Gera um código único para o barbeiro
            let code;
            let codeExists = true;
            while (codeExists) {
                code = `BARBER${Math.floor(10000 + Math.random() * 90000)}`;
                const [rows] = await pool.execute('SELECT id FROM barbers WHERE code = ?', [code]);
                codeExists = rows.length > 0;
            }

            const [result] = await pool.execute(
                'INSERT INTO barbers (name, email, password, phone, code) VALUES (?, ?, ?, ?, ?)',
                [name, email, hashedPassword, phone, code]
            );

            // Cria as configurações padrão para o novo barbeiro
            await pool.execute(
                'INSERT INTO settings (barber_id, logo_url, background_image_url, available_time_slots) VALUES (?, ?, ?, ?)',
                [
                    result.insertId,
                    'https://placehold.co/100x100/334155/FFFFFF?text=Logo',
                    'https://images.unsplash.com/photo-1622288432458-2d7c3a6e3e0d?q=80&w=1932',
                    '09:00,09:30,10:00,10:30,11:00,11:30,14:00,14:30,15:00,15:30,16:00,16:30,17:00'
                ]
            );

            return res.status(201).json({
                message: `Barbearia cadastrada com sucesso!`,
                userId: result.insertId,
                code
            });
        }

        return res.status(400).json({ error: 'Tipo de usuário inválido.' });

    } catch (error) {
        console.error('[Erro] /register:', error);
        return res.status(500).json({ error: 'Erro ao cadastrar. O e-mail pode já estar em uso.' });
    }
});

// POST /login — Autentica um barbeiro ou cliente
app.post('/login', async (req, res) => {
    const { email, password, userType } = req.body;

    if (!email || !password || !userType) {
        return res.status(400).json({ error: 'Email, senha e tipo de usuário são obrigatórios.' });
    }

    try {
        let query;
        if (userType === 'barber') {
            query = `
                SELECT b.id, b.name, b.email, b.password, b.phone, b.code,
                       b.subscription_status, b.subscription_due_date,
                       s.logo_url, s.background_image_url
                FROM barbers b
                LEFT JOIN settings s ON b.id = s.barber_id
                WHERE b.email = ?
            `;
        } else if (userType === 'client') {
            query = 'SELECT id, name, email, password, phone FROM clients WHERE email = ?';
        } else {
            return res.status(400).json({ error: 'Tipo de usuário inválido.' });
        }

        const [rows] = await pool.execute(query, [email]);

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Email ou senha incorretos.' });
        }

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ error: 'Email ou senha incorretos.' });
        }

        delete user.password;
        return res.status(200).json({ message: 'Login bem-sucedido!', user });

    } catch (error) {
        console.error('[Erro] /login:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// ----------------------------------------
// ROTAS DE LEITURA (GET)
// ----------------------------------------

// GET /barbers?code=XXXXX — Busca barbearia pelo código
app.get('/barbers', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Código da barbearia é obrigatório.' });

    try {
        const [rows] = await pool.execute('SELECT id, name, code FROM barbers WHERE code = ?', [code]);
        if (rows.length === 0) return res.status(404).json({ error: 'Barbearia não encontrada.' });

        const [settings] = await pool.execute(
            'SELECT logo_url, background_image_url FROM settings WHERE barber_id = ?',
            [rows[0].id]
        );
        const barber = { ...rows[0], ...settings[0] };
        return res.status(200).json([barber]);

    } catch (error) {
        console.error('[Erro] GET /barbers:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// GET /services/:barberId
app.get('/services/:barberId', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM services WHERE barber_id = ?', [req.params.barberId]);
        return res.status(200).json(rows);
    } catch (error) {
        console.error('[Erro] GET /services:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// GET /plans/:barberId
app.get('/plans/:barberId', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM plans WHERE barber_id = ?', [req.params.barberId]);
        return res.status(200).json(rows);
    } catch (error) {
        console.error('[Erro] GET /plans:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// GET /appointments/:barberId
app.get('/appointments/:barberId', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM appointments WHERE barber_id = ?', [req.params.barberId]);
        return res.status(200).json(rows);
    } catch (error) {
        console.error('[Erro] GET /appointments:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// GET /appointments/occupied/:barberId/:date — Horários ocupados em uma data
app.get('/appointments/occupied/:barberId/:date', async (req, res) => {
    const { barberId, date } = req.params;
    try {
        const [rows] = await pool.execute(
            'SELECT time FROM appointments WHERE barber_id = ? AND date = ?',
            [barberId, date]
        );
        const occupied = rows.map(r => r.time.trim().substring(0, 5));
        return res.json(occupied);
    } catch (error) {
        console.error('[Erro] GET /appointments/occupied:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// GET /expenses/:barberId
app.get('/expenses/:barberId', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM expenses WHERE barber_id = ?', [req.params.barberId]);
        return res.status(200).json(rows);
    } catch (error) {
        console.error('[Erro] GET /expenses:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// GET /clients/:barberId — Clientes que agendaram com o barbeiro
app.get('/clients/:barberId', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT DISTINCT c.* FROM clients c JOIN appointments a ON c.id = a.client_id WHERE a.barber_id = ?',
            [req.params.barberId]
        );
        return res.status(200).json(rows);
    } catch (error) {
        console.error('[Erro] GET /clients:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// GET /settings/:barberId
app.get('/settings/:barberId', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT logo_url, background_image_url, available_time_slots FROM settings WHERE barber_id = ?',
            [req.params.barberId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Configurações não encontradas.' });
        return res.status(200).json(rows[0]);
    } catch (error) {
        console.error('[Erro] GET /settings:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// ----------------------------------------
// ROTAS DE SERVIÇOS (POST / PUT / DELETE)
// ----------------------------------------

app.post('/services', async (req, res) => {
    const { barber_id, name, price, duration_minutes, image_url } = req.body;
    try {
        const [result] = await pool.execute(
            'INSERT INTO services (barber_id, name, price, duration, image_url) VALUES (?, ?, ?, ?, ?)',
            [barber_id, name, price, duration_minutes, image_url]
        );
        io.emit('servicos_atualizados');
        return res.status(201).json({ message: 'Serviço adicionado!', id: result.insertId });
    } catch (error) {
        console.error('[Erro] POST /services:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.put('/services/:id', async (req, res) => {
    const { name, price, duration_minutes, image_url } = req.body;
    try {
        await pool.execute(
            'UPDATE services SET name = ?, price = ?, duration = ?, image_url = ? WHERE id = ?',
            [name, price, duration_minutes, image_url, req.params.id]
        );
        io.emit('servicos_atualizados');
        return res.status(200).json({ message: 'Serviço atualizado!' });
    } catch (error) {
        console.error('[Erro] PUT /services:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.delete('/services/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM services WHERE id = ?', [req.params.id]);
        io.emit('servicos_atualizados');
        return res.status(200).json({ message: 'Serviço excluído!' });
    } catch (error) {
        console.error('[Erro] DELETE /services:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// ----------------------------------------
// ROTAS DE PLANOS (POST / PUT / DELETE)
// ----------------------------------------

app.post('/plans', async (req, res) => {
    const { barber_id, name, description, price } = req.body;
    try {
        const [result] = await pool.execute(
            'INSERT INTO plans (barber_id, name, description, price) VALUES (?, ?, ?, ?)',
            [barber_id, name, description, price]
        );
        io.emit('planos_atualizados');
        return res.status(201).json({ message: 'Plano adicionado!', id: result.insertId });
    } catch (error) {
        console.error('[Erro] POST /plans:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.put('/plans/:id', async (req, res) => {
    const { name, description, price } = req.body;
    try {
        await pool.execute(
            'UPDATE plans SET name = ?, description = ?, price = ? WHERE id = ?',
            [name, description, price, req.params.id]
        );
        io.emit('planos_atualizados');
        return res.status(200).json({ message: 'Plano atualizado!' });
    } catch (error) {
        console.error('[Erro] PUT /plans:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.delete('/plans/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM plans WHERE id = ?', [req.params.id]);
        io.emit('planos_atualizados');
        return res.status(200).json({ message: 'Plano excluído!' });
    } catch (error) {
        console.error('[Erro] DELETE /plans:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// ----------------------------------------
// ROTAS DE AGENDAMENTOS (POST / PUT / DELETE)
// ----------------------------------------

// POST /appointments — Cria agendamento com verificação de conflito
app.post('/appointments', async (req, res) => {
    const { barber_id, client_id, service_id, date, time, status } = req.body;
    const cleanDate = date?.toString().trim();
    const cleanTime = time?.toString().trim();

    if (!barber_id || !client_id || !cleanDate || !cleanTime) {
        return res.status(400).json({ error: 'Campos obrigatórios faltando.' });
    }

    try {
        const [conflict] = await pool.execute(
            'SELECT id FROM appointments WHERE barber_id = ? AND date = ? AND TIME(time) = TIME(?)',
            [barber_id, cleanDate, cleanTime]
        );

        if (conflict.length > 0) {
            return res.status(409).json({ error: 'Este horário já está ocupado. Escolha outro.' });
        }

        const [result] = await pool.execute(
            'INSERT INTO appointments (barber_id, client_id, service_id, date, time, status) VALUES (?, ?, ?, ?, ?, ?)',
            [barber_id, client_id, service_id, cleanDate, cleanTime, status || 'Agendado']
        );
        io.emit('agendamentos_atualizados');
        return res.status(201).json({ message: 'Agendamento criado!', id: result.insertId });

    } catch (error) {
        console.error('[Erro] POST /appointments:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.put('/appointments/:id', async (req, res) => {
    const { date, time, status } = req.body;
    try {
        await pool.execute(
            'UPDATE appointments SET date = ?, time = ?, status = ? WHERE id = ?',
            [date, time, status, req.params.id]
        );
        io.emit('agendamentos_atualizados');
        return res.status(200).json({ message: 'Agendamento atualizado!' });
    } catch (error) {
        console.error('[Erro] PUT /appointments:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// PUT /appointments/:id/status — Atualiza apenas o status do agendamento (Ex: Concluir)
app.put('/appointments/:id/status', async (req, res) => {
    const { status } = req.body; // Recebe "Concluido"
    const { id } = req.params;

    // Lista de valores permitidos no seu ENUM do banco (agora sem acento)
    const statusPermitidos = ['Agendado', 'Cancelado', 'Concluido'];

    if (!statusPermitidos.includes(status)) {
        return res.status(400).json({ error: 'Status não fornecido.' });
    }

    if (!status) {
        return res.status(400).json({ error: 'Status é obrigatório.' });
    }

    try {
        const [result] = await pool.execute(
            'UPDATE appointments SET status = ? WHERE id = ?',
            [status, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Agendamento não encontrado.' });
        }

        io.emit('agendamentos_atualizados');

        return res.status(200).json({ message: `Agendamento ${status} com sucesso!` });
    } catch (error) {
        console.error('[Erro] PUT /appointments/:id/status:', error);
        return res.status(500).json({ error: 'Erro no servidor ao atualizar status.' });
    }
});

app.delete('/appointments/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM appointments WHERE id = ?', [req.params.id]);
        io.emit('agendamentos_atualizados');
        return res.status(200).json({ message: 'Agendamento cancelado!' });
    } catch (error) {
        console.error('[Erro] DELETE /appointments:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// ----------------------------------------
// ROTAS DE DESPESAS (POST / PUT / DELETE)
// ----------------------------------------

app.post('/expenses', async (req, res) => {
    const { barber_id, description, value } = req.body;
    try {
        const [result] = await pool.execute(
            'INSERT INTO expenses (barber_id, description, value) VALUES (?, ?, ?)',
            [barber_id, description, value]
        );
        return res.status(201).json({ message: 'Despesa adicionada!', id: result.insertId });
    } catch (error) {
        console.error('[Erro] POST /expenses:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.put('/expenses/:id', async (req, res) => {
    const { description, value } = req.body;
    try {
        await pool.execute(
            'UPDATE expenses SET description = ?, value = ? WHERE id = ?',
            [description, value, req.params.id]
        );
        return res.status(200).json({ message: 'Despesa atualizada!' });
    } catch (error) {
        console.error('[Erro] PUT /expenses:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

app.delete('/expenses/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM expenses WHERE id = ?', [req.params.id]);
        return res.status(200).json({ message: 'Despesa excluída!' });
    } catch (error) {
        console.error('[Erro] DELETE /expenses:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// ----------------------------------------
// ROTAS DE CONFIGURAÇÕES E CONTA
// ----------------------------------------

app.put('/settings/:barberId', async (req, res) => {
    const { newName, newPhone, logo_url, background_image_url, available_time_slots } = req.body;
    const { barberId } = req.params;

    try {
        // 1. Atualiza o nome na tabela de usuários (Barbeiros)
        await pool.execute(
            'UPDATE barbers SET name = ?, phone = ? WHERE id = ?',
            [newName, newPhone, barberId]
        );

        // 2. Atualiza as demais configurações na tabela settings
        // Corrigido: Removida a vírgula antes de logo_url
        await pool.execute(
            'UPDATE settings SET logo_url = ?, background_image_url = ?, available_time_slots = ? WHERE barber_id = ?',
            [logo_url, background_image_url, available_time_slots, barberId]
        );

        // Notifica via Socket.io que houve mudanças
        io.emit('config_atualizada');

        return res.status(200).json({ message: 'Configurações atualizados com sucesso!' });
    } catch (error) {
        console.error('[Erro] PUT /settings:', error);
        return res.status(500).json({ error: 'Erro ao salvar no banco de dados.' });
    }
});

app.put('/clients/settings/:id', async (req, res) => {
    const { name, phone } = req.body;
    const clientId = req.params.id;

    // Validação básica no servidor (segunda camada de proteção)
    if (!name || !phone) {
        return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
    }

    try {
        // Atualiza os dados do cliente
        const [result] = await pool.execute(
            'UPDATE clients SET name = ?, phone = ? WHERE id = ?',
            [name, phone, clientId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Cliente não encontrado.' });
        }

        // Opcional: Notificar via socket se você quiser atualizar algo em tempo real
        // io.emit('perfil_cliente_atualizado', { clientId, name });

        return res.status(200).json({ message: 'Perfil atualizado com sucesso!' });
    } catch (error) {
        console.error('[Erro] PUT /clients:', error);
        return res.status(500).json({ error: 'Erro interno ao salvar os dados.' });
    }
});

// DELETE /barbers/delete-account/:barberId — Remove a conta e todos os dados do barbeiro
app.delete('/barbers/delete-account/:barberId', async (req, res) => {
    const { barberId } = req.params;
    try {
        // Deleta na ordem correta para respeitar as chaves estrangeiras
        await pool.execute('DELETE FROM dashboard WHERE barber_id = ?', [barberId]);
        await pool.execute('DELETE FROM appointments WHERE barber_id = ?', [barberId]);
        await pool.execute('DELETE FROM services WHERE barber_id = ?', [barberId]);
        await pool.execute('DELETE FROM plans WHERE barber_id = ?', [barberId]);
        await pool.execute('DELETE FROM expenses WHERE barber_id = ?', [barberId]);
        await pool.execute('DELETE FROM settings WHERE barber_id = ?', [barberId]);

        const [result] = await pool.execute('DELETE FROM barbers WHERE id = ?', [barberId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

        io.emit('barbearia_encerrada', { barberId });
        return res.status(200).json({ message: 'Conta excluída com sucesso!' });

    } catch (error) {
        console.error('[Erro] DELETE /barbers/delete-account:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});


app.delete('/clients/delete-account/:clientId', async (req, res) => {
    const { clientId } = req.params;
    try {
        // Deleta na ordem correta para respeitar as chaves estrangeiras
        await pool.execute('DELETE FROM appointments WHERE barber_id = ?', [clientId]);
  
        const [result] = await pool.execute('DELETE FROM clients WHERE id = ?', [clientId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });

        io.emit('cliente_deletado', { clientId });
        return res.status(200).json({ message: 'Conta excluída com sucesso!' });

    } catch (error) {
        console.error('[Erro] DELETE /clients/delete-account:', error);
        return res.status(500).json({ error: 'Erro no servidor.' });
    }
});

// ----------------------------------------
// Dashboard
// ----------------------------------------

app.get('/dashboard/history/:barberId', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM dashboard WHERE barber_id = ? ORDER BY created_at DESC', 
            [req.params.barberId]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar histórico.' });
    }
});

// ----------------------------------------
// AUTOMAÇÃO DE FECHAMENTO MENSAL
// ----------------------------------------

// Roda no minuto 01 do dia 01 de cada mês
cron.schedule('1 0 1 * *', async () => {
    console.log('[Automação] Iniciando fechamento financeiro mensal...');
    
    try {
        // 1. Pega a data do mês que acabou de encerrar
        const hoje = new Date();
        hoje.setMonth(hoje.getMonth() - 1);
        const mesPassado = hoje.getMonth() + 1; // MySQL usa 1-12
        const anoReferencia = hoje.getFullYear();

        // 2. Busca todos os barbeiros para processar individualmente
        const [barbeiros] = await pool.execute('SELECT id FROM barbers');

        for (const barber of barbeiros) {
            const barberId = barber.id;

            // 3. Calcula Receita (Soma de serviços concluídos no mês passado)
            const [receitaRows] = await pool.execute(`
                SELECT SUM(s.price) as total_revenue, COUNT(a.id) as services_count
                FROM appointments a
                JOIN services s ON a.service_id = s.id
                WHERE a.barber_id = ? AND a.status = 'Concluido' 
                AND MONTH(a.date) = ? AND YEAR(a.date) = ?`, 
                [barberId, mesPassado, anoReferencia]
            );

            // 4. Calcula Despesas (Soma de despesas do mês passado)
            const [despesaRows] = await pool.execute(`
                SELECT SUM(value) as total_expenses 
                FROM expenses 
                WHERE barber_id = ? 
                AND MONTH(created_at) = ? AND YEAR(created_at) = ?`, 
                [barberId, mesPassado, anoReferencia]
            );

            const revenue = parseFloat(receitaRows[0].total_revenue || 0);
            const services = receitaRows[0].services_count || 0;
            const expenses = parseFloat(despesaRows[0].total_expenses || 0);
            const profit = revenue - expenses;

            // 5. Salva na tabela dashboard
            await pool.execute(`
                INSERT INTO dashboard (barber_id, services_provided, total_revenue, total_expenses, net_profit)
                VALUES (?, ?, ?, ?, ?)`,
                [barberId, services, revenue, expenses, profit]
            );

            console.log(`[Automação] Mês ${mesPassado}/${anoReferencia} fechado para o Barbeiro ID: ${barberId}`);
        }
        
        console.log('[Automação] Todos os fechamentos foram concluídos com sucesso!');
        io.emit('fechamento_mensal_concluido'); // Avisa o front-end se necessário

    } catch (error) {
        console.error('[Erro Automação] Falha no fechamento mensal:', error);
    }
});


httpServer.listen(serverPort, () => {
    console.log(`✅ Servidor API rodando localmente na porta ${serverPort}`);
    console.log(`Attempting to connect to Aiven Database on port ${process.env.DB_PORT}...`);
});
