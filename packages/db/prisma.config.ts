import { defineConfig } from 'prisma/config';
import { loadRootEnv } from './src/env';

loadRootEnv();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` does not need a database, so tolerate a missing URL there.
    url: process.env.DATABASE_URL ?? 'postgresql://invalid:invalid@localhost:5432/invalid',
  },
});
