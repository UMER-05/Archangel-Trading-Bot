// backend/src/__tests__/testDb.ts
// Shared in-memory MongoDB helper for integration tests. db.service.ts reads
// process.env.MONGO_URI at module top-level, so it must be set BEFORE that
// module (or anything importing it, like app.ts) is ever loaded in this
// worker process — hence the dynamic import() inside startTestDb() rather
// than a static top-of-file import anywhere that uses this helper.
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod: MongoMemoryServer | null = null;

export async function startTestDb() {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.MONGO_DB_NAME = "archangel-test";

  const dbService = (await import("../services/db.service.js")).default;
  await dbService.connect();
  return dbService;
}

export async function stopTestDb() {
  const dbService = (await import("../services/db.service.js")).default;
  await dbService.close();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}
