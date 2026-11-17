// Prisma CLI configuration (migrate, generate, db pull). The app reads DATABASE_URL from .env the same way.
import { defineConfig } from 'prisma/config';

try { process.loadEnvFile('.env'); } catch { /* no .env: the environment provides DATABASE_URL (Docker, CI) */ }

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
