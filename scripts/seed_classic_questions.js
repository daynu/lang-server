const dotenv = require("dotenv");
dotenv.config();

const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

function normalizeLanguage(lang) {
  const v = (lang ?? "").toString().trim().toLowerCase();
  if (v === "en" || v === "english") return "english";
  if (v === "de" || v === "german" || v === "deutsch") return "german";
  if (v === "fr" || v === "french" || v === "francais") return "french";
  return "english";
}

function buildExplanation(question, correctAnswers) {
  const provided = question.explanation?.toString().trim();
  if (provided) return provided;

  const answerText = correctAnswers.join(", ");
  if (question.type === "gap_fill") {
    return correctAnswers.length > 1
      ? `The blanks are completed in order with: ${answerText}.`
      : `The blank is completed with "${answerText}" because it fits the sentence grammatically.`;
  }

  return `"${answerText}" is the correct answer for this question.`;
}

function normalizeQuestion(question) {
  const correctAnswers = Array.isArray(question.correctAnswers)
    ? question.correctAnswers.map((answer) => answer.toString())
    : question.correctAnswer != null
      ? [question.correctAnswer.toString()]
      : [];

  return {
    id: question.id.toString(),
    language: normalizeLanguage(question.language),
    level: question.level?.toString() ?? "A1",
    text: question.text?.toString() ?? "",
    type: question.type?.toString() ?? "multiple_choice",
    options: Array.isArray(question.options)
      ? question.options.map((option) => option.toString())
      : [],
    correctAnswers,
    timeLimit: Number.isFinite(question.timeLimit) ? question.timeLimit : 15,
    explanation: buildExplanation(question, correctAnswers),
    source: "classic_seed_questions",
  };
}

async function main() {
  if (!process.env.mongo_db_URI) {
    throw new Error("mongo_db_URI is missing");
  }

  const seedPath = path.join(
    __dirname,
    "..",
    "data",
    "questions",
    "classic_seed_questions.json"
  );
  const payload = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const seedQuestions = payload
    .map(normalizeQuestion)
    .filter((question) =>
      question.id &&
      question.text &&
      question.options.length > 0 &&
      question.correctAnswers.length > 0
    );

  const client = new MongoClient(process.env.mongo_db_URI);
  await client.connect();

  try {
    const db = client.db("langbattle");
    const questions = db.collection("questions");

    await questions.createIndex({ language: 1, level: 1 });
    await questions.createIndex(
      { id: 1 },
      {
        unique: true,
        partialFilterExpression: { id: { $exists: true } },
      }
    );

    const result = await questions.bulkWrite(
      seedQuestions.map((question) => ({
        updateOne: {
          filter: { id: question.id },
          update: {
            $set: question,
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    const sourceCounts = await questions
      .aggregate([
        { $match: { source: "classic_seed_questions" } },
        {
          $group: {
            _id: { language: "$language", level: "$level" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.language": 1, "_id.level": 1 } },
      ])
      .toArray();

    console.log(
      JSON.stringify(
        {
          matched: result.matchedCount,
          modified: result.modifiedCount,
          upserted: result.upsertedCount,
          sourceCounts,
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
