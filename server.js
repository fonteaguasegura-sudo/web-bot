const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const qrcode_terminal = require('qrcode-terminal');

const cachePath = path.join(__dirname, '.wwebjs_cache');

// Variável para armazenar o QR code
let currentQRCode = null;
let client; // Mover a definição do cliente para o escopo global

// Importar o resto do servidor
const fastify = require('fastify')({ logger: true });
const { Server } = require('socket.io');
const app = fastify;
const PORT = process.env.PORT || 3000;
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const db = require('./database.js');
const conversationStates = new Map();

// Servir o QR code como imagem
app.get('/qr', async (req, reply) => {
    const qrPath = path.join(__dirname, 'qrcode.png');
    
    if (fs.existsSync(qrPath)) {
        const image = fs.readFileSync(qrPath);
        reply.type('image/png').send(image);
    } else if (currentQRCode) {
        // Se o arquivo não existe mas temos o QR code, gerar na hora
        try {
            const qrBuffer = await qrcode.toBuffer(currentQRCode, {
                width: 500,
                margin: 2
            });
            reply.type('image/png').send(qrBuffer);
        } catch (err) {
            reply.code(404).send({ error: 'QR code não disponível' });
        }
    } else {
        reply.send({ 
            message: 'QR code não disponível. Cliente pode já estar autenticado.',
            authenticated: client && client.info ? true : false
        });
    }
});

// Status do cliente
app.get('/status', async (req, reply) => {
    const status = {
        ready: client && client.info ? true : false,
        hasQR: currentQRCode ? true : false,
        info: client && client.info ? client.info : null
    };
    reply.send(status);
});

// Servir página HTML simples para ver o QR code
app.get('/', async (req, reply) => {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp Bot - QR Code</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            text-align: center;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #25D366;
        }
        #qrcode {
            max-width: 100%;
            height: auto;
            margin: 20px 0;
        }
        .status {
            padding: 10px;
            margin: 10px 0;
            border-radius: 5px;
            font-weight: bold;
        }
        .ready { background: #d4edda; color: #155724; }
        .waiting { background: #fff3cd; color: #856404; }
        .error { background: #f8d7da; color: #721c24; }
        button {
            background: #25D366;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
            margin: 10px;
        }
        button:hover {
            background: #128C7E;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 WhatsApp Bot</h1>
        <div id="status" class="status waiting">Verificando status...</div>
        <div id="qr-container"></div>
        <button onclick="checkStatus()">🔄 Atualizar</button>
        <button onclick="location.reload()">🔃 Recarregar Página</button>
    </div>

    <script>
        async function checkStatus() {
            try {
                const response = await fetch('/status');
                const data = await response.json();
                const statusDiv = document.getElementById('status');
                const qrContainer = document.getElementById('qr-container');

                if (data.ready) {
                    statusDiv.className = 'status ready';
                    statusDiv.textContent = '✅ Bot conectado e pronto!';
                    qrContainer.innerHTML = '<p>Seu bot já está autenticado e funcionando.</p>';
                } else if (data.hasQR) {
                    statusDiv.className = 'status waiting';
                    statusDiv.textContent = '📱 Escaneie o QR code abaixo com seu WhatsApp';
                    qrContainer.innerHTML = '<img id="qrcode" src="/qr?t=' + Date.now() + '" alt="QR Code">';
                } else {
                    statusDiv.className = 'status waiting';
                    statusDiv.textContent = '⏳ Aguardando QR code...';
                    qrContainer.innerHTML = '<p>O QR code está sendo gerado...</p>';
                }
            } catch (err) {
                const statusDiv = document.getElementById('status');
                statusDiv.className = 'status error';
                statusDiv.textContent = '❌ Erro ao verificar status';
                console.error(err);
            }
        }

        // Verificar status a cada 3 segundos
        setInterval(checkStatus, 3000);
        checkStatus();
    </script>
</body>
</html>
    `;
    reply.type('text/html').send(html);
});

// Socket.io
const io = new Server(app.server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('Cliente Socket.IO conectado');
    
    // Enviar QR code para o cliente
    if (currentQRCode) {
        socket.emit('qr', currentQRCode);
    }
    
    socket.on('disconnect', () => {
        console.log('Cliente Socket.IO desconectado');
    });
});

// Function to initialize WhatsApp Client
const initializeWhatsAppClient = async () => {
    // Ensure the cache directory exists
    if (!fs.existsSync(cachePath)) {
        fs.mkdirSync(cachePath, { recursive: true });
    }
    
    // Inicializar o cliente do WhatsApp aqui
    const executablePath = await chromium.executablePath();
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "bot-instance-1",
            dataPath: "/tmp/.wwebjs_auth"
        }),
        puppeteer: {
            headless: chromium.headless,
            executablePath,
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        },
        webVersionCache: {
            type: 'local',
            path: cachePath,
        }
    });

    // Quando o QR code é gerado
    client.on('qr', async (qr) => {
        console.log('QR Code recebido!');
        currentQRCode = qr;
        io.emit('qr', qr); // Emit para a página web
        
        // Salvar QR code como imagem PNG
        const qrPath = path.join(__dirname, 'qrcode.png');
        try {
            await qrcode.toFile(qrPath, qr, {
                width: 500,
                margin: 2
            });
            console.log('✅ QR Code salvo em:', qrPath);
            
            // Gerar QR code no terminal
            qrcode_terminal.generate(qr, { small: true });
            
        } catch (err) {
            console.error('Erro ao gerar QR code:', err);
        }
    });

    // Quando o cliente está pronto
    client.on('ready', () => {
        console.log('✅ Cliente WhatsApp está pronto!');
        currentQRCode = null;
        io.emit('ready'); // Emit para a página web
         // Limpa o arquivo qrcode.png após a conexão
        const qrPath = path.join(__dirname, 'qrcode.png');
        if (fs.existsSync(qrPath)) {
            fs.unlinkSync(qrPath);
        }
    });

    // Eventos de autenticação e desconexão
    client.on('authenticated', () => {
        console.log('✅ Autenticado com sucesso!');
    });
    client.on('auth_failure', (msg) => {
        console.error('❌ Falha na autenticação:', msg);
    });
    client.on('disconnected', (reason) => {
        console.log('⚠️ Cliente desconectado:', reason);
        currentQRCode = null; // Limpa o QR code ao desconectar
        // Tenta reconectar ou limpar
        client.destroy();
        initializeWhatsAppClient(); // Reinicia o cliente
    });

    // Handler de mensagens (mantido do seu código original)
    client.on('message', async (msg) => {
        const userNumber = msg.from;
        const userMessage = msg.body.toLowerCase();
        console.log(`[MESSAGE] From: ${userNumber} | Body: ${msg.body}`);
        io.emit('log', `[MESSAGE] From: ${userNumber} | Body: ${msg.body}`);

        // Ensure user has a state object
        if (!conversationStates.has(userNumber)) {
            console.log(`[STATE] Initializing state for ${userNumber}`);
            conversationStates.set(userNumber, { step: 'initial', agent_active: false });
        }
        let userState = conversationStates.get(userNumber);
        console.log(`[STATE] Current state for ${userNumber}:`, userState);


        // Allow resetting the state for testing
        if (userMessage === '!reset') {
            console.log(`[STATE] Resetting state for ${userNumber}`);
            conversationStates.delete(userNumber);
            try {
                await msg.reply('Sua sessão foi reiniciada.');
                console.log(`[REPLY] Sent state reset confirmation to ${userNumber}`);
            } catch (error) {
                console.error(`[REPLY-ERROR] Failed to send state reset confirmation to ${userNumber}:`, error);
            }
            io.emit('log', `[STATE] Reset state for ${userNumber}`);
            return;
        }

        // If agent is active, bot should not respond
        if (userState.agent_active) {
            console.log(`[HANDOFF] Message from ${userNumber} forwarded to active agent session.`);
            io.emit('log', `[HANDOFF] Message from ${userNumber} forwarded to active agent session.`);
            return; // Stop bot logic
        }

        // Handoff to human agent
        if (userMessage.includes('atendente')) {
            console.log(`[HANDOFF] User ${userNumber} requested a human agent.`);
            userState.agent_active = true;
            try {
                await msg.reply('Ok, estou transferindo você para um de nossos atendentes. Por favor, aguarde um momento.');
                console.log(`[REPLY] Sent handoff confirmation to ${userNumber}`);
            } catch (error) {
                console.error(`[REPLY-ERROR] Failed to send handoff confirmation to ${userNumber}:`, error);
            }
            io.emit('log', `[HANDOFF] User ${userNumber} requested a human agent. Conversation is now paused for the bot.`);
            console.log(`!! ALERT: User ${userNumber} needs a human agent!`);
            return;
        }

        // State Machine Logic
        console.log(`[STATE-MACHINE] Processing step: ${userState.step}`);
        switch (userState.step) {
            case 'initial':
                console.log(`[FLOW] Start of 'initial' step for ${userNumber}`);
                try {
                    await msg.reply('Bem-vindo! \n O Furo de Água Segura é especialista em criar fontes de água potável e seguras. \n Para garantir a precisão da nossa cotação e a viabilidade do projeto, é essencial realizar uma pré-avaliação técnica no local. Assim, podemos analisar o terreno e as suas necessidades específicas.');
                    console.log(`[REPLY] Sent welcome message part 1 to ${userNumber}`);
                    await msg.reply('Por favor, escolha uma opção:\n1. Agendamento da visita\n2. Suporte\n3. Falar com Vendas\n\nDigite "atendente" a qualquer momento para falar com um humano.');
                    console.log(`[REPLY] Sent welcome message part 2 to ${userNumber}`);
                    userState.step = 'waiting_for_choice';
                    console.log(`[STATE] New state for ${userNumber}: waiting_for_choice`);
                } catch (error) {
                    console.error(`[REPLY-ERROR] Failed to send initial messages to ${userNumber}:`, error);
                }
                break;

            case 'waiting_for_choice':
                 console.log(`[FLOW] Start of 'waiting_for_choice' step for ${userNumber}`);
                if (userMessage.includes('1')) {
                    try {
                        await msg.reply('Excelente! \n Para agendarmos, por favor, indique-nos a sua preferência de data e hora para a visita.');
                        console.log(`[REPLY] Sent scheduling prompt to ${userNumber}`);
                        userState.step = 'waiting_for_datetime';
                        console.log(`[STATE] New state for ${userNumber}: waiting_for_datetime`);
                    } catch (error) {
                        console.error(`[REPLY-ERROR] Failed to send scheduling prompt to ${userNumber}:`, error);
                    }
                } else if (userMessage.includes('2')) {
                    try {
                        await msg.reply('Você selecionou Suporte. Por favor, descreva seu problema.');
                        console.log(`[REPLY] Sent support prompt to ${userNumber}`);
                        userState.step = 'support_flow';
                        console.log(`[STATE] New state for ${userNumber}: support_flow`);
                    } catch (error) {
                        console.error(`[REPLY-ERROR] Failed to send support prompt to ${userNumber}:`, error);
                    }
                } else if (userMessage.includes('3')) {
                    try {
                        await msg.reply('Você selecionou Falar com Vendas. Por favor, aguarde enquanto um de nossos especialistas de vendas entra em contato.');
                        console.log(`[REPLY] Sent sales prompt to ${userNumber}`);
                        userState.step = 'sales_flow';
                        console.log(`[STATE] New state for ${userNumber}: sales_flow`);
                    } catch (error) {
                        console.error(`[REPLY-ERROR] Failed to send sales prompt to ${userNumber}:`, error);
                    }
                } else {
                    try {
                        await msg.reply('Opção inválida. Por favor, digite 1 para Agendamento da visita, 2 para Suporte ou 3 para Falar com Vendas.');
                        console.log(`[REPLY] Sent invalid option message to ${userNumber}`);
                    } catch (error) {
                        console.error(`[REPLY-ERROR] Failed to send invalid option message to ${userNumber}:`, error);
                    }
                }
                break;
            
            case 'waiting_for_visit_confirmation':
                console.log(`[FLOW] Start of 'waiting_for_visit_confirmation' step for ${userNumber}`);
                if (userMessage.includes('sim')) {
                    try {
                        await msg.reply('Excelente! Para agendarmos, por favor, indique-nos a sua preferência de data e hora para a visita.');
                        console.log(`[REPLY] Sent scheduling prompt after confirmation to ${userNumber}`);
                        userState.step = 'waiting_for_datetime';
                        console.log(`[STATE] New state for ${userNumber}: waiting_for_datetime`);
                    } catch (error) {
                        console.error(`[REPLY-ERROR] Failed to send scheduling prompt to ${userNumber}:`, error);
                    }
                } else if (userMessage.includes('não')) {
                    try {
                        await msg.reply('Entendido. Se tiver mais alguma dúvida, pode nos perguntar. Ou, se preferir, pode falar com um de nossos atendentes digitando "atendente".');
                        console.log(`[REPLY] Sent "no" confirmation response to ${userNumber}`);
                        userState.step = 'end';
                        console.log(`[STATE] New state for ${userNumber}: end`);
                    } catch (error) {
                        console.error(`[REPLY-ERROR] Failed to send "no" confirmation response to ${userNumber}:`, error);
                    }
                } else {
                    try {
                        await msg.reply('Opção inválida. Por favor, responda com "Sim" para agendar a visita ou "Não" para mais informações.');
                        console.log(`[REPLY] Sent invalid option for confirmation to ${userNumber}`);
                    } catch (error) {
                        console.error(`[REPLY-ERROR] Failed to send invalid option for confirmation to ${userNumber}:`, error);
                    }
                }
                break;
            
            case 'waiting_for_datetime':
                console.log(`[FLOW] Start of 'waiting_for_datetime' step for ${userNumber}`);
                userState.preferred_datetime = msg.body;
                try {
                    await msg.reply('Obrigado. E, para finalizar, por favor, descreva o local ou a morada onde pretende que seja feito o furo de água.');
                    console.log(`[REPLY] Sent location prompt to ${userNumber}`);
                    userState.step = 'waiting_for_location';
                    console.log(`[STATE] New state for ${userNumber}: waiting_for_location`);
                } catch (error) {
                    console.error(`[REPLY-ERROR] Failed to send location prompt to ${userNumber}:`, error);
                }
                break;

            case 'waiting_for_location':
                console.log(`[FLOW] Start of 'waiting_for_location' step for ${userNumber}`);
                userState.location = msg.body;
                
                db.get('SELECT * FROM appointments WHERE datetime = ?', [userState.preferred_datetime], async (err, row) => {
                    if (err) {
                        console.error('Database error', err.message);
                        try {
                            await msg.reply('Ocorreu um erro ao verificar a agenda. Por favor, tente novamente mais tarde.');
                            console.log(`[REPLY] Sent database error message to ${userNumber}`);
                        } catch (replyError) {
                            console.error(`[REPLY-ERROR] Failed to send database error message to ${userNumber}:`, replyError);
                        }
                        userState.step = 'end';
                        console.log(`[STATE] New state for ${userNumber}: end`);
                        return;
                    }
                    
                    if (row) {
                        try {
                            await msg.reply('Desculpe, esse horário já foi agendado. Por favor, escolha outra data ou hora para a visita.');
                            console.log(`[REPLY] Sent slot taken message to ${userNumber}`);
                            userState.step = 'waiting_for_datetime';
                            console.log(`[STATE] New state for ${userNumber}: waiting_for_datetime`);
                        } catch (error) {
                             console.error(`[REPLY-ERROR] Failed to send slot taken message to ${userNumber}:`, error);
                        }
                    } else {
                        db.run('INSERT INTO appointments (datetime, location) VALUES (?, ?)', [userState.preferred_datetime, userState.location], async (err) => {
                            if (err) {
                                console.error('Database error', err.message);
                                try {
                                    await msg.reply('Ocorreu um erro ao agendar a sua visita. Por favor, tente novamente mais tarde.');
                                     console.log(`[REPLY] Sent appointment creation error to ${userNumber}`);
                                } catch (replyError) {
                                    console.error(`[REPLY-ERROR] Failed to send appointment creation error to ${userNumber}:`, replyError);
                                }
                                userState.step = 'end';
                                console.log(`[STATE] New state for ${userNumber}: end`);
                                return;
                            }
                            try {
                                await msg.reply(`Recebido! Agendamos a sua pré-visita para ${userState.preferred_datetime} em ${userState.location}. Um de nossos técnicos entrará em contato para confirmar todos os detalhes. Obrigado!`);
                                console.log(`[REPLY] Sent appointment confirmation to ${userNumber}`);
                                userState.step = 'end';
                                console.log(`[STATE] New state for ${userNumber}: end`);
                            } catch (error) {
                                console.error(`[REPLY-ERROR] Failed to send appointment confirmation to ${userNumber}:`, error);
                            }
                        });
                    }
                });
                break;
            
            case 'sales_flow':
                console.log(`[FLOW] Start of 'sales_flow' step for ${userNumber}`);
                io.emit('log', `[SALES] User ${userNumber} is being transferred to sales. Conversation is now paused for the bot.`);
                console.log(`!! ALERT: User ${userNumber} needs a human agent!`);
                try {
                    await msg.reply('Obrigado pelo seu interesse! Um de nossos especialistas de vendas entrará em contato em breve. Para reiniciar, digite !reset.');
                    console.log(`[REPLY] Sent sales handoff message to ${userNumber}`);
                    userState.step = 'end';
                    console.log(`[STATE] New state for ${userNumber}: end`);
                } catch (error) {
                    console.error(`[REPLY-ERROR] Failed to send sales handoff message to ${userNumber}:`, error);
                }
                break;
            
            case 'support_flow':
                console.log(`[FLOW] Start of 'support_flow' step for ${userNumber}`);
                try {
                    await msg.reply('Recebemos seu problema. Nosso time de suporte irá analisar e responder assim que possível. Para reiniciar, digite !reset.');
                    console.log(`[REPLY] Sent support message to ${userNumber}`);
                    userState.step = 'end';
                    console.log(`[STATE] New state for ${userNumber}: end`);
                } catch (error) {
                    console.error(`[REPLY-ERROR] Failed to send support message to ${userNumber}:`, error);
                }
                break;
            
            default:
                console.log(`[FLOW] Start of 'default' step for ${userNumber}`);
                try {
                    await msg.reply('Obrigado! Para começar de novo, digite !reset.');
                    console.log(`[REPLY] Sent default message to ${userNumber}`);
                } catch (error) {
                    console.error(`[REPLY-ERROR] Failed to send default message to ${userNumber}:`, error);
                }
                break;
        }
    });


    console.log('🚀 Iniciando cliente WhatsApp...');
    try { // Add try-catch block here
        client.initialize();
    } catch (error) {
        console.error('❌ Erro ao inicializar o cliente WhatsApp:', error);
        // Implement a delay before re-initialization to prevent rapid looping
        setTimeout(() => initializeWhatsAppClient(), 5000); 
    }
};

// Iniciar servidor e cliente WhatsApp
const start = async () => {
    try {
        await app.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`🚀 Servidor rodando na porta ${PORT}`);
        console.log(`📱 Acesse http://localhost:${PORT} para ver o QR code`);
        
        initializeWhatsAppClient(); // Call the new initialization function

    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();