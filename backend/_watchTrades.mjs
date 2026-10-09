import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

async function watchForever() {
  while (true) {
    try {
      const client = new MongoClient(process.env.MONGO_URI);
      await client.connect();
      const db = client.db(process.env.MONGO_DB_NAME || "archangel");
      const col = db.collection("trades");

      console.log("WATCHING trades collection for new inserts...");

      const changeStream = col.watch([{ $match: { operationType: "insert" } }]);
      for await (const change of changeStream) {
        const t = change.fullDocument || {};
        console.log(
          `NEW_TRADE type=${t.type} token=${t.token} amount=${t.amount} price=${t.price} simulated=${t.simulated} signature=${t.signature} route=${t.route} wallet=${t.wallet}`
        );
      }
    } catch (err) {
      console.log(`WATCH_RECONNECTING reason=${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

watchForever();
