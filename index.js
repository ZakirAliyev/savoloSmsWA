import cors from 'cors';
import makeWASocket, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import Database from 'better-sqlite3';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { randomInt } from 'node:crypto';

const AUTH_FOLDER = 'auth_info_baileys';
const DB_FILE = 'messages.db';

const API_HOST = '0.0.0.0';
const API_PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || 'savolo-secret-key';

const RETRY_INTERVAL_SECONDS = 10;
const WORKER_INTERVAL_SECONDS = 5;
const MAX_ATTEMPTS = 50;
const BATCH_SIZE = 10;

let currentSock = null;
let isConnected = false;
let queueWorkerStarted = false;
let serverStarted = false;
let queueWorkerInterval = null;
let isProcessingQueue = false;

const db = new Database(DB_FILE);

function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS outgoing_messages (
                                                         id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                         phone TEXT NOT NULL,
                                                         jid TEXT NOT NULL,
                                                         message_text TEXT NOT NULL,
                                                         otp_code TEXT NULL,
                                                         is_sent INTEGER NOT NULL DEFAULT 0,
                                                         attempt_count INTEGER NOT NULL DEFAULT 0,
                                                         last_error TEXT NULL,
                                                         created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            sent_at TEXT NULL,
            next_retry_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

        CREATE INDEX IF NOT EXISTS idx_outgoing_messages_is_sent_next_retry_at
            ON outgoing_messages(is_sent, next_retry_at);
    `);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowSql() {
    return new Date().toISOString();
}

function addSecondsToNowSql(seconds) {
    return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizePhone(input) {
    let digits = String(input || '').replace(/\D/g, '');

    if (!digits) {
        return '';
    }

    if (digits.startsWith('0')) {
        digits = `994${digits.slice(1)}`;
    }

    if (digits.startsWith('9940')) {
        digits = `994${digits.slice(4)}`;
    }

    return digits;
}

function normalizePhoneOrJid(input) {
    const value = String(input || '').trim();

    if (!value) {
        return '';
    }

    if (value.endsWith('@s.whatsapp.net')) {
        const phonePart = value.replace('@s.whatsapp.net', '').replace(/\D/g, '');
        const normalizedPhone = normalizePhone(phonePart);
        return normalizedPhone ? `${normalizedPhone}@s.whatsapp.net` : '';
    }

    const normalizedPhone = normalizePhone(value);
    return normalizedPhone ? `${normalizedPhone}@s.whatsapp.net` : '';
}

function isValidNormalizedJid(jid) {
    if (!jid || !jid.endsWith('@s.whatsapp.net')) {
        return false;
    }

    const phone = jid.replace('@s.whatsapp.net', '');
    return /^\d{10,15}$/.test(phone);
}

function getMessageText(message) {
    if (!message) return '';

    if (message.conversation) {
        return message.conversation;
    }

    if (message.extendedTextMessage?.text) {
        return message.extendedTextMessage.text;
    }

    if (message.imageMessage?.caption) {
        return message.imageMessage.caption;
    }

    if (message.videoMessage?.caption) {
        return message.videoMessage.caption;
    }

    if (message.documentMessage?.caption) {
        return message.documentMessage.caption;
    }

    if (message.buttonsResponseMessage?.selectedButtonId) {
        return message.buttonsResponseMessage.selectedButtonId;
    }

    if (message.listResponseMessage?.title) {
        return message.listResponseMessage.title;
    }

    if (message.templateButtonReplyMessage?.selectedId) {
        return message.templateButtonReplyMessage.selectedId;
    }

    if (message.ephemeralMessage?.message) {
        return getMessageText(message.ephemeralMessage.message);
    }

    if (message.viewOnceMessage?.message) {
        return getMessageText(message.viewOnceMessage.message);
    }

    if (message.viewOnceMessageV2?.message) {
        return getMessageText(message.viewOnceMessageV2.message);
    }

    return '';
}

function generateOtpCode() {
    return String(randomInt(100000, 1000000));
}

function buildOtpMessage(otpCode) {
    return `Your Savolo verification code is ${otpCode}.`;
}

function insertQueuedOtpMessage(phoneInput) {
    const jid = normalizePhoneOrJid(phoneInput);

    if (!jid || !isValidNormalizedJid(jid)) {
        throw new Error('Phone number or jid is not valid');
    }

    const phone = jid.replace('@s.whatsapp.net', '');
    const otpCode = generateOtpCode();
    const messageText = buildOtpMessage(otpCode);
    const now = nowSql();

    const stmt = db.prepare(`
        INSERT INTO outgoing_messages (
            phone,
            jid,
            message_text,
            otp_code,
            is_sent,
            attempt_count,
            last_error,
            created_at,
            updated_at,
            sent_at,
            next_retry_at
        )
        VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?, NULL, ?)
    `);

    const result = stmt.run(
        phone,
        jid,
        messageText,
        otpCode,
        now,
        now,
        now
    );

    return {
        id: Number(result.lastInsertRowid),
        phone,
        jid,
        otpCode,
        messageText
    };
}

function getPendingMessages(limit = BATCH_SIZE) {
    const stmt = db.prepare(`
        SELECT
            id,
            phone,
            jid,
            message_text,
            otp_code,
            is_sent,
            attempt_count,
            last_error,
            created_at,
            updated_at,
            sent_at,
            next_retry_at
        FROM outgoing_messages
        WHERE is_sent = 0
          AND attempt_count < ?
          AND datetime(next_retry_at) <= datetime('now')
        ORDER BY id ASC
            LIMIT ?
    `);

    return stmt.all(MAX_ATTEMPTS, limit);
}

function markMessageSent(id) {
    const stmt = db.prepare(`
        UPDATE outgoing_messages
        SET
            is_sent = 1,
            updated_at = ?,
            sent_at = ?,
            last_error = NULL
        WHERE id = ?
    `);

    const now = nowSql();
    stmt.run(now, now, id);
}

function markMessageFailed(id, errorMessage, retrySeconds) {
    const stmt = db.prepare(`
        UPDATE outgoing_messages
        SET
            is_sent = 0,
            attempt_count = attempt_count + 1,
            last_error = ?,
            updated_at = ?,
            next_retry_at = ?
        WHERE id = ?
    `);

    stmt.run(
        String(errorMessage || 'Unknown error'),
        nowSql(),
        addSecondsToNowSql(retrySeconds),
        id
    );
}

function listRecentMessages(limit = 50) {
    const stmt = db.prepare(`
        SELECT
            id,
            phone,
            jid,
            message_text,
            otp_code,
            is_sent,
            attempt_count,
            last_error,
            created_at,
            updated_at,
            sent_at,
            next_retry_at
        FROM outgoing_messages
        ORDER BY id DESC
            LIMIT ?
    `);

    return stmt.all(limit);
}

function getMessageById(id) {
    const stmt = db.prepare(`
        SELECT
            id,
            phone,
            jid,
            message_text,
            otp_code,
            is_sent,
            attempt_count,
            last_error,
            created_at,
            updated_at,
            sent_at,
            next_retry_at
        FROM outgoing_messages
        WHERE id = ?
            LIMIT 1
    `);

    return stmt.get(id);
}

function mapMessageRow(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,
        phone: row.phone,
        jid: row.jid,
        messageText: row.message_text,
        otpCode: row.otp_code,
        isSent: Boolean(row.is_sent),
        attemptCount: row.attempt_count,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sentAt: row.sent_at,
        nextRetryAt: row.next_retry_at
    };
}

function apiKeyMiddleware(req, res, next) {
    const providedApiKey = req.header('x-api-key');

    if (!providedApiKey || providedApiKey !== API_KEY) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized'
        });
    }

    next();
}

async function waitUntilConnected(maxWaitMs = 15000) {
    const startedAt = Date.now();

    while (!isConnected || !currentSock?.user) {
        if (Date.now() - startedAt > maxWaitMs) {
            throw new Error('Socket is not connected');
        }

        await sleep(500);
    }
}

async function processPendingMessages() {
    if (isProcessingQueue) {
        return;
    }

    isProcessingQueue = true;

    try {
        const pendingMessages = getPendingMessages(BATCH_SIZE);

        if (pendingMessages.length === 0) {
            return;
        }

        for (const item of pendingMessages) {
            try {
                await waitUntilConnected();
                await currentSock.sendMessage(item.jid, { text: item.message_text });
                markMessageSent(item.id);
                console.log(`[SENT] id=${item.id} -> ${item.jid}`);
            } catch (error) {
                const errorMessage = error?.message || 'Unknown error';
                markMessageFailed(item.id, errorMessage, RETRY_INTERVAL_SECONDS);
                console.log(`[FAILED] id=${item.id} -> ${item.jid} -> ${errorMessage}`);
            }

            await sleep(1000);
        }
    } finally {
        isProcessingQueue = false;
    }
}

function startQueueWorker() {
    if (queueWorkerStarted) {
        return;
    }

    queueWorkerStarted = true;

    queueWorkerInterval = setInterval(async () => {
        try {
            await processPendingMessages();
        } catch (error) {
            console.error('Queue worker error:', error?.message || error);
        }
    }, WORKER_INTERVAL_SECONDS * 1000);
}

function buildSwaggerSpec(req) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = forwardedProto ? String(forwardedProto).split(',')[0] : req.protocol;
    const host = req.get('host');
    const serverUrl = `${protocol}://${host}`;

    return {
        openapi: '3.0.0',
        info: {
            title: 'Savolo WhatsApp OTP API',
            version: '1.0.0',
            description: 'WhatsApp OTP sending API with SQLite queue and Baileys'
        },
        servers: [
            {
                url: serverUrl
            }
        ],
        components: {
            securitySchemes: {
                ApiKeyAuth: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-api-key'
                }
            },
            schemas: {
                HealthResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: true },
                        whatsappConnected: { type: 'boolean', example: true },
                        hasActiveSocket: { type: 'boolean', example: true },
                        workerIntervalSeconds: { type: 'integer', example: 5 },
                        retryIntervalSeconds: { type: 'integer', example: 10 }
                    }
                },
                SendOtpRequest: {
                    type: 'object',
                    required: ['phone'],
                    properties: {
                        phone: {
                            type: 'string',
                            example: '0772281148'
                        }
                    }
                },
                SendOtpResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: true },
                        message: { type: 'string', example: 'OTP queued successfully' },
                        data: {
                            type: 'object',
                            properties: {
                                id: { type: 'integer', example: 1 },
                                phone: { type: 'string', example: '994772281148' },
                                jid: { type: 'string', example: '994772281148@s.whatsapp.net' },
                                otpCode: { type: 'string', example: '482193' },
                                text: {
                                    type: 'string',
                                    example: 'Your Savolo verification code is 482193.'
                                },
                                isSent: { type: 'boolean', example: false }
                            }
                        }
                    }
                },
                MessageRow: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer', example: 1 },
                        phone: { type: 'string', example: '994772281148' },
                        jid: { type: 'string', example: '994772281148@s.whatsapp.net' },
                        messageText: {
                            type: 'string',
                            example: 'Your Savolo verification code is 482193.'
                        },
                        otpCode: { type: 'string', example: '482193' },
                        isSent: { type: 'boolean', example: true },
                        attemptCount: { type: 'integer', example: 0 },
                        lastError: { type: 'string', nullable: true, example: null },
                        createdAt: { type: 'string', example: '2026-03-12T08:10:00.000Z' },
                        updatedAt: { type: 'string', example: '2026-03-12T08:10:05.000Z' },
                        sentAt: { type: 'string', nullable: true, example: '2026-03-12T08:10:05.000Z' },
                        nextRetryAt: { type: 'string', example: '2026-03-12T08:10:00.000Z' }
                    }
                },
                ErrorResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: false },
                        message: { type: 'string', example: 'Unauthorized' }
                    }
                }
            }
        },
        paths: {
            '/health': {
                get: {
                    summary: 'Health check',
                    tags: ['System'],
                    responses: {
                        200: {
                            description: 'Health info',
                            content: {
                                'application/json': {
                                    schema: {
                                        $ref: '#/components/schemas/HealthResponse'
                                    }
                                }
                            }
                        }
                    }
                }
            },
            '/send-otp': {
                post: {
                    summary: 'Queue OTP message',
                    tags: ['OTP'],
                    security: [{ ApiKeyAuth: [] }],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: '#/components/schemas/SendOtpRequest'
                                }
                            }
                        }
                    },
                    responses: {
                        201: {
                            description: 'OTP queued',
                            content: {
                                'application/json': {
                                    schema: {
                                        $ref: '#/components/schemas/SendOtpResponse'
                                    }
                                }
                            }
                        },
                        400: {
                            description: 'Bad request',
                            content: {
                                'application/json': {
                                    schema: {
                                        $ref: '#/components/schemas/ErrorResponse'
                                    }
                                }
                            }
                        },
                        401: {
                            description: 'Unauthorized',
                            content: {
                                'application/json': {
                                    schema: {
                                        $ref: '#/components/schemas/ErrorResponse'
                                    }
                                }
                            }
                        }
                    }
                }
            },
            '/messages': {
                get: {
                    summary: 'Get recent messages',
                    tags: ['Messages'],
                    security: [{ ApiKeyAuth: [] }],
                    responses: {
                        200: {
                            description: 'Recent messages',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            success: { type: 'boolean', example: true },
                                            data: {
                                                type: 'array',
                                                items: {
                                                    $ref: '#/components/schemas/MessageRow'
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        401: {
                            description: 'Unauthorized',
                            content: {
                                'application/json': {
                                    schema: {
                                        $ref: '#/components/schemas/ErrorResponse'
                                    }
                                }
                            }
                        }
                    }
                }
            },
            '/messages/{id}': {
                get: {
                    summary: 'Get message by id',
                    tags: ['Messages'],
                    security: [{ ApiKeyAuth: [] }],
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: {
                                type: 'integer',
                                example: 1
                            }
                        }
                    ],
                    responses: {
                        200: {
                            description: 'Message found',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            success: { type: 'boolean', example: true },
                                            data: {
                                                $ref: '#/components/schemas/MessageRow'
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        400: {
                            description: 'Bad request',
                            content: {
                                'application/json': {
                                    schema: {
                                        $ref: '#/components/schemas/ErrorResponse'
                                    }
                                }
                            }
                        },
                        401: {
                            description: 'Unauthorized',
                            content: {
                                'application/json': {
                                    schema: {
                                        $ref: '#/components/schemas/ErrorResponse'
                                    }
                                }
                            }
                        },
                        404: {
                            description: 'Not found',
                            content: {
                                'application/json': {
                                    schema: {
                                        $ref: '#/components/schemas/ErrorResponse'
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };
}

function startApiServer() {
    if (serverStarted) {
        return;
    }

    serverStarted = true;

    const app = express();

    app.set('trust proxy', 1);

    app.use(express.json());

    app.use(cors({
        origin: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
    }));

    app.options(/.*/, cors());

    app.use('/docs', swaggerUi.serve, (req, res, next) => {
        const swaggerSpec = buildSwaggerSpec(req);
        return swaggerUi.setup(swaggerSpec, {
            explorer: true
        })(req, res, next);
    });

    app.get('/swagger.json', (req, res) => {
        res.json(buildSwaggerSpec(req));
    });

    app.get('/health', (req, res) => {
        res.json({
            success: true,
            whatsappConnected: isConnected,
            hasActiveSocket: Boolean(currentSock?.user),
            workerIntervalSeconds: WORKER_INTERVAL_SECONDS,
            retryIntervalSeconds: RETRY_INTERVAL_SECONDS
        });
    });

    app.post('/send-otp', apiKeyMiddleware, (req, res) => {
        try {
            const { phone } = req.body ?? {};

            if (!phone || !String(phone).trim()) {
                return res.status(400).json({
                    success: false,
                    message: 'phone is required'
                });
            }

            const queued = insertQueuedOtpMessage(phone);

            return res.status(201).json({
                success: true,
                message: 'OTP queued successfully',
                data: {
                    id: queued.id,
                    phone: queued.phone,
                    jid: queued.jid,
                    otpCode: queued.otpCode,
                    text: queued.messageText,
                    isSent: false
                }
            });
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: error?.message || 'Failed to queue OTP'
            });
        }
    });

    app.get('/messages', apiKeyMiddleware, (req, res) => {
        try {
            const rows = listRecentMessages(50).map(mapMessageRow);

            return res.json({
                success: true,
                data: rows
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: error?.message || 'Failed to fetch messages'
            });
        }
    });

    app.get('/messages/:id', apiKeyMiddleware, (req, res) => {
        try {
            const id = Number(req.params.id);

            if (Number.isNaN(id) || id <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid id'
                });
            }

            const row = getMessageById(id);

            if (!row) {
                return res.status(404).json({
                    success: false,
                    message: 'Message not found'
                });
            }

            return res.json({
                success: true,
                data: mapMessageRow(row)
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: error?.message || 'Failed to fetch message'
            });
        }
    });

    app.use((err, req, res, next) => {
        return res.status(500).json({
            success: false,
            message: err?.message || 'Internal server error'
        });
    });

    app.listen(API_PORT, API_HOST, () => {
        console.log('API server is running');
        console.log(`Port: ${API_PORT}`);
        console.log(`Docs: /docs`);
        console.log('Protected endpoint API key header: x-api-key');
    });
}

async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version, isLatest } = await fetchLatestBaileysVersion();

        console.log(`Using WA Web version: ${version.join('.')}`);
        console.log(`Is latest version: ${isLatest}`);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['WhatsApp Sender', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        currentSock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('Scan this QR with WhatsApp:');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'connecting') {
                isConnected = false;
                console.log('Connecting to WhatsApp...');
            }

            if (connection === 'open') {
                isConnected = true;
                console.log('Bot connected successfully');
            }

            if (connection === 'close') {
                isConnected = false;

                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log('Connection closed');
                console.log('Disconnect status code:', statusCode);
                console.log('Should reconnect:', shouldReconnect);

                if (shouldReconnect) {
                    setTimeout(() => {
                        startBot().catch((err) => {
                            console.error('Reconnect failed:', err?.message || err);
                        });
                    }, 3000);
                } else {
                    console.log('Logged out. Delete auth_info_baileys folder and scan again.');
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            if (!messages || messages.length === 0) return;

            const msg = messages[0];
            if (!msg.message) return;
            if (msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
            if (!jid) return;
            if (jid === 'status@broadcast') return;

            const text = getMessageText(msg.message).trim();
            const lowerText = text.toLowerCase();

            console.log('\nIncoming message from:', jid);
            console.log('Message text:', text || '[non-text message]');

            try {
                if (lowerText === 'hello') {
                    await sock.sendMessage(jid, { text: 'Hello world!' });
                    return;
                }

                if (lowerText === 'ping') {
                    await sock.sendMessage(jid, { text: 'pong' });
                    return;
                }

                if (lowerText === 'menu') {
                    await sock.sendMessage(jid, {
                        text: 'Commands:\nhello\nping\nmenu'
                    });
                    return;
                }
            } catch (error) {
                console.error('Failed to handle incoming message:', error?.message || error);
            }
        });

        startQueueWorker();

        return sock;
    } catch (error) {
        console.error('Bot startup failed:', error?.message || error);
        return null;
    }
}

initDb();
startApiServer();
startBot();