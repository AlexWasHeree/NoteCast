import { createApp } from './bootstrap';
import { logger } from './infrastructure/logger';

const app = await createApp();
app.startServer();

const log = logger.child('Server');
log.info('NoteCast started', { port: Number(app.port), db: app.notesDbPath });
