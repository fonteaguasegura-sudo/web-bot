const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const db = require('./database.js');
const puppeteer = require('puppeteer-core');
const chrome = require('chrome-aws-lambda');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- In-Memory State Management ---
const conversationStates = new Map();

// --- WhatsApp Client Initialization ---
let client;
let qrCodeDataUrl = null;
let clientReady = false;

const dataPath = path.join(__dirname, '.wwebjs_auth');

function initializeWhatsAppClient() {
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "bot-instance-1",
            dataPath: "./.wwebjs_auth"
        }),
        puppeteer: {
            headless: true,
            executablePath: puppeteer.executablePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--incognito',
                '--disable-web-security',
                '--disable-features=site-per-process',
                '--disable-site-isolation-trials',
                '--disable-blink-features=AutomationControlled'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1031490220-alpha.html',
        }
    });

    client.on('qr', (qr) => {
        console.log('QR RECEIVED', qr);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error('Error generating QR code', err);
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
        io.emit('log', `[MESSAGE] From: ${userNumber} | Body: ${msg.body}`);

        // Ensure user has a state object
        if (!conversationStates.has(userNumber)) {
            conversationStates.set(userNumber, { step: 'initial', agent_active: false });
        }
        let userState = conversationStates.get(userNumber);

        // Allow resetting the state for testing
        if (userMessage === '!reset') {
            conversationStates.delete(userNumber);
            await msg.reply('Sua sessão foi reiniciada.');
            io.emit('log', `[STATE] Reset state for ${userNumber}`);
            return;
        }

        // If agent is active, bot should not respond
        if (userState.agent_active) {
            io.emit('log', `[HANDOFF] Message from ${userNumber} forwarded to active agent session.`);
            return; // Stop bot logic
        }

        // Handoff to human agent
        if (userMessage.includes('atendente')) {
            userState.agent_active = true;
            await msg.reply('Ok, estou transferindo você para um de nossos atendentes. Por favor, aguarde um momento.');
            io.emit('log', `[HANDOFF] User ${userNumber} requested a human agent. Conversation is now paused for the bot.`);
            // In a real application, you would trigger a notification here (e.g., email, Slack, webhook to a CRM)
            console.log(`!! ALERT: User ${userNumber} needs a human agent!`);
            return;
        }

        // State Machine Logic
        switch (userState.step) {
            case 'initial':
                await msg.reply('Bem-vindo! \n O Furo de Água Segura é especialista em criar fontes de água potável e seguras. \n Para garantir a precisão da nossa cotação e a viabilidade do projeto, é essencial realizar uma pré-avaliação técnica no local. Assim, podemos analisar o terreno e as suas necessidades específicas.');
                await msg.reply('Por favor, escolha uma opção:\n1. Agendamento da visita\n2. Suporte\n3. Falar com Vendas\n\nDigite "atendente" a qualquer momento para falar com um humano.');
                userState.step = 'waiting_for_choice';
                break;

            case 'waiting_for_choice':
                if (userMessage.includes('1')) {
                    await msg.reply('Excelente! \n Para agendarmos, por favor, indique-nos a sua preferência de data e hora para a visita.');
                    userState.step = 'waiting_for_datetime';
                } else if (userMessage.includes('2')) {
                    await msg.reply('Você selecionou Suporte. Por favor, descreva seu problema.');
                    userState.step = 'support_flow';
                } else if (userMessage.includes('3')) {
                    await msg.reply('Você selecionou Falar com Vendas. Por favor, aguarde enquanto um de nossos especialistas de vendas entra em contato.');
                    userState.step = 'sales_flow';
                } else {
                    await msg.reply('Opção inválida. Por favor, digite 1 para Agendamento da visita, 2 para Suporte ou 3 para Falar com Vendas.');
                }
                break;
            
            case 'waiting_for_visit_confirmation':
                // This state is now handled by waiting_for_choice, but we keep it for reference
                if (userMessage.includes('sim')) {
                    await msg.reply('Excelente! Para agendarmos, por favor, indique-nos a sua preferência de data e hora para a visita.');
                    userState.step = 'waiting_for_datetime';
                } else if (userMessage.includes('não')) {
                    await msg.reply('Entendido. Se tiver mais alguma dúvida, pode nos perguntar. Ou, se preferir, pode falar com um de nossos atendentes digitando "atendente".');
                    userState.step = 'end';
                } else {
                    await msg.reply('Opção inválida. Por favor, responda com "Sim" para agendar a visita ou "Não" para mais informações.');
                }
                break;
            
            case 'waiting_for_datetime':
                userState.preferred_datetime = msg.body;
                await msg.reply('Obrigado. E, para finalizar, por favor, descreva o local ou a morada onde pretende que seja feito o furo de água.');
                userState.step = 'waiting_for_location';
                break;

            case 'waiting_for_location':
                userState.location = msg.body;
                
                db.get('SELECT * FROM appointments WHERE datetime = ?', [userState.preferred_datetime], async (err, row) => {
                    if (err) {
                        console.error('Database error', err.message);
                        await msg.reply('Ocorreu um erro ao verificar a agenda. Por favor, tente novamente mais tarde.');
                        userState.step = 'end';
                        return;
                    }
                    
                    if (row) {
                        await msg.reply('Desculpe, esse horário já foi agendado. Por favor, escolha outra data ou hora para a visita.');
                        userState.step = 'waiting_for_datetime';
                    } else {
                        db.run('INSERT INTO appointments (datetime, location) VALUES (?, ?)', [userState.preferred_datetime, userState.location], async (err) => {
                            if (err) {
                                console.error('Database error', err.message);
                                await msg.reply('Ocorreu um erro ao agendar a sua visita. Por favor, tente novamente mais tarde.');
                                userState.step = 'end';
                                return;
                            }
                            await msg.reply(`Recebido! Agendamos a sua pré-visita para ${userState.preferred_datetime} em ${userState.location}. Um de nossos técnicos entrará em contato para confirmar todos os detalhes. Obrigado!`);
                            userState.step = 'end';
                        });
                    }
                });
                break;
            
            case 'sales_flow':
                io.emit('log', `[SALES] User ${userNumber} is being transferred to sales. Conversation is now paused for the bot.`);
                console.log(`!! ALERT: User ${userNumber} needs a sales agent!`);
                await msg.reply('Obrigado pelo seu interesse! Um de nossos especialistas de vendas entrará em contato em breve. Para reiniciar, digite !reset.');
                userState.step = 'end';
                break;
            
            case 'support_flow':
                await msg.reply('Recebemos seu problema. Nosso time de suporte irá analisar e responder assim que possível. Para reiniciar, digite !reset.');
                userState.step = 'end';
                break;
            
            default:
                await msg.reply('Obrigado! Para começar de novo, digite !reset.');
                break;
        }
    });

    
    client.on('auth_failure', (msg) => {
        console.error('AUTHENTICATION FAILURE', msg);
        clientReady = false;
        io.emit('message', `Authentication failure: ${msg}. Attempting to re-initialize...`);
        client.destroy().then(() => initializeWhatsAppClient()).catch(err => console.error("Error destroying client:", err));
    });

    client.on('disconnected', (reason) => {
        console.log('Client was logged out', reason);
        clientReady = false;
        qrCodeDataUrl = null;
        io.emit('message', `Client was logged out: ${reason}. Re-initializing...`);
        client.destroy().then(() => initializeWhatsAppClient()).catch(err => console.error("Error destroying client:", err));
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


server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  initializeWhatsAppClient();
});