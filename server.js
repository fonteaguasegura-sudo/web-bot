const fastify = require('fastify')({ logger: true });
const path = require('path');
const fs = require('fs');
const { Server } = require("socket.io");
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcode_terminal = require('qrcode-terminal');
const db = require('./database.js');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const PORT = process.env.PORT || 3000;

// Create a Fastify app
const app = fastify;


// Add explicit route handlers for static files
app.get('/', async (req, reply) => {
    try {
        const indexPath = path.join(__dirname, 'index.html');
        const html = fs.readFileSync(indexPath, 'utf8');
        reply.type('text/html').send(html);
    } catch (error) {
        app.log.error('Error serving index.html:', error);
        reply.code(500).send({ error: 'Failed to load page' });
    }
});

app.get('/style.css', async (req, reply) => {
    try {
        const cssPath = path.join(__dirname, 'style.css');
        const css = fs.readFileSync(cssPath, 'utf8');
        reply.type('text/css').send(css);
    } catch (error) {
        app.log.error('Error serving style.css:', error);
        reply.code(404).send({ error: 'Not found' });
    }
});

app.get('/script.js', async (req, reply) => {
    try {
        const jsPath = path.join(__dirname, 'script.js');
        const js = fs.readFileSync(jsPath, 'utf8');
        reply.type('application/javascript').send(js);
    } catch (error) {
        app.log.error('Error serving script.js:', error);
        reply.code(404).send({ error: 'Not found' });
    }
});



// Attach socket.io
const io = new Server(app.server);

// --- In-Memory State Management ---
const conversationStates = new Map();

// --- WhatsApp Client Initialization ---
let client;
let qrCodeDataUrl = null;
let clientReady = false;

const dataPath = path.join(__dirname, '.wwebjs_auth');

async function initializeWhatsAppClient() {
    const executablePath = await chromium.executablePath();

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "bot-instance-1",
            dataPath: "/tmp/.wwebjs_auth"
        }),
        puppeteer: {
            headless: chromium.headless,
            executablePath,
            args: chromium.args
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1031490220-alpha.html',
        }
    });

    client.on('qr', (qr) => {
        console.log('QR code received, scan the code below with your phone.');
        qrcode_terminal.generate(qr, { small: true });
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error('Error generating QR code for web UI', err);
                io.emit('message', 'Error generating QR code.');
            } else {
                qrCodeDataUrl = url; // Store QR code
                io.emit('qr', url);
                io.emit('message', 'QR Code received, please scan.');
            }
        });
    });

    client.on('ready', () => {
        console.log('Client is ready!');
        clientReady = true; // Set client status
        qrCodeDataUrl = null; // Clear QR code
        io.emit('ready');
        io.emit('message', 'WhatsApp client is ready and connected!');
    });

    // --- New Message Handling Logic ---
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
                console.log(`!! ALERT: User ${userNumber} needs a sales agent!`);
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

    
    client.on('auth_failure', (msg) => {
        console.error('--- AUTHENTICATION FAILURE ---', msg);
        clientReady = false;
        io.emit('message', `Authentication failure: ${msg}.`);
        io.emit('log', `[ERROR] Authentication failure: ${msg}.`);
        console.log('Attempting to destroy and re-initialize client...');
        client.destroy().then(() => {
            console.log('Client destroyed. Re-initializing...');
            initializeWhatsAppClient();
        }).catch(err => {
            console.error("Error destroying client after auth failure:", err);
            io.emit('log', `[ERROR] Could not destroy client after auth failure: ${err.message}`);
        });
    });

    client.on('disconnected', (reason) => {
        console.log('--- CLIENT DISCONNECTED ---', reason);
        clientReady = false;
        qrCodeDataUrl = null;
        io.emit('message', `Client was logged out: ${reason}.`);
        io.emit('log', `[WARNING] Client was logged out: ${reason}.`);
        console.log('Attempting to destroy and re-initialize client...');
        client.destroy().then(() => {
            console.log('Client destroyed. Re-initializing...');
            initializeWhatsAppClient();
        }).catch(err => {
            console.error("Error destroying client after disconnection:", err);
            io.emit('log', `[ERROR] Could not destroy client after disconnection: ${err.message}`);
        });
    });

    client.initialize().catch(err => {
        console.error("Client initialization error:", err);
        io.emit('message', `WhatsApp client initialization failed: ${err.message}.`);
    });
}
// --- End WhatsApp Client Initialization ---


io.on('connection', (socket) => {
  console.log('A user connected to Socket.IO');
  socket.emit('message', 'Welcome! Getting WhatsApp status...');

  if (clientReady) {
      socket.emit('ready');
      socket.emit('message', 'WhatsApp client is already connected!');
  } else if (qrCodeDataUrl) {
      socket.emit('qr', qrCodeDataUrl);
      socket.emit('message', 'QR Code available, please scan.');
  } else {
      socket.emit('message', 'WhatsApp client is initializing...');
  }

  socket.on('disconnect', () => {
    console.log('User disconnected from Socket.IO');
  });
});


app.listen({ port: PORT, host: '0.0.0.0' }, async (err, address) => {
    if (err) {
      app.log.error(err)
      process.exit(1)
    }
    console.log(`Server is running on port ${PORT}`);
    await initializeWhatsAppClient();
});