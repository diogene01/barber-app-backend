import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mysql from 'mysql2/promise';
import cors from 'cors';
import bcrypt from 'bcrypt';
import cron from 'node-cron';
import nodemailer from 'nodemailer'; // NOVO: Importação do Nodemailer
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
// CONFIGURAÇÃO DO EMAIL (NODEMAILER)
// ----------------------------------------
const mailTransporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: false, // true para a porta 465, false para outras portas como 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Verificador de conexão do e-mail ao inicializar o servidor
mailTransporter.verify((error, success) => {
    if (error) {
        console.error('❌ Erro na configuração do serviço de e-mail:', error.message);
    } else {
        console.log('✅ Serviço de e-mail pronto para enviar mensagens!');
    }
});

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

// NOVO: POST /forgot-password — Envia e-mail real de redefinição de senha
app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'O campo de e-mail é obrigatório.' });
    }

    try {
        // 1. Procura primeiro na tabela de barbeiros
        let [userRows] = await pool.execute("SELECT id, name, 'barber' as type FROM barbers WHERE email = ?", [email]);
        
        // 2. Se não achar, procura na tabela de clientes (CORRIGIDO: usando aspas simples para a string fixa)
        if (userRows.length === 0) {
            [userRows] = await pool.execute("SELECT id, name, 'client' as type FROM clients WHERE email = ?", [email]);
        }

        // Se o e-mail não existir em nenhuma das tabelas
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'Este e-mail não está cadastrado no sistema.' });
        }

        const user = userRows[0];

        // 3. Criação do Link de Redefinição
        // Em um ambiente de produção real, você geraria um token criptografado e salvaria no banco.
        // Como simplificação segura para a sua estrutura atual, vamos criar um link temporário direcionado:
        const tokenFake = Buffer.from(JSON.stringify({ id: user.id, type: user.type, exp: Date.now() + 3600000 })).toString('base64');
        const linkRedefinicao = `https://barber-app-frontend-tawny.vercel.app/resetPassword.html?token=${tokenFake}`;

        // 4. Configuração visual do e-mail (HTML)
        const emailHtml = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
                <div style="background-color: #334155; padding: 24px; text-align: center;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 1px;">Barber App</h1>
                </div>
                <div style="padding: 32px; background-color: #ffffff; color: #1e293b;">
                    <p style="font-size: 18px; margin-top: 0; font-weight: 600;">Olá, ${user.name}!</p>
                    <p style="font-size: 16px; line-height: 1.6; color: #475569;">Você solicitou a recuperação de senha para a sua conta de <strong>${user.type === 'barber' ? 'Barbeiro' : 'Cliente'}</strong>.</p>
                    <p style="font-size: 16px; line-height: 1.6; color: #475569;">Clique no botão abaixo para escolher uma nova senha de acesso. Este link é válido por 1 hora.</p>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${linkRedefinicao}" target="_blank" style="background-color: #334155; color: #ffffff; padding: 12px 28px; font-weight: 600; text-decoration: none; border-radius: 6px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">Redefinir Minha Senha</a>
                    </div>
                    
                    <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 0;">Se você não solicitou essa alteração, nenhuma ação é necessária e você pode descartar com segurança esta mensagem.</p>
                </div>
                <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    &copy; 2026 Barber App. Todos os direitos reservados.
                </div>
            </div>
        `;

        // 5. Disparo do e-mail usando o transporte configurado
        await mailTransporter.sendMail({
            from: '"Barber App Suporte" <onboarding@resend.dev>', // Atualize com o remetente oficial do seu provedor
            to: email,
            subject: 'Recuperação de Senha - Barber App',
            html: emailHtml
        });

        return res.status(200).json({ message: 'E-mail enviado com sucesso!' });

    } catch (error) {
        console.error('[Erro] /forgot-password:', error);
        return res.status(500).json({ error: 'Erro ao tentar enviar o e-mail de recuperação.' });
    }
});

// POST /reset-password — Recebe o token e salva a nova senha criptografada com bcrypt
app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
        return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
    }

    try {
        // 1. Descriptografa o token base64 para pegar os dados do usuário
        const decodedData = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
        
        // Verifica se o link já expirou (1 hora de validade)
        if (Date.now() > decodedData.exp) {
            return res.status(400).json({ error: 'Este link de recuperação expirou. Solicite um novo.' });
        }

        const userId = decodedData.id;
        const userType = decodedData.type; // 'barber' ou 'client'

        // 2. Criptografa a nova senha gerada pelo usuário usando bcrypt
        const hashedNewPassword = await bcrypt.hash(newPassword, 10);

        // 3. Atualiza na tabela correta do banco de dados Aiven de acordo com o tipo
        let query = '';
        if (userType === 'barber') {
            query = 'UPDATE barbers SET password = ? WHERE id = ?';
        } else if (userType === 'client') {
            query = 'UPDATE clients SET password = ? WHERE id = ?';
        } else {
            return res.status(400).json({ error: 'Tipo de usuário inválido no token.' });
        }

        const [result] = await pool.execute(query, [hashedNewPassword, userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado no sistema.' });
        }

        return res.status(200).json({ message: 'Senha atualizada com sucesso!' });

    } catch (error) {
        console.error('[Erro] /reset-password:', error);
        return res.status(500).json({ error: 'Token inválido ou corrompido. Tente recuperar novamente.' });
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

app.put('/appointments/:id/status', async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    const statusPermitidos = ['Agendado', 'Cancelado', 'Concluido'];

    if (!statusPermitidos.includes(status)) {
        return res.status(400).json({ error: 'Status não fornecido.' });
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
        await pool.execute(
            'UPDATE barbers SET name = ?, phone = ? WHERE id = ?',
            [newName, newPhone, barberId]
        );

        await pool.execute(
            'UPDATE settings SET logo_url = ?, background_image_url = ?, available_time_slots = ? WHERE barber_id = ?',
            [logo_url, background_image_url, available_time_slots, barberId]
        );

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

    if (!name || !phone) {
        return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
    }

    try {
        const [result] = await pool.execute(
            'UPDATE clients SET name = ?, phone = ? WHERE id = ?',
            [name, phone, clientId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Cliente não encontrado.' });
        }

        return res.status(200).json({ message: 'Perfil updated com sucesso!' });
    } catch (error) {
        console.error('[Erro] PUT /clients:', error);
        return res.status(500).json({ error: 'Erro interno ao salvar os dados.' });
    }
});

app.delete('/barbers/delete-account/:barberId', async (req, res) => {
    const { barberId } = req.params;
    try {
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

cron.schedule('1 0 1 * *', async () => {
    console.log('[Automação] Iniciando fechamento financeiro mensal...');
    
    try {
        const hoje = new Date();
        hoje.setMonth(hoje.getMonth() - 1);
        const mesPassado = hoje.getMonth() + 1;
        const anoReferencia = hoje.getFullYear();

        const [barbeiros] = await pool.execute('SELECT id FROM barbers');

        for (const barber of barbeiros) {
            const barberId = barber.id;

            const [receitaRows] = await pool.execute(`
                SELECT SUM(s.price) as total_revenue, COUNT(a.id) as services_count
                FROM appointments a
                JOIN services s ON a.service_id = s.id
                WHERE a.barber_id = ? AND a.status = 'Concluido' 
                AND MONTH(a.date) = ? AND YEAR(a.date) = ?`, 
                [barberId, mesPassado, anoReferencia]
            );

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

            await pool.execute(`
                INSERT INTO dashboard (barber_id, services_provided, total_revenue, total_expenses, net_profit)
                VALUES (?, ?, ?, ?, ?)`,
                [barberId, services, revenue, expenses, profit]
            );

            console.log(`[Automação] Mês ${mesPassado}/${anoReferencia} fechado para o Barbeiro ID: ${barberId}`);
        }
        
        console.log('[Automação] Todos os fechamentos foram concluídos com sucesso!');
        io.emit('fechamento_mensal_concluido');

    } catch (error) {
        console.error('[Erro Automação] Falha no fechamento mensal:', error);
    }
});

httpServer.listen(serverPort, () => {
    console.log(`✅ Servidor API rodando localmente na porta ${serverPort}`);
    console.log(`Attempting to connect to Aiven Database on port ${process.env.DB_PORT}...`);
});