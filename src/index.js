require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');

// Inicializar BD primero
const { pool, initSchema } = require('./db');
const db = require('./db');

const authRoutes          = require('./routes/auth');
const conversationsRoutes = require('./routes/conversations');
const messagesRoutes      = require('./routes/messages');
const agentsRoutes        = require('./routes/agents');
const tenantsRoutes       = require('./routes/tenants');
const automationsRoutes   = require('./routes/automations');
const mediaRoutes         = require('./routes/media');
const triggersRoutes      = require('./triggers/index');
const releasesRoutes      = require('./routes/releases');
const tasksRoutes         = require('./routes/tasks');
const aiAgentRoutes           = require('./routes/ai-agent');
const notificationsRoutes     = require('./routes/notifications');
const metaWebhook                    = require('./webhook/meta');
const { replayPendingWebhooks }      = require('./webhook/meta');
const { startCronJobs }   = require('./engine/cron');
const { setIO }           = require('./io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.set('io', io);
setIO(io); // disponible para el motor de automatizaciones (background, sin req.app)

// ── Middlewares ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rutas API ─────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/conversations', messagesRoutes);
app.use('/api/messages',      messagesRoutes); // PATCH/DELETE /api/messages/:id (editar/eliminar mensaje)
app.use('/api/agents',        agentsRoutes);
app.use('/api/tenants',       tenantsRoutes);
app.use('/api/automations',   automationsRoutes);
app.use('/api/media',         mediaRoutes);
app.use('/api/triggers',      triggersRoutes);
app.use('/api',               tasksRoutes);
app.use('/api/ai-agent',      aiAgentRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/',                  releasesRoutes);
app.use('/webhook/meta',      metaWebhook);

app.get('/health', (_, res) => res.json({
  status: 'ok',
  ts:     new Date().toISOString(),
  uptime: process.uptime(),
}));

// ── Socket.io — multi-tenant ──────────────────────────────────────────────────
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token requerido'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const agent   = await db.prepare(
      'SELECT id, tenant_id, name FROM agents WHERE id = ? AND active = 1'
    ).get(payload.id);
    if (!agent) return next(new Error('Agente no encontrado'));
    socket.agentId   = agent.id;
    socket.tenantId  = agent.tenant_id;
    next();
  } catch {
    next(new Error('Token inválido'));
  }
});

io.on('connection', (socket) => {
  socket.join(`tenant:${socket.tenantId}`);
  console.log(`🟢 Agente #${socket.agentId} (tenant:${socket.tenantId}) conectado`);

  socket.on('join:conversation',  (convId) => socket.join(`conv:${convId}`));
  socket.on('leave:conversation', (convId) => socket.leave(`conv:${convId}`));
  socket.on('disconnect', () => console.log(`🔴 Agente #${socket.agentId} desconectado`));
});

// ── Arrancar servidor ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await initSchema();

    // Reprocesar webhooks que quedaron en status='pending' antes del último reinicio
    // (Railway mata el proceso con SIGKILL durante OOM/deploy, esto evita perder leads)
    await replayPendingWebhooks(io);

    startCronJobs();
    server.listen(PORT, () => {
      console.log(`\n🚀 Whasat Backend corriendo en http://localhost:${PORT}`);
      console.log(`📡 Webhook Meta:  POST http://localhost:${PORT}/webhook/meta`);
      console.log(`🔍 DATABASE_URL: ${(process.env.DATABASE_URL||'').slice(0,40)}...`);
      console.log(`🔗 Triggers CRM:  POST http://localhost:${PORT}/api/triggers/lead-created`);
      console.log(`                  POST http://localhost:${PORT}/api/triggers/appointment-scheduled`);
      console.log(`🔐 CRM_WEBHOOK_SECRET cargado: ${process.env.CRM_WEBHOOK_SECRET ? `SÍ (${process.env.CRM_WEBHOOK_SECRET.length} chars)` : 'NO ❌'}`);
      console.log(`🔗 CRM_WEBHOOK_URL: ${process.env.CRM_WEBHOOK_URL || 'NO CONFIGURADA ❌'}\n`);
    });
  } catch (err) {
    console.error('❌ Error al iniciar servidor:', err);
    process.exit(1);
  }
}

start();
