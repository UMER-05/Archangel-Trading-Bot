// backend/src/__tests__/testDb.ts
// Shared in-memory MongoDB helper for integration tests. db.service.ts reads
// process.env.MONGO_URI at module top-level, so it must be set BEFORE that
// module (or anything importing it, like app.ts) is ever loaded in this
// worker process — hence the dynamic import() inside startTestDb() rather
// than a static top-of-file import anywhere that uses this helper.
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod: MongoMemoryServer | null = null;

export async function startTestDb() {
  // The embedded mongod can take well over the library's 10s default to boot
  // on a loaded machine (e.g. while the bot itself is running); that produced
  // "Instance failed to start within 10000ms" for every test in a suite, with
  // nothing wrong in the code under test. Allow 60s — the limit only matters
  // when startup is slow, it never masks a failing assertion.
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
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
