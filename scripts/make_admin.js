const dotenv = require("dotenv");
dotenv.config();

const { MongoClient } = require("mongodb");

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    throw new Error("Usage: node scripts/make_admin.js user@example.com");
  }
  if (!process.env.mongo_db_URI) {
    throw new Error("mongo_db_URI is missing");
  }

  const client = new MongoClient(process.env.mongo_db_URI);
  await client.connect();
  try {
    const users = client.db("langbattle").collection("users");
    const result = await users.updateOne(
      { email },
      { $set: { role: "admin", banned: false } }
    );
    if (result.matchedCount === 0) {
      throw new Error(`No user found for ${email}`);
    }
    console.log(`${email} is now an admin.`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
