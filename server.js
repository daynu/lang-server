//Websocket
const dotenv = require("dotenv");
dotenv.config();
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET
const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);

app.get("/", (req, res) => {
  res.send("OK");
});

app.use("/admin", express.static(path.join(__dirname, "admin")));

const io = new Server(server, {
  cors: { origin: "*" },
  methods: ["GET", "POST"],
  maxHttpBufferSize: 2e6,
});

const queues = {};
function getQueueKey(language, mode) {
  return `${language}_${mode}`;
}
let rooms = {};
const userSockets = new Map();
const pendingChallenges = new Map();
const MATCHMAKING_RATING_RANGE = 200;
const MATCHMAKING_RELAX_AFTER_MS = 12_000;

function normalizeLanguage(lang) {
  const v = (lang ?? "").toString().trim().toLowerCase();
  if (v === "en" || v === "english") return "english";
  if (v === "de" || v === "german" || v === "deutsch") return "german";
  if (v === "fr" || v === "french" || v === "français" || v === "francais") return "french";
  // default
  return "english";
}

const WORD_CHAIN_DURATION_SECONDS = 60;
const WORD_CHAIN_STARTERS = {
  english: ["apple", "ocean", "tiger", "rocket", "planet", "garden"],
  german: ["apfel", "engel", "nacht", "tasse", "fenster", "garten"],
  french: ["ami", "orange", "école", "étoile", "nature", "salade"],
};

const FEATURED_LANGUAGE_MIN_GAMES = 10;
const SUPPORTED_GAME_LANGUAGES = Object.keys(WORD_CHAIN_STARTERS);
const CLASSIC_SEED_QUESTIONS = loadClassicSeedQuestions();

function normalizeChainWord(word) {
  return (word ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function vocabularyKey(word) {
  return normalizeChainWord(word)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss");
}

function getLastLetter(word) {
  const letters = vocabularyKey(word).match(/\p{L}/gu) || [];
  return letters.length ? letters[letters.length - 1] : "";
}

function isWordChainCandidateValid(word) {
  const normalized = normalizeChainWord(word);
  return normalized.length >= 2 && /^\p{L}+$/u.test(normalized);
}

function loadWordChainVocabularies() {
  const vocabDir = path.join(__dirname, "data", "word-chain");
  const vocabularies = {};

  for (const language of Object.keys(WORD_CHAIN_STARTERS)) {
    const filePath = path.join(vocabDir, `${language}.json`);
    const wordsByKey = new Map();

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const rawWords = Array.isArray(parsed) ? parsed : parsed.words;

      if (!Array.isArray(rawWords)) {
        throw new Error("Expected a JSON array or an object with a words array");
      }

      for (const entry of rawWords) {
        const display = typeof entry === "string"
          ? entry
          : (entry.display ?? entry.word ?? "").toString();
        const key = typeof entry === "object" && entry.key
          ? entry.key.toString()
          : vocabularyKey(display);

        if (key && isWordChainCandidateValid(display) && !wordsByKey.has(key)) {
          wordsByKey.set(key, {
            ...(typeof entry === "object" ? entry : {}),
            display,
            key,
          });
        }
      }

      console.log(`Loaded ${wordsByKey.size} word chain words for ${language}`);
    } catch (err) {
      console.warn(`Word chain vocabulary not loaded for ${language}: ${err.message}`);
    }

    vocabularies[language] = wordsByKey;
  }

  return vocabularies;
}

const WORD_CHAIN_VOCABULARIES = loadWordChainVocabularies();

function loadClassicSeedQuestions() {
  const seedPath = path.join(__dirname, "data", "questions", "classic_seed_questions.json");
  try {
    const payload = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    return Array.isArray(payload) ? payload : [];
  } catch (err) {
    console.warn(`Classic seed questions not loaded: ${err.message}`);
    return [];
  }
}

function getWordChainDisplayWord(language, word) {
  const lang = normalizeLanguage(language);
  const vocabulary = WORD_CHAIN_VOCABULARIES[lang];
  if (!vocabulary || vocabulary.size === 0) return normalizeChainWord(word);
  return vocabulary.get(vocabularyKey(word))?.display ?? null;
}

function getWordChainEntry(language, word) {
  const lang = normalizeLanguage(language);
  const vocabulary = WORD_CHAIN_VOCABULARIES[lang];
  if (!vocabulary || vocabulary.size === 0) return null;
  return vocabulary.get(vocabularyKey(word)) ?? null;
}

function createWordChainEntry(word, player, isStarter = false) {
  return {
    word,
    playerId: player?.userId?.toString() ?? null,
    playerName: player?.userName ?? (isStarter ? "Starting word" : "Unknown"),
    isStarter,
    playedAt: new Date().toISOString(),
  };
}

const wordDefinitionCache = new Map();

const TRANSLATION_LANGUAGE_ALIASES = {
  en: ["en", "english"],
  english: ["english", "en"],
  ro: ["ro", "romanian", "moldovan", "romanian moldavian moldovan"],
  romanian: ["romanian", "ro"],
  de: ["de", "german"],
  german: ["german", "de"],
  fr: ["fr", "french"],
  french: ["french", "fr"],
};

function translationValueToString(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const first = value.find(Boolean);
    return translationValueToString(first);
  }
  if (typeof value === "object") {
    return translationValueToString(
      value.text ?? value.translation ?? value.value ?? value.word
    );
  }
  const text = value.toString().trim();
  return text || null;
}

function pickWordTranslation(entry, targetLanguage) {
  if (!entry) return null;
  const target = (targetLanguage ?? "").toString().trim().toLowerCase();
  const translations = entry.translations;

  if (translations && typeof translations === "object") {
    const targetKeys = TRANSLATION_LANGUAGE_ALIASES[target] ?? [target];
    for (const key of targetKeys) {
      const direct = translationValueToString(translations[key]);
      if (direct) return direct;
    }

    const english = translationValueToString(translations.en ?? translations.english);
    if (english) return english;

    const first = translationValueToString(Object.values(translations).find(Boolean));
    if (first) return first;
  }

  return translationValueToString(entry.translation);
}

async function lookupWordDefinition(language, word, targetLanguage) {
  const lang = normalizeLanguage(language);
  const displayWord = getWordChainDisplayWord(lang, word) ?? normalizeChainWord(word);
  const key = `${lang}:${vocabularyKey(displayWord)}:${targetLanguage ?? "default"}`;
  if (wordDefinitionCache.has(key)) return wordDefinitionCache.get(key);

  const localTranslation = pickWordTranslation(
    getWordChainEntry(lang, displayWord),
    targetLanguage
  );
  if (localTranslation) {
    const result = {
      word: displayWord,
      language: lang,
      definition: localTranslation,
      partOfSpeech: null,
      source: "LangBattle",
    };
    wordDefinitionCache.set(key, result);
    return result;
  }

  const unavailable = {
    word: displayWord,
    language: lang,
    definition: "No translation was found for this word yet.",
    partOfSpeech: null,
    source: null,
  };
  wordDefinitionCache.set(key, unavailable);
  return unavailable;
}

async function getStartWord(language) {
  const lang = normalizeLanguage(language);
  const vocabulary = WORD_CHAIN_VOCABULARIES[lang];
  const starters = WORD_CHAIN_STARTERS[lang] || WORD_CHAIN_STARTERS.english;

  if (vocabulary && vocabulary.size > 0) {
    const vocabularyStarters = starters
      .map((word) => vocabulary.get(vocabularyKey(word))?.display)
      .filter(Boolean);
    if (vocabularyStarters.length > 0) {
      return vocabularyStarters[Math.floor(Math.random() * vocabularyStarters.length)];
    }

    const words = Array.from(vocabulary.values()).map((entry) => entry.display);
    return words[Math.floor(Math.random() * words.length)];
  }

  return starters[Math.floor(Math.random() * starters.length)];
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Basic name similarity scoring so closer matches appear first
function nameSimilarityScore(query, name) {
  if (!query || !name) return 0;
  const q = query.toString().trim().toLowerCase();
  const n = name.toString().trim().toLowerCase();
  if (!q || !n) return 0;
  if (n === q) return 4;          // exact match
  if (n.startsWith(q)) return 3;  // prefix match
  if (n.includes(q)) return 2;    // substring match
  // fallback: shorter distance between lengths = slightly better
  const lenDiff = Math.abs(n.length - q.length);
  return 1 / (1 + lenDiff);
}


function trackSocketForUser(socket) {
  if (!socket.userId) return;
  const key = socket.userId.toString();
  let set = userSockets.get(key);
  if (!set) {
    set = new Set();
    userSockets.set(key, set);
  }
  set.add(socket.id);
}

function getOnlineCount() {
  return userSockets.size;
}

function isUserOnline(userId) {
  const key = userId?.toString();
  return !!key && userSockets.has(key);
}

function parseWinStreak(value) {
  return typeof value === "number" && !isNaN(value) ? value : 0;
}

function getLanguageRating(user, language) {
  const rating = user?.ratings?.[language];
  if (typeof rating === "number" && !isNaN(rating)) return rating;
  const baseRating = user?.rating;
  return typeof baseRating === "number" && !isNaN(baseRating) ? baseRating : 1000;
}

async function getLanguageGameCounts(userIds) {
  const countsByUser = new Map();
  if (!db || !userIds.length) return countsByUser;

  const matchIds = [
    ...userIds,
    ...userIds.map((id) => id?.toString()).filter(Boolean),
  ];

  const rows = await db.collection("games").aggregate([
    { $match: { "players.userId": { $in: matchIds } } },
    { $unwind: "$players" },
    { $match: { "players.userId": { $in: matchIds } } },
    {
      $group: {
        _id: {
          userId: "$players.userId",
          language: "$language",
        },
        games: { $sum: 1 },
      },
    },
  ]).toArray();

  for (const row of rows) {
    const userId = row._id.userId?.toString();
    const language = normalizeLanguage(row._id.language);
    if (!userId) continue;
    const counts = countsByUser.get(userId) ?? {};
    counts[language] = (counts[language] ?? 0) + row.games;
    countsByUser.set(userId, counts);
  }

  return countsByUser;
}

function selectFeaturedLanguage(user, counts = {}) {
  const entries = SUPPORTED_GAME_LANGUAGES.map((language) => ({
    language,
    games: counts[language] ?? 0,
    rating: getLanguageRating(user, language),
  }));

  const eligible = entries.filter(
    (entry) => entry.games >= FEATURED_LANGUAGE_MIN_GAMES
  );
  const candidates = eligible.length
    ? eligible.sort((a, b) => b.rating - a.rating || b.games - a.games)
    : entries
        .filter((entry) => entry.games > 0)
        .sort((a, b) => b.games - a.games || b.rating - a.rating);

  const selected = candidates[0] ??
    entries.sort((a, b) => b.rating - a.rating)[0] ?? {
      language: "english",
      games: 0,
      rating: 1000,
    };

  return {
    featuredLanguage: selected.language,
    featuredRating: selected.rating,
    featuredRank: ratingToLevel(selected.rating),
    featuredGames: selected.games,
  };
}

async function buildFeaturedLanguageMap(usersList) {
  const countsByUser = await getLanguageGameCounts(
    usersList.map((user) => user._id)
  );
  return new Map(
    usersList.map((user) => [
      user._id.toString(),
      selectFeaturedLanguage(user, countsByUser.get(user._id.toString())),
    ])
  );
}

function serializeGame(g) {
  return {
    id: g._id.toString(),
    players: (g.players ?? []).map(p => ({
      ...p,
      userId: p.userId?.toString() ?? "",
    })),
    mode: g.mode ?? "classic",
    language: g.language,
    level: g.level,
    playedAt: g.playedAt,
    usedWords: g.usedWords ?? [],
    wordHistory: g.wordHistory ?? [],
  };
}

async function getGamesForUser(userId, limit = 20) {
  if (!db || !userId) return [];
  const userIdString = userId.toString();
  return db.collection("games")
    .find({ "players.userId": { $in: [userId, userIdString] } })
    .sort({ playedAt: -1 })
    .limit(limit)
    .toArray();
}

function wordChainScoresByUser(room) {
  const scores = {};
  for (const player of room?.players ?? []) {
    const userId = player?.userId?.toString();
    if (!userId) continue;
    scores[userId] = room?.scores?.[player.id] ?? 0;
  }
  return scores;
}

function untrackSocketForUser(socket) {
  if (!socket.userId) return;
  const key = socket.userId.toString();
  const set = userSockets.get(key);
  if (!set) return;
  set.delete(socket.id);
  if (set.size === 0) {
    userSockets.delete(key);
  }
}

function emitToUser(userId, event, payload) {
  const key = userId?.toString();
  if (!key) return;
  const set = userSockets.get(key);
  if (!set) return;
  for (const socketId of set) {
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.emit(event, payload);
    }
  }
}

function getSocketForUser(userId) {
  const key = userId?.toString();
  if (!key) return null;
  const set = userSockets.get(key);
  if (!set) return null;
  for (const socketId of set) {
    const s = io.sockets.sockets.get(socketId);
    if (s) return s;
  }
  return null;
}

function clearQueueRetry(socket) {
  if (!socket?.queueRetryTimer) return;
  clearTimeout(socket.queueRetryTimer);
  socket.queueRetryTimer = null;
}

function removeFromAllQueues(socket) {
  for (const key of Object.keys(queues)) {
    queues[key] = queues[key].filter((s) => s !== socket);
  }
  socket.queuedAt = null;
  clearQueueRetry(socket);
}

function hasActiveRoomForSocket(socket) {
  return Object.values(rooms)
    .some(room => room.players?.some(p => p.userId?.toString() === socket.userId?.toString()));
}

function queueWaitMs(socket) {
  return Date.now() - (socket.queuedAt ?? Date.now());
}

function canRelaxRatingRule(socket) {
  return queueWaitMs(socket) >= MATCHMAKING_RELAX_AFTER_MS;
}

function findQueuedPair(queue, language) {
  let fallbackPair = null;
  let fallbackDiff = Number.POSITIVE_INFINITY;

  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const first = queue[i];
      const second = queue[j];
      const diff = Math.abs(
        getLanguageRating(first, language) - getLanguageRating(second, language)
      );

      if (diff <= MATCHMAKING_RATING_RANGE) {
        return { firstIndex: i, secondIndex: j };
      }

      const canFallback = canRelaxRatingRule(first) || canRelaxRatingRule(second);
      if (canFallback && diff < fallbackDiff) {
        fallbackDiff = diff;
        fallbackPair = { firstIndex: i, secondIndex: j };
      }
    }
  }

  return fallbackPair;
}

async function createGameRoom(p1, p2, language, mode, { challenge = false } = {}) {
  const roomId = Math.random().toString(36).substring(2, 8);

  p1.join(roomId);
  p2.join(roomId);

  let questionsPayload = { questions: [], language, level: "A1", mode };

  try {
    const langKey = language.toLowerCase();
    const r1 = getLanguageRating(p1, langKey);
    const r2 = getLanguageRating(p2, langKey);
    const avgRating = Math.round((r1 + r2) / 2);
    const level = ratingToLevel(avgRating);

    if (mode === "word_chain") {
      const startWord = await getStartWord(language);
      const endsAt = new Date(Date.now() + WORD_CHAIN_DURATION_SECONDS * 1000);
      const wordHistory = [createWordChainEntry(startWord, null, true)];
      questionsPayload = {
        questions: [],
        language,
        level,
        mode,
        startWord,
        usedWords: [startWord],
        wordHistory,
        durationSeconds: WORD_CHAIN_DURATION_SECONDS,
        endsAt: endsAt.toISOString(),
      };
    } else {
      const result = await getRandomQuestions(language, level, 4);
      const normalized = (result.questions || []).map((q) => {
        const options = Array.isArray(q.options) ? q.options : [];
        const correctAnswers = Array.isArray(q.correctAnswers)
          ? q.correctAnswers
          : [q.correctAnswer ?? (q.correctIndex != null ? options[q.correctIndex] : options[0]) ?? ''];

        return {
          id: (q._id || q.id || q).toString(),
          text: q.text || "Unknown question",
          type: q.type || "multiple_choice",
          timeLimit: q.timeLimit ?? 15,
          options,
          correctAnswers,
          explanation: q.explanation || "",
        };
      });
      questionsPayload = {
        questions: normalized.length > 0 ? normalized : getFallbackQuestions(language),
        language: result.language,
        level: result.level,
        mode,
      };
    }
  } catch (err) {
    console.error("Failed to fetch questions:", err);
    if (mode !== "word_chain") {
      questionsPayload.questions = getFallbackQuestions(language);
    }
  }

  rooms[roomId] = {
    players: [p1, p2],
    language,
    mode,
    scores: { [p1.id]: 0, [p2.id]: 0 },
    finished: new Set(),
    questions: mode === "classic"
      ? Object.fromEntries(
          questionsPayload.questions.map(q => [q.id, q.correctAnswers || []])
        )
      : {},
    ...(mode === "word_chain" && {
      currentWord: questionsPayload.startWord,
      usedWords: new Set([questionsPayload.startWord]),
      usedWordKeys: new Set([vocabularyKey(questionsPayload.startWord)]),
      wordHistory: questionsPayload.wordHistory ?? [],
      endsAt: new Date(questionsPayload.endsAt),
    }),
  };

  await db.collection("active_rooms").insertOne({
    roomId,
    mode,
    players: [
      { userId: p1.userId.toString(), socketId: p1.id, name: p1.userName, score: 0, avatarBase64: p1.avatarBase64 ?? null },
      { userId: p2.userId.toString(), socketId: p2.id, name: p2.userName, score: 0, avatarBase64: p2.avatarBase64 ?? null },
    ],
    questions: questionsPayload.questions,
    currentIndexes: {
      [p1.userId.toString()]: 0,
      [p2.userId.toString()]: 0,
    },
    finished: [],
    language,
    startWord: questionsPayload.startWord ?? null,
    currentWord: questionsPayload.startWord ?? null,
    usedWords: questionsPayload.usedWords ?? [],
    wordHistory: questionsPayload.wordHistory ?? [],
    durationSeconds: questionsPayload.durationSeconds ?? null,
    endsAt: questionsPayload.endsAt ? new Date(questionsPayload.endsAt) : null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  io.to(roomId).emit("match_found", {
    roomId,
    mode,
    ...(challenge && { challenge: true }),
    players: [
      { id: p1.id, userId: p1.userId?.toString(), name: p1.userName, avatarBase64: p1.avatarBase64 ?? null },
      { id: p2.id, userId: p2.userId?.toString(), name: p2.userName, avatarBase64: p2.avatarBase64 ?? null },
    ],
    ...questionsPayload,
  });
}

async function tryMatchQueue(queueKey) {
  const [language, ...modeParts] = queueKey.split("_");
  const mode = modeParts.join("_") || "classic";

  while ((queues[queueKey] ?? []).length >= 2) {
    const queue = queues[queueKey] ?? [];
    const pair = findQueuedPair(queue, language);

    if (!pair) return;

    const p1 = queue[pair.firstIndex];
    const p2 = queue[pair.secondIndex];
    queues[queueKey] = queue.filter((_, index) =>
      index !== pair.firstIndex && index !== pair.secondIndex
    );
    clearQueueRetry(p1);
    clearQueueRetry(p2);
    p1.queuedAt = null;
    p2.queuedAt = null;

    await createGameRoom(p1, p2, language, mode);
  }
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.emit("connected");

  // Player joins matchmaking queue
socket.on("join_queue", async (data = {}) => {
  if (!socket.userName) {
    socket.emit("error_msg", "You must be authenticated to join the queue");
    return;
  }

  const VALID_MODES = ["classic", "word_chain"];

  const language = normalizeLanguage(data.language);
  const mode = VALID_MODES.includes(data.mode) ? data.mode : "classic";
  const queueKey = getQueueKey(language, mode);

  socket.selectedLanguage = language;
  socket.selectedMode = mode;

  // Prevent same user from queuing on multiple devices
  const alreadyInQueue = Object.values(queues)
    .some(q => q.some(s => s.userId?.toString() === socket.userId?.toString()));

  if (alreadyInQueue) {
    socket.emit("error_msg", "You are already in a queue on another device");
    return;
  }

  if (hasActiveRoomForSocket(socket)) {
    socket.emit("error_msg", "You are already in a game on another device");
    return;
  }

  removeFromAllQueues(socket);

  // Add to the correct queue
  if (!queues[queueKey]) queues[queueKey] = [];
  socket.queuedAt = Date.now();
  queues[queueKey].push(socket);
  console.log(`Player joined queue [${queueKey}]:`, queues[queueKey].length, "user:", socket.userName);

  socket.queueRetryTimer = setTimeout(() => {
    tryMatchQueue(queueKey).catch((err) =>
      console.error("Delayed matchmaking failed:", err)
    );
  }, MATCHMAKING_RELAX_AFTER_MS);

  await tryMatchQueue(queueKey);
  return;

});

  socket.on("upload_avatar", async ({ base64Image }) => {
    console.log("upload_avatar received, size:", base64Image?.length);
    if (!socket.userId || !base64Image) return;
    try {
      // Sanity-check size — base64 of 500KB image ≈ 680KB string
      if (base64Image.length > 700_000) {
        return socket.emit("error_msg", "Image is too large. Please choose a smaller photo.");
      }

      await users.updateOne(
        { _id: socket.userId },
        { $set: { avatarBase64: base64Image } }
      );

      socket.avatarBase64 = base64Image;
      socket.emit("avatar_updated", { avatarBase64: base64Image });
    } catch (err) {
      console.error("upload_avatar error:", err);
      socket.emit("error_msg", "Could not upload image");
    }
  });


  socket.on("get_active_room", async () => {
    if (!socket.userId) return socket.emit("active_room", { room: null });

    const userId = socket.userId.toString();
    const room = await db.collection("active_rooms").findOne({
      "players.userId": userId,
      finished: { $not: { $all: [] } },
      expiresAt: { $gt: new Date() },
    });

    if (!room) return socket.emit("active_room", { room: null });

    const me = room.players.find(p => p.userId === userId);
    const opponent = room.players.find(p => p.userId !== userId);

    socket.emit("active_room", {
      room: {
        roomId: room.roomId,
        mode: room.mode ?? "classic",
        language: room.language ?? "english",
        questions: room.questions,
        myScore: me?.score ?? 0,
        opponentScore: opponent?.score ?? 0,
        opponentName: opponent?.name ?? "Opponent",
        opponentAvatar: opponent?.avatarBase64 ?? null,
        myCurrentIndex: room.currentIndexes?.[userId] ?? 0,
        opponentFinished: room.finished?.includes(opponent?.userId),
        currentWord: room.currentWord ?? room.startWord ?? null,
        usedWords: room.usedWords ?? [],
        wordHistory: room.wordHistory ?? [],
        durationSeconds: room.durationSeconds ?? null,
        endsAt: room.endsAt ? new Date(room.endsAt).toISOString() : null,
      },
    });
  });

  socket.on("rejoin_room", async ({ roomId }) => {
    const room = await db.collection("active_rooms").findOne({ roomId });
    if (!room) return socket.emit("room_expired");

    socket.join(roomId);
    socket.battleService_roomId = roomId; // track for disconnect cleanup

    // Let the opponent know this player reconnected
    socket.to(roomId).emit("opponent_reconnected");
  });

  socket.on("get_word_definition", async ({ requestId, word, language, targetLanguage }) => {
    const definition = await lookupWordDefinition(language, word, targetLanguage);
    socket.emit("word_definition", {
      requestId,
      ...definition,
    });
  });

  // Relay player actions (answers, moves, etc.)
  socket.on("player_event", async (data) => {
    let isCorrect = false;
    const action = data?.payload?.action;
    if (socket.userId && data?.payload) {
      data.payload.playerId = socket.userId.toString();
    }

    if (action === "answer") {
      const roomMem = rooms[data.roomId];
      if (roomMem && roomMem.questions) {
        const correctList = roomMem.questions[data.payload.questionId] || [];
        const ans = data.payload.answer;
        if (Array.isArray(ans)) {
          isCorrect = JSON.stringify(ans) === JSON.stringify(correctList);
        } else {
          isCorrect = correctList.some(c => String(c).trim().toLowerCase() === String(ans).trim().toLowerCase());
        }

        if (isCorrect) {
          roomMem.scores[socket.id] = (roomMem.scores[socket.id] || 0) + 1;
        }
      }
      // Append correctness to payload so client can update score UI
      data.payload.correct = isCorrect;
    }

    if (action === "word_chain_move") {
      const roomMem = rooms[data.roomId];
      const submittedWord = normalizeChainWord(data.payload?.word);
      const submittedKey = vocabularyKey(data.payload?.word);
      const displayWord = roomMem?.mode === "word_chain"
        ? getWordChainDisplayWord(roomMem.language, submittedWord)
        : null;
      const usedWordKeys = roomMem?.usedWordKeys
        ?? new Set(Array.from(roomMem?.usedWords ?? []).map(vocabularyKey));
      if (roomMem?.mode === "word_chain") {
        roomMem.usedWordKeys = usedWordKeys;
      }

      if (!roomMem || roomMem.mode !== "word_chain") {
        data.payload.valid = false;
        data.payload.error = "This room is not a word chain match.";
      } else if (!submittedWord) {
        data.payload.valid = false;
        data.payload.error = "Enter a word first.";
      } else if (!isWordChainCandidateValid(submittedWord)) {
        data.payload.valid = false;
        data.payload.error = "Use a single word with letters only.";
      } else if (!displayWord) {
        data.payload.valid = false;
        data.payload.error = "That word is not in the vocabulary.";
      } else if (usedWordKeys.has(submittedKey)) {
        data.payload.valid = false;
        data.payload.error = "That word has already been used.";
      } else {
        const expectedLetter = getLastLetter(roomMem.currentWord);

        if (expectedLetter && submittedKey[0] !== expectedLetter) {
          data.payload.valid = false;
          data.payload.error = `Your word must start with "${expectedLetter.toUpperCase()}".`;
        } else {
          const wordEntry = createWordChainEntry(displayWord, socket);
          const scoringPlayer = roomMem.players.find(
            (player) => player.userId?.toString() === socket.userId?.toString()
          );
          const scoreKey = scoringPlayer?.id ?? socket.id;
          roomMem.currentWord = displayWord;
          roomMem.usedWords.add(displayWord);
          roomMem.wordHistory = roomMem.wordHistory ?? [];
          roomMem.wordHistory.push(wordEntry);
          usedWordKeys.add(submittedKey);
          roomMem.scores[scoreKey] = (roomMem.scores[scoreKey] || 0) + 1;

          data.payload.valid = true;
          data.payload.word = displayWord;
          data.payload.currentWord = displayWord;
          data.payload.usedWords = Array.from(roomMem.usedWords);
          data.payload.wordHistory = roomMem.wordHistory;
          data.payload.scores = wordChainScoresByUser(roomMem);

          await db.collection("active_rooms").updateOne(
            { roomId: data.roomId },
            {
              $set: {
                currentWord: displayWord,
                usedWords: Array.from(roomMem.usedWords),
                wordHistory: roomMem.wordHistory,
              },
              $inc: { "players.$[elem].score": 1 },
            },
            { arrayFilters: [{ "elem.userId": socket.userId?.toString() }] }
          );
        }
      }
    }

    // Broadcast modified event to opponents
    io.to(data.roomId).emit("player_event", data.payload);

    // Persist progress
    if (action === "answer" && socket.userId) {
      const userId = socket.userId.toString();
      const updateObj = {
        $set: { [`currentIndexes.${userId}`]: data.payload.questionIndex ?? 0 },
      };

      let updateOpts = {};
      if (isCorrect) {
        updateObj.$inc = { "players.$[elem].score": 1 };
        updateOpts = { arrayFilters: [{ "elem.userId": userId }] };
      }

      await db.collection("active_rooms").updateOne(
        { roomId: data.roomId },
        updateObj,
        updateOpts
      );
    }

    if (action === "finish" && socket.userId) {
      const userId = socket.userId.toString();
      await db.collection("active_rooms").updateOne(
        { roomId: data.roomId },
        { $addToSet: { finished: userId } }
      );

      const memRoom = rooms[data.roomId];
      if (memRoom) {
        memRoom.finished.add(userId);
        if (memRoom.finished.size >= 2) {
          await resolveRoom(data.roomId);
        }
      }

      // Clean up when both finished
      const room = await db.collection("active_rooms").findOne({ roomId: data.roomId });
      if (room?.finished?.length >= 2) {
        await db.collection("active_rooms").deleteOne({ roomId: data.roomId });
      }
    }
  });
  // Friends: send a friend request by email or userId
  socket.on("add_friend", async ({ email, userId }) => {
    try {
      if (!socket.userId) {
        return socket.emit("error_msg", "You must be logged in to add friends");
      }
      if (!users || !friendRequests) {
        console.error("add_friend attempted before MongoDB initialized");
        return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
      }
      const meId = socket.userId;
      const me = await users.findOne({ _id: meId }, { projection: { name: 1, rating: 1, friends: 1 } });
      if (!me) {
        return socket.emit("error_msg", "User not found");
      }

      let friend;

      if (userId) {
        const friendObjectId = new ObjectId(userId);
        friend = await users.findOne({ _id: friendObjectId });
      } else {
        if (!email) {
          return socket.emit("error_msg", "Friend email or id is required");
        }
        friend = await users.findOne({ email });
      }

      if (!friend) {
        return socket.emit("error_msg", "User not found");
      }

      if (friend._id.equals(meId)) {
        return socket.emit("error_msg", "You cannot add yourself as a friend");
      }

      const alreadyFriends =
        Array.isArray(me.friends) &&
        me.friends.some((fid) => fid && fid.equals && fid.equals(friend._id));
      if (alreadyFriends) {
        return socket.emit("error_msg", "You are already friends with this player");
      }

      // Check for existing pending request from me to friend
      const existing = await friendRequests.findOne({
        from: meId,
        to: friend._id,
        status: "pending",
      });
      if (existing) {
        return socket.emit("error_msg", "Friend request already sent");
      }

      // Check if the other user has already sent me a pending request
      const opposite = await friendRequests.findOne({
        from: friend._id,
        to: meId,
        status: "pending",
      });

      const now = new Date();

      if (opposite) {
        // Auto-accept mutual friend requests
        await friendRequests.updateOne(
          { _id: opposite._id },
          { $set: { status: "accepted", respondedAt: now } }
        );

        await users.updateOne(
          { _id: meId },
          { $addToSet: { friends: friend._id } }
        );
        await users.updateOne(
          { _id: friend._id },
          { $addToSet: { friends: meId } }
        );

        const meUpdated = await users.findOne(
          { _id: meId },
          { projection: { friends: 1 } }
        );
        const friendUpdated = await users.findOne(
          { _id: friend._id },
          { projection: { friends: 1 } }
        );

        const meFriendsIds = Array.isArray(meUpdated?.friends)
          ? meUpdated.friends
          : [];
        const friendFriendsIds = Array.isArray(friendUpdated?.friends)
          ? friendUpdated.friends
          : [];

        const meFriendsCount = meFriendsIds.length;
        const friendFriendsCount = friendFriendsIds.length;

        const meRating =
          typeof me.rating === "number" && !isNaN(me.rating) ? me.rating : 1000;
        const friendRating =
          typeof friend.rating === "number" && !isNaN(friend.rating)
            ? friend.rating
            : 1000;

        // Notify both users that they are now friends
        emitToUser(meId, "friend_added", {
          friend: {
            userId: friend._id.toString(),
            name: friend.name,
            rating: friendRating,
            avatarBase64: friend.avatarBase64 ?? null,
            isOnline: isUserOnline(friend._id),
          },
          friendsCount: meFriendsCount,
        });

        emitToUser(friend._id, "friend_added", {
          friend: {
            userId: meId.toString(),
            name: me.name,
            rating: meRating,
            avatarBase64: me.avatarBase64 ?? null,
            isOnline: isUserOnline(meId),
          },
          friendsCount: friendFriendsCount,
        });

        // Also notify both sides that the request was accepted
        emitToUser(meId, "friend_request_updated", {
          requestId: opposite._id.toString(),
          fromUserId: opposite.from.toString(),
          toUserId: opposite.to.toString(),
          status: "accepted",
        });
        emitToUser(friend._id, "friend_request_updated", {
          requestId: opposite._id.toString(),
          fromUserId: opposite.from.toString(),
          toUserId: opposite.to.toString(),
          status: "accepted",
        });
        return;
      }

      const result = await friendRequests.insertOne({
        from: meId,
        to: friend._id,
        status: "pending",
        createdAt: now,
      });

      const meRating =
        typeof me.rating === "number" && !isNaN(me.rating) ? me.rating : 1000;

      const requestPayload = {
        requestId: result.insertedId.toString(),
        fromUserId: meId.toString(),
        toUserId: friend._id.toString(),
        fromName: me.name,
        fromRating: meRating,
        status: "pending",
        createdAt: now.toISOString(),
      };

      // Acknowledge to the sender (optional UI)
      socket.emit("friend_request_sent", requestPayload);

      // Notify the target user (if online)
      emitToUser(friend._id, "friend_request_created", requestPayload);
    } catch (err) {
      console.error("add_friend error", err);
      socket.emit("error_msg", "Could not add friend");
    }
  });

  socket.on("remove_friend", async ({ userId }) => {
    try {
      if (!socket.userId) {
        return socket.emit("error_msg", "You must be logged in to remove friends");
      }
      if (!users) {
        console.error("remove_friend attempted before MongoDB initialized");
        return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
      }
      const meId = socket.userId;
      const friendObjectId = new ObjectId(userId);

      await users.updateOne(
        { _id: meId },
        { $pull: { friends: friendObjectId } }
      );

      // Also remove the reverse friend relationship
      await users.updateOne(
        { _id: friendObjectId },
        { $pull: { friends: meId } }
      );

      // Notify the user that their friend was removed
      emitToUser(meId, "friend_removed", {
        userId: userId,
      });
    } catch (err) {
      console.error("remove_friend error", err);
      socket.emit("error_msg", "Could not remove friend");
    }
  });


  socket.on("leave_queue", () => {
    removeFromAllQueues(socket);
    console.log(`Player ${socket.userName} left the queue`);
  });

  // Friends: search potential new friends by name (live search)
  socket.on("search_players", async ({ name }) => {
    try {
      if (!socket.userId) {
        return socket.emit("error_msg", "You must be logged in to search for players");
      }
      if (!users) {
        console.error("search_players attempted before MongoDB initialized");
        return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
      }

      const rawQuery = (name ?? "").toString().trim();
      if (!rawQuery || rawQuery.length < 2) {
        // Require at least 2 characters to avoid very broad scans
        return socket.emit("search_players_result", {
          query: rawQuery,
          players: [],
        });
      }

      const regex = new RegExp(escapeRegex(rawQuery), "i");

      // Fetch a limited number of candidates by name
      const candidates = await users
        .find({ name: regex })
        .project({ name: 1, rating: 1, ratings: 1, friends: 1, avatarBase64: 1 })
        .limit(50)
        .toArray();
      const featuredByUser = await buildFeaturedLanguageMap(candidates);

      // Sort by similarity score (higher is better), then rating desc
      candidates.sort((a, b) => {
        const sa = nameSimilarityScore(rawQuery, a.name);
        const sb = nameSimilarityScore(rawQuery, b.name);
        if (sb !== sa) return sb - sa;
        const ra =
          typeof a.rating === "number" && !isNaN(a.rating) ? a.rating : 0;
        const rb =
          typeof b.rating === "number" && !isNaN(b.rating) ? b.rating : 0;
        return rb - ra;
      });

      const players = candidates.map((u) => {
        const rating =
          typeof u.rating === "number" && !isNaN(u.rating) ? u.rating : 1000;
        const isSelf =
          u._id && u._id.equals && u._id.equals(socket.userId);
        const isFriend =
          Array.isArray(u.friends) &&
          u.friends.some(
            (fid) => fid && fid.equals && fid.equals(socket.userId)
          );
        return {
          userId: u._id.toString(),
          name: u.name,
          rating,
          ...(featuredByUser.get(u._id.toString()) ?? selectFeaturedLanguage(u)),
          isFriend,
          isSelf,
        };
      });

      socket.emit("search_players_result", {
        query: rawQuery,
        players,
      });
    } catch (err) {
      console.error("search_players error", err);
      socket.emit("error_msg", "Could not search for players");
    }
  });

  // Friends: fetch pending friend requests for current user
  socket.on("get_friend_requests", async () => {
    try {
      if (!socket.userId) {
        return socket.emit("error_msg", "You must be logged in to see friend requests");
      }
      if (!users || !friendRequests) {
        console.error("get_friend_requests attempted before MongoDB initialized");
        return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
      }

      const pending = await friendRequests
        .find({ to: socket.userId, status: "pending" })
        .sort({ createdAt: -1 })
        .toArray();

      if (!pending.length) {
        return socket.emit("friend_requests", { requests: [] });
      }

      const fromIds = pending.map((r) => r.from);
      const senders = await users
        .find({ _id: { $in: fromIds } })
        .project({ name: 1, rating: 1, avatarBase64: 1 })
        .toArray();
      const sendersById = new Map(
        senders.map((u) => [u._id.toString(), u])
      );

      const requestsPayload = pending.map((r) => {
        const sender = sendersById.get(r.from.toString()) || {};
        const rating =
          typeof sender.rating === "number" && !isNaN(sender.rating)
            ? sender.rating
            : 1000;
        return {
          requestId: r._id.toString(),
          fromUserId: r.from.toString(),
          toUserId: r.to.toString(),
          fromName: sender.name || "Unknown",
          fromRating: rating,
          status: r.status || "pending",
          createdAt: (r.createdAt || new Date()).toISOString(),
        };
      });

      socket.emit("friend_requests", { requests: requestsPayload });
    } catch (err) {
      console.error("get_friend_requests error", err);
      socket.emit("error_msg", "Could not load friend requests");
    }
  });


  socket.on("get_game_history", async () => {
    if (!socket.userId) return;
    try {
      const games = await getGamesForUser(socket.userId, 20);

      socket.emit("game_history", {
        games: games.map(serializeGame)
      });
    } catch (err) {
      console.error("get_game_history error:", err);
    }
  });

  socket.on("get_rating_history", async ({ language }) => {
    if (!socket.userId) return;
    try {
      const user = await users.findOne(
        { _id: socket.userId },
        { projection: { ratingHistory: 1 } }
      );
      const history = (user?.ratingHistory ?? [])
        .filter(e => e.language === language)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      socket.emit("rating_history", { history, language });
    } catch (err) {
      console.error("get_rating_history error:", err);
    }
  });

  // Friends: respond to a friend request (accept/reject)
  socket.on("respond_friend_request", async ({ requestId, action }) => {
    try {
      if (!socket.userId) {
        return socket.emit("error_msg", "You must be logged in to respond to friend requests");
      }
      if (!users || !friendRequests) {
        console.error("respond_friend_request attempted before MongoDB initialized");
        return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
      }

      if (!requestId || !action) {
        return socket.emit("error_msg", "Missing requestId or action");
      }

      const normalizedAction = action.toString().toLowerCase();
      if (normalizedAction !== "accept" && normalizedAction !== "reject") {
        return socket.emit("error_msg", "Invalid action");
      }

      const reqObjectId = new ObjectId(requestId);
      const request = await friendRequests.findOne({ _id: reqObjectId });
      if (!request) {
        return socket.emit("error_msg", "Friend request not found");
      }

      if (!request.to.equals(socket.userId)) {
        return socket.emit("error_msg", "You are not allowed to respond to this request");
      }

      if (request.status && request.status !== "pending") {
        return socket.emit("error_msg", "This request has already been handled");
      }

      const now = new Date();

      if (normalizedAction === "reject") {
        await friendRequests.updateOne(
          { _id: reqObjectId },
          { $set: { status: "rejected", respondedAt: now } }
        );

        const payload = {
          requestId: request._id.toString(),
          fromUserId: request.from.toString(),
          toUserId: request.to.toString(),
          status: "rejected",
        };

        emitToUser(request.to, "friend_request_updated", payload);
        emitToUser(request.from, "friend_request_updated", payload);
        return;
      }

      // accept
      await friendRequests.updateOne(
        { _id: reqObjectId },
        { $set: { status: "accepted", respondedAt: now } }
      );

      await users.updateOne(
        { _id: request.to },
        { $addToSet: { friends: request.from } }
      );
      await users.updateOne(
        { _id: request.from },
        { $addToSet: { friends: request.to } }
      );

      const me = await users.findOne(
        { _id: request.to },
        { projection: { name: 1, rating: 1, ratings: 1, friends: 1, avatarBase64: 1 } }
      );
      const other = await users.findOne(
        { _id: request.from },
        { projection: { name: 1, rating: 1, ratings: 1, friends: 1, avatarBase64: 1 } }
      );

      const meFriendsIds = Array.isArray(me?.friends) ? me.friends : [];
      const otherFriendsIds = Array.isArray(other?.friends) ? other.friends : [];

      const meFriendsCount = meFriendsIds.length;
      const otherFriendsCount = otherFriendsIds.length;

      const meRating =
        typeof me?.rating === "number" && !isNaN(me.rating) ? me.rating : 1000;
      const otherRating =
        typeof other?.rating === "number" && !isNaN(other.rating)
          ? other.rating
          : 1000;
      const featuredByUser = await buildFeaturedLanguageMap(
        [me, other].filter(Boolean)
      );
      const meFeatured = me
        ? featuredByUser.get(me._id.toString()) ?? selectFeaturedLanguage(me)
        : selectFeaturedLanguage(null);
      const otherFeatured = other
        ? featuredByUser.get(other._id.toString()) ?? selectFeaturedLanguage(other)
        : selectFeaturedLanguage(null);

      emitToUser(request.to, "friend_added", {
        friend: {
          userId: request.from.toString(),
          name: other?.name || "Unknown",
          rating: otherRating,
          avatarBase64: other?.avatarBase64 ?? null,
          ...otherFeatured,
        },
        friendsCount: meFriendsCount,
      });

      emitToUser(request.from, "friend_added", {
        friend: {
          userId: request.to.toString(),
          name: me?.name || "Unknown",
          rating: meRating,
          avatarBase64: me?.avatarBase64 ?? null,
          ...meFeatured,
        },
        friendsCount: otherFriendsCount,
      });

      const payload = {
        requestId: request._id.toString(),
        fromUserId: request.from.toString(),
        toUserId: request.to.toString(),
        status: "accepted",
      };

      emitToUser(request.to, "friend_request_updated", payload);
      emitToUser(request.from, "friend_request_updated", payload);
    } catch (err) {
      console.error("respond_friend_request error", err);
      socket.emit("error_msg", "Could not respond to friend request");
    }
  });

  // Friends: fetch current user's friends
  socket.on("get_friends", async () => {
    try {
      if (!socket.userId) {
        return socket.emit("error_msg", "You must be logged in to see friends");
      }
      if (!users) {
        console.error("get_friends attempted before MongoDB initialized");
        return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
      }

      const me = await users.findOne(
        { _id: socket.userId },
        { projection: { friends: 1 } }
      );
      const friendsIds = Array.isArray(me?.friends) ? me.friends : [];
      if (!friendsIds.length) {
        return socket.emit("friends_list", { friends: [], friendsCount: 0 });
      }

      const friendsDocs = await users
        .find({ _id: { $in: friendsIds } })
        .project({ name: 1, rating: 1, ratings: 1, avatarBase64: 1 })
        .toArray();
      const featuredByUser = await buildFeaturedLanguageMap(friendsDocs);

      socket.emit("friends_list", {
        friends: friendsDocs.map((u) => {
          const featured = featuredByUser.get(u._id.toString()) ??
            selectFeaturedLanguage(u);
          return {
            userId: u._id.toString(),
            name: u.name,
            rating:
              typeof u.rating === "number" && !isNaN(u.rating) ? u.rating : 1000,
            avatarBase64: u.avatarBase64 ?? null,
            isOnline: isUserOnline(u._id),
            ...featured,
          };
        }),
        friendsCount: friendsDocs.length,
      });
    } catch (err) {
      console.error("get_friends error", err);
      socket.emit("error_msg", "Could not load friends");
    }
  });

  socket.on("register", async ({ email, password, name, language, startingRating }) => {
    try {
      if (!users) {
        console.error("Register attempted before MongoDB initialized");
        return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
      }

      const normalizedEmail = email?.toString().trim().toLowerCase();
      const normalizedName = name?.toString().trim();

      if (!normalizedEmail || !password || !normalizedName) {
        return socket.emit("error_msg", "Missing credentials");
      }
      if (!/^.+@.+\..+$/.test(normalizedEmail)) {
        return socket.emit("error_msg", "Please enter a valid email address");
      }
      if (normalizedName.length < 3 || normalizedName.length > 20) {
        return socket.emit("error_msg", "Nickname must be 3-20 characters");
      }

      const lang = normalizeLanguage(language ?? 'english');
      const rating = typeof startingRating === 'number' ? startingRating : 200;
      const ratings = { [lang]: rating };

      const passwordHash = await bcrypt.hash(password, 10);

      const now = new Date();

      const result = await users.insertOne({
        email: normalizedEmail,
        passwordHash,
        name: normalizedName,
        rating,
        ratings,
        role: "user",
        banned: false,
        friends: [],
        createdAt: now,
        lastSeen: now,
        winStreak: 0,
      });

      const token = jwt.sign(
        { userId: result.insertedId.toString() },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      socket.userId = result.insertedId;
      socket.userName = normalizedName;
      socket.rating = rating;
      socket.ratings = ratings;
      socket.winStreak = 0;
      socket.role = "user";

      trackSocketForUser(socket);
      io.emit('online_count', { count: getOnlineCount() });

      socket.emit("register_success", {
        token,
        userId: socket.userId,
        name: normalizedName,
        rating,
        ratings,
        friendsCount: 0,
        createdAt: now,
        lastSeen: now,
        winStreak: 0,
        avatarBase64: null,
        role: "user",
      });

    } catch (err) {
      console.error("register error", err);
      const isDuplicateEmail = err?.code === 11000;
      socket.emit(
        "error_msg",
        isDuplicateEmail
          ? "Email already exists"
          : "Could not create account. Please check your details and try again."
      );
    }
  });

  socket.on("login", async ({ email, password }) => {
    if (!users) {
      console.error("Login attempted before MongoDB initialized");
      return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
    }
    const user = await users.findOne({ email });
    if (!user) {
      return socket.emit("error_msg", "Invalid credentials");
    }

    const ban = getActiveBan(user);
    if (ban) {
      return socket.emit("error_msg", ban.until
        ? `${ban.reason}. Ban ends ${ban.until.toLocaleString()}.`
        : ban.reason);
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return socket.emit("error_msg", "Invalid credentials");
    }

    const token = jwt.sign(
      { userId: user._id.toString() },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    socket.userId = user._id;
    socket.userName = user.name;
    socket.role = user.role ?? "user";

    trackSocketForUser(socket);
    io.emit('online_count', { count: getOnlineCount() });

    socket.avatarBase64 = user.avatarBase64 ?? null;
    const baseRating =
      typeof user.rating === "number" && !isNaN(user.rating)
        ? user.rating
        : 1000;
    const ratings = user.ratings || {
      english: baseRating,
      german: baseRating,
      french: baseRating,
    };

    const friendsIds = Array.isArray(user.friends) ? user.friends : [];
    const friendsCount = friendsIds.length;
    const winStreak = parseWinStreak(user.winStreak);

    socket.rating = baseRating;
    socket.winStreak = winStreak;

    const now = new Date();
    await users.updateOne(
      { _id: user._id },
      { $set: { lastSeen: now } }
    );

    socket.emit("login_success", {
      token,
      userId: user._id,
      name: user.name,
      rating: baseRating,
      ratings,
      friendsCount,
      createdAt: user.createdAt,
      lastSeen: now,
      winStreak,
      avatarBase64: user.avatarBase64 ?? null,
      role: user.role ?? "user",
    });
  });


  // Handle disconnect
  socket.on("disconnect", () => {
    untrackSocketForUser(socket);
    io.emit('online_count', { count: getOnlineCount() });

    removeFromAllQueues(socket);

    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players?.includes(socket)) {
        const other = room.players.find(p => p !== socket);
        if (other) {
          other.emit("opponent_disconnected");
          // Give disconnected player a score of -1 so they always lose the ELO calculation
          room.scores[socket.id] = -1;
          room.finished.add(socket.id);
          // Trigger ELO if the other player had already finished
          if (room.finished.size >= 2) {
            // re-use the same finish logic by faking a finish event
            socket.emit = () => { }; // silence any emits to the dead socket
            resolveRoom(roomId);
            return;// inline the ELO resolution rather than duplicating — extract to a function
          }
        }
        delete rooms[roomId];
      }
    }
  });

  const { ObjectId } = require("mongodb");

  socket.on("get_player_profile", async ({ userId }) => {
    try {
      if (!socket.userId) {
        return socket.emit("player_profile_error", {
          userId: userId?.toString() ?? "",
          message: "You must be logged in to view player profiles",
        });
      }
      if (!users) {
        return socket.emit("player_profile_error", {
          userId: userId?.toString() ?? "",
          message: "Server is starting up, please try again in a moment.",
        });
      }

      let playerObjectId;
      try {
        playerObjectId = new ObjectId(userId);
      } catch (_) {
        return socket.emit("player_profile_error", {
          userId: userId?.toString() ?? "",
          message: "Player not found",
        });
      }

      const player = await users.findOne(
        { _id: playerObjectId },
        {
          projection: {
            name: 1,
            ratings: 1,
            rating: 1,
            createdAt: 1,
            lastSeen: 1,
            avatarBase64: 1,
            friends: 1,
            winStreak: 1,
            ratingHistory: 1,
          },
        }
      );
      if (!player) {
        return socket.emit("player_profile_error", {
          userId: userId?.toString() ?? "",
          message: "Player not found",
        });
      }

      const baseRating =
        typeof player.rating === "number" && !isNaN(player.rating)
          ? player.rating
          : 1000;
      const ratings = player.ratings || {
        english: baseRating,
        german: baseRating,
        french: baseRating,
      };

      const countsByUser = await getLanguageGameCounts([player._id]);
      const featured = selectFeaturedLanguage(
        player,
        countsByUser.get(player._id.toString())
      );
      const friendsIds = Array.isArray(player.friends) ? player.friends : [];
      const games = await getGamesForUser(player._id, 50);
      const friendsDocs = friendsIds.length
        ? await users
            .find({ _id: { $in: friendsIds } })
            .project({ name: 1, rating: 1, ratings: 1, avatarBase64: 1 })
            .toArray()
        : [];
      const featuredFriendsByUser = await buildFeaturedLanguageMap(friendsDocs);

      socket.emit("player_profile", {
        userId: player._id.toString(),
        name: player.name,
        rating: baseRating,
        ratings,
        friendsCount: friendsIds.length,
        winStreak: parseWinStreak(player.winStreak),
        avatarBase64: player.avatarBase64 ?? null,
        createdAt: player.createdAt,
        lastSeen: player.lastSeen,
        bestLanguage: featured.featuredLanguage,
        bestRating: featured.featuredRating,
        bestRank: featured.featuredRank,
        bestLanguageGames: featured.featuredGames,
        ratingHistory: (player.ratingHistory ?? []).map((entry) => ({
          language: entry.language,
          rating: entry.rating,
          date: entry.date,
        })),
        games: games.map(serializeGame),
        friends: friendsDocs.map((u) => {
          const featuredFriend = featuredFriendsByUser.get(u._id.toString()) ??
            selectFeaturedLanguage(u);
          return {
            userId: u._id.toString(),
            name: u.name,
            rating:
              typeof u.rating === "number" && !isNaN(u.rating) ? u.rating : 1000,
            avatarBase64: u.avatarBase64 ?? null,
            isOnline: isUserOnline(u._id),
            ...featuredFriend,
          };
        }),
      });
    } catch (err) {
      console.error("get_player_profile error", err);
      socket.emit("player_profile_error", {
        userId: userId?.toString() ?? "",
        message: "Could not load player profile",
      });
    }
  });

  socket.on("challenge_player", ({ userId, mode, language }) => {
    if (!socket.userId) {
      return socket.emit("error_msg", "You must be logged in to challenge players");
    }
    if (!userId || userId.toString() === socket.userId.toString()) {
      return socket.emit("error_msg", "Invalid player");
    }
    const normalizedMode = mode === "word_chain" ? "word_chain" : "classic";
    const normalizedLanguage = normalizeLanguage(language);
    const targetSocket = getSocketForUser(userId);
    if (!targetSocket) {
      return socket.emit("error_msg", "Player is not online");
    }
    const challengeId = Math.random().toString(36).substring(2, 10);
    pendingChallenges.set(challengeId, {
      id: challengeId,
      fromUserId: socket.userId.toString(),
      toUserId: userId.toString(),
      mode: normalizedMode,
      language: normalizedLanguage,
      createdAt: Date.now(),
    });

    emitToUser(userId, "challenge_received", {
      challengeId,
      fromUserId: socket.userId.toString(),
      fromName: socket.userName,
      fromAvatarBase64: socket.avatarBase64 ?? null,
      mode: normalizedMode,
      language: normalizedLanguage,
    });
    socket.emit("challenge_sent", {
      challengeId,
      userId: userId.toString(),
      mode: normalizedMode,
      language: normalizedLanguage,
    });
  });

  socket.on("respond_challenge", async ({ challengeId, accept }) => {
    try {
      if (!socket.userId) {
        return socket.emit("error_msg", "You must be logged in to respond to challenges");
      }
      const challenge = pendingChallenges.get(challengeId);
      if (!challenge || challenge.toUserId !== socket.userId.toString()) {
        return socket.emit("error_msg", "Challenge is no longer available");
      }
      pendingChallenges.delete(challengeId);

      const challenger = getSocketForUser(challenge.fromUserId);
      if (!challenger) {
        socket.emit("challenge_expired", { challengeId });
        return socket.emit("error_msg", "The challenger is no longer online");
      }

      if (!accept) {
        challenger.emit("challenge_declined", {
          challengeId,
          userId: socket.userId.toString(),
          name: socket.userName,
        });
        return socket.emit("challenge_declined", { challengeId });
      }

      await startChallengeMatch(challenger, socket, challenge.language, challenge.mode);
    } catch (err) {
      console.error("respond_challenge error", err);
      socket.emit("error_msg", "Could not respond to challenge");
    }
  });

  socket.on("report_player", async ({ userId, reason }) => {
    try {
      if (!socket.userId) {
        return socket.emit("error_msg", "You must be logged in to report players");
      }
      if (!db) {
        return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
      }
      if (!userId || userId.toString() === socket.userId.toString()) {
        return socket.emit("error_msg", "Invalid player");
      }

      await db.collection("player_reports").insertOne({
        reporterId: socket.userId,
        reportedUserId: userId.toString(),
        reason: (reason ?? "").toString().trim(),
        createdAt: new Date(),
      });
      socket.emit("player_reported", { userId: userId.toString() });
    } catch (err) {
      console.error("report_player error", err);
      socket.emit("error_msg", "Could not report player");
    }
  });

  socket.on("report_question", async ({
    questionId,
    reason,
    roomId,
    language,
    text,
    type,
    timeLimit,
    options,
    correctAnswers,
    explanation,
  }) => {
    try {
      if (!socket.userId) {
        return socket.emit("error_msg", "You must be logged in to report questions");
      }
      if (!db) {
        return socket.emit("error_msg", "Server is starting up, please try again in a moment.");
      }

      const normalizedQuestionId = questionId?.toString().trim();
      if (!normalizedQuestionId) {
        return socket.emit("error_msg", "Invalid question");
      }

      const normalizedRoomId = roomId?.toString().trim() || null;
      const activeRoom = normalizedRoomId
        ? await db.collection("active_rooms").findOne({ roomId: normalizedRoomId })
        : null;
      const roomQuestion = activeRoom?.questions?.find((question) =>
        (question?.id ?? question?._id)?.toString() === normalizedQuestionId
      );
      const questionSnapshot = {
        id: normalizedQuestionId,
        text: (text ?? roomQuestion?.text ?? "").toString(),
        language: (language || activeRoom?.language)
          ? normalizeLanguage(language ?? activeRoom?.language)
          : "",
        level: (roomQuestion?.level ?? activeRoom?.level ?? "").toString(),
        type: (type ?? roomQuestion?.type ?? "multiple_choice").toString(),
        timeLimit: Number.isFinite(timeLimit)
          ? timeLimit
          : Number.isFinite(roomQuestion?.timeLimit)
            ? roomQuestion.timeLimit
            : 15,
        options: Array.isArray(options)
          ? options.map((option) => option.toString())
          : Array.isArray(roomQuestion?.options)
            ? roomQuestion.options.map((option) => option.toString())
            : [],
        correctAnswers: Array.isArray(correctAnswers)
          ? correctAnswers.map((answer) => answer.toString())
          : Array.isArray(roomQuestion?.correctAnswers)
            ? roomQuestion.correctAnswers.map((answer) => answer.toString())
            : [],
        explanation: (explanation ?? roomQuestion?.explanation ?? "").toString(),
      };

      await db.collection("question_reports").insertOne({
        reporterId: socket.userId,
        questionId: normalizedQuestionId,
        question: questionSnapshot,
        reason: (reason ?? "").toString().trim(),
        roomId: normalizedRoomId,
        createdAt: new Date(),
      });
      socket.emit("question_reported", { questionId: normalizedQuestionId });
    } catch (err) {
      console.error("report_question error", err);
      socket.emit("error_msg", "Could not report question");
    }
  });

  socket.on("auth", async ({ token }) => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);

      if (!users) {
        console.error("Auth attempted before MongoDB initialized");
        return socket.emit("auth_failed");
      }

      const user = await users.findOne({ _id: new ObjectId(payload.userId) });
      if (!user) {
        console.log("Auth failed, user not found", payload.userId);
        return socket.emit("auth_failed");
      }

      const ban = getActiveBan(user);
      if (ban) {
        socket.emit("error_msg", ban.until
          ? `${ban.reason}. Ban ends ${ban.until.toLocaleString()}.`
          : ban.reason);
        return socket.emit("auth_failed");
      }

      socket.userId = user._id;
      socket.userName = user.name;
      socket.role = user.role ?? "user";
      socket.avatarBase64 = user.avatarBase64 ?? null;
      const baseRating =
        typeof user.rating === "number" && !isNaN(user.rating)
          ? user.rating
          : 1000;
      const ratings = user.ratings || {
        english: baseRating,
        german: baseRating,
        french: baseRating,
      };

      socket.ratings = ratings;

      // Track socket for notifications
      trackSocketForUser(socket);
      io.emit('online_count', { count: getOnlineCount() });


      const friendsIds = Array.isArray(user.friends) ? user.friends : [];
      const friendsCount = friendsIds.length;
      const winStreak = parseWinStreak(user.winStreak);
      const now = new Date();
      socket.winStreak = winStreak;

      await users.updateOne(
        { _id: user._id },
        { $set: { lastSeen: now } }
      );

      console.log("Auth OK for", user.name);
      console.log(getOnlineCount(), "users online");

      socket.emit("auth_success", {
        userId: user._id.toString(),
        name: user.name,
        rating: baseRating,
        ratings,
        friendsCount,
        createdAt: user.createdAt,
        lastSeen: now,
        winStreak,
        avatarBase64: user.avatarBase64 ?? null,
        role: user.role ?? "user",
        onlineCount: getOnlineCount(),
      });
    } catch (e) {
      console.error("Auth failed", e);
      socket.emit("auth_failed");
    }
  });


});


async function resolveRoom(roomId) {
  const room = rooms[roomId];
  if (!room || room.finished.size < 2) return;

  const [p1, p2] = room.players;
  const langKey = room.language.toLowerCase();
  const r1 = p1.ratings?.[langKey] || 1000;
  const r2 = p2.ratings?.[langKey] || 1000;
  const s1 = room.scores[p1.id] ?? 0;
  const s2 = room.scores[p2.id] ?? 0;
  const scoreA = s1 > s2 ? 1 : s1 === s2 ? 0.5 : 0;
  const p1Won = s1 > s2;
  const p2Won = s2 > s1;
  const { newA, newB } = calculateElo(r1, r2, scoreA);
  let p1WinStreak = parseWinStreak(p1.winStreak);
  let p2WinStreak = parseWinStreak(p2.winStreak);

  if (users && p1.userId && p2.userId) {
    try {
      const now = new Date();
      const p1Update = {
        $set: { [`ratings.${langKey}`]: newA },
        $push: { ratingHistory: { rating: newA, language: langKey, date: now } }
      };
      const p2Update = {
        $set: { [`ratings.${langKey}`]: newB },
        $push: { ratingHistory: { rating: newB, language: langKey, date: now } }
      };

      if (p1Won) {
        p1Update.$inc = { winStreak: 1 };
      } else {
        p1Update.$set.winStreak = 0;
      }

      if (p2Won) {
        p2Update.$inc = { winStreak: 1 };
      } else {
        p2Update.$set.winStreak = 0;
      }

      await users.updateOne({ _id: p1.userId }, p1Update);
      await users.updateOne({ _id: p2.userId }, p2Update);

      const updatedUsers = await users
        .find({ _id: { $in: [p1.userId, p2.userId] } })
        .project({ winStreak: 1 })
        .toArray();
      const updatedStreaks = new Map(
        updatedUsers.map((user) => [user._id.toString(), parseWinStreak(user.winStreak)])
      );
      p1WinStreak = updatedStreaks.get(p1.userId.toString()) ?? (p1Won ? p1WinStreak + 1 : 0);
      p2WinStreak = updatedStreaks.get(p2.userId.toString()) ?? (p2Won ? p2WinStreak + 1 : 0);

      await db.collection("games").insertOne({
        players: [
          { userId: p1.userId, name: p1.userName, score: s1, ratingBefore: r1, ratingAfter: newA, avatarBase64: p1.avatarBase64 ?? null },
          { userId: p2.userId, name: p2.userName, score: s2, ratingBefore: r2, ratingAfter: newB, avatarBase64: p2.avatarBase64 ?? null },
        ],
        mode: room.mode ?? "classic",
        language: langKey,
        level: ratingToLevel(Math.round((r1 + r2) / 2)),
        playedAt: now,
        ...(room.mode === "word_chain" && {
          usedWords: room.usedWords ? Array.from(room.usedWords) : [],
          wordHistory: room.wordHistory ?? [],
        }),
      });

    } catch (err) {
      console.error("ELO update error:", err);
    }
  }

  if (p1.ratings) p1.ratings[langKey] = newA;
  if (p2.ratings) p2.ratings[langKey] = newB;
  p1.winStreak = p1WinStreak;
  p2.winStreak = p2WinStreak;

  io.to(roomId).emit("word_chain_resolved", {
    roomId,
    mode: room.mode,
    language: langKey,
    scores: wordChainScoresByUser(room),
    usedWords: room.usedWords ? Array.from(room.usedWords) : [],
    wordHistory: room.wordHistory ?? [],
  });

  p1.emit("rating_updated", { language: langKey, oldRating: r1, newRating: newA, delta: newA - r1, newLevel: ratingToLevel(newA), winStreak: p1WinStreak });
  p2.emit("rating_updated", { language: langKey, oldRating: r2, newRating: newB, delta: newB - r2, newLevel: ratingToLevel(newB), winStreak: p2WinStreak });

  console.log(`ELO updated: ${p1.userName} ${r1}→${newA}  ${p2.userName} ${r2}→${newB}`);
  delete rooms[roomId];
}

async function startChallengeMatch(p1, p2, language, mode) {
  const alreadyInRoom = Object.values(rooms)
    .some(room => room.players?.some(p =>
      p.userId?.toString() === p1.userId?.toString() ||
      p.userId?.toString() === p2.userId?.toString()
    ));

  if (alreadyInRoom) {
    p1.emit("error_msg", "One of the players is already in a game");
    p2.emit("error_msg", "One of the players is already in a game");
    return;
  }

  for (const key of Object.keys(queues)) {
    queues[key] = queues[key].filter((s) => s !== p1 && s !== p2);
  }

  const roomId = Math.random().toString(36).substring(2, 8);
  p1.join(roomId);
  p2.join(roomId);

  let questionsPayload = { questions: [], language, level: "A1", mode };

  try {
    const langKey = language.toLowerCase();
    const r1 = (p1.ratings && p1.ratings[langKey]) || 1000;
    const r2 = (p2.ratings && p2.ratings[langKey]) || 1000;
    const avgRating = Math.round((r1 + r2) / 2);
    const level = ratingToLevel(avgRating);

    if (mode === "word_chain") {
      const startWord = await getStartWord(language);
      const endsAt = new Date(Date.now() + WORD_CHAIN_DURATION_SECONDS * 1000);
      const wordHistory = [createWordChainEntry(startWord, null, true)];
      questionsPayload = {
        questions: [],
        language,
        level,
        mode,
        startWord,
        usedWords: [startWord],
        wordHistory,
        durationSeconds: WORD_CHAIN_DURATION_SECONDS,
        endsAt: endsAt.toISOString(),
      };
    } else {
      const result = await getRandomQuestions(language, level, 4);
      const normalized = (result.questions || []).map((q) => {
        const options = Array.isArray(q.options) ? q.options : [];
        const correctAnswers = Array.isArray(q.correctAnswers)
          ? q.correctAnswers
          : [q.correctAnswer ?? (q.correctIndex != null ? options[q.correctIndex] : options[0]) ?? ''];

        return {
          id: (q._id || q.id || q).toString(),
          text: q.text || "Unknown question",
          type: q.type || "multiple_choice",
          timeLimit: q.timeLimit ?? 15,
          options,
          correctAnswers,
          explanation: q.explanation || "",
        };
      });
      questionsPayload = {
        questions: normalized.length > 0 ? normalized : getFallbackQuestions(language),
        language: result.language,
        level: result.level,
        mode,
      };
    }
  } catch (err) {
    console.error("Failed to fetch challenge questions:", err);
    if (mode !== "word_chain") {
      questionsPayload.questions = getFallbackQuestions(language);
    }
  }

  rooms[roomId] = {
    players: [p1, p2],
    language,
    mode,
    scores: { [p1.id]: 0, [p2.id]: 0 },
    finished: new Set(),
    questions: mode === "classic"
      ? Object.fromEntries(
          questionsPayload.questions.map(q => [q.id, q.correctAnswers || []])
        )
      : {},
    ...(mode === "word_chain" && {
      currentWord: questionsPayload.startWord,
      usedWords: new Set([questionsPayload.startWord]),
      usedWordKeys: new Set([vocabularyKey(questionsPayload.startWord)]),
      wordHistory: questionsPayload.wordHistory ?? [],
      endsAt: new Date(questionsPayload.endsAt),
    }),
  };

  await db.collection("active_rooms").insertOne({
    roomId,
    mode,
    players: [
      { userId: p1.userId.toString(), socketId: p1.id, name: p1.userName, score: 0, avatarBase64: p1.avatarBase64 ?? null },
      { userId: p2.userId.toString(), socketId: p2.id, name: p2.userName, score: 0, avatarBase64: p2.avatarBase64 ?? null },
    ],
    questions: questionsPayload.questions,
    currentIndexes: {
      [p1.userId.toString()]: 0,
      [p2.userId.toString()]: 0,
    },
    finished: [],
    language,
    startWord: questionsPayload.startWord ?? null,
    currentWord: questionsPayload.startWord ?? null,
    usedWords: questionsPayload.usedWords ?? [],
    wordHistory: questionsPayload.wordHistory ?? [],
    durationSeconds: questionsPayload.durationSeconds ?? null,
    endsAt: questionsPayload.endsAt ? new Date(questionsPayload.endsAt) : null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  io.to(roomId).emit("match_found", {
    roomId,
    mode,
    challenge: true,
    players: [
      { id: p1.id, userId: p1.userId?.toString(), name: p1.userName, avatarBase64: p1.avatarBase64 ?? null },
      { id: p2.id, userId: p2.userId?.toString(), name: p2.userName, avatarBase64: p2.avatarBase64 ?? null },
    ],
    ...questionsPayload,
  });
}



//database
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcrypt");
const { get } = require("mongoose");

const mongo_db_URI = process.env.mongo_db_URI;
console.log("Connecting to MongoDB at", mongo_db_URI);

const client = new MongoClient(mongo_db_URI);

let db;
let users;
let friendRequests;

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);

function isAdminUser(user) {
  const role = user?.role?.toString().toLowerCase();
  const email = user?.email?.toString().toLowerCase();
  return role === "admin" || (email && ADMIN_EMAILS.has(email));
}

function getActiveBan(user) {
  if (!user?.banned) return null;
  const bannedUntil = user.bannedUntil ? new Date(user.bannedUntil) : null;
  if (bannedUntil && bannedUntil <= new Date()) return null;
  return {
    reason: user.banReason?.toString() || "Account suspended",
    until: bannedUntil,
  };
}

async function requireAdmin(req, res, next) {
  try {
    if (!users) {
      return res.status(503).json({ error: "Server is starting up" });
    }

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing admin token" });

    const payload = jwt.verify(token, JWT_SECRET);
    const admin = await users.findOne({ _id: new ObjectId(payload.userId) });
    if (!admin || !isAdminUser(admin)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const ban = getActiveBan(admin);
    if (ban) {
      return res.status(403).json({ error: ban.reason });
    }

    req.adminUser = admin;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid admin token" });
  }
}

function adminUserPayload(user) {
  return {
    userId: user._id.toString(),
    email: user.email,
    name: user.name,
    role: isAdminUser(user) ? "admin" : user.role ?? "user",
  };
}

function normalizeAdminQuestionPayload(body) {
  const providedId = body.id?.toString().trim();
  const id = providedId || `admin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const language = normalizeLanguage(body.language);
  const level = (body.level ?? "A1").toString().trim().toUpperCase();
  const type = body.type === "gap_fill" ? "gap_fill" : "multiple_choice";
  const text = (body.text ?? "").toString().trim();
  const options = Array.isArray(body.options)
    ? body.options.map((option) => option.toString().trim()).filter(Boolean)
    : [];
  const correctAnswers = Array.isArray(body.correctAnswers)
    ? body.correctAnswers.map((answer) => answer.toString().trim()).filter(Boolean)
    : body.correctAnswer != null
      ? [body.correctAnswer.toString().trim()]
      : [];
  const explanation = (body.explanation ?? "").toString().trim();
  const status = body.status === "draft" ? "draft" : "published";

  if (!id) throw new Error("Question id is required");
  if (!text) throw new Error("Question text is required");
  if (!["A1", "A2", "B1", "B2", "C1", "C2"].includes(level)) {
    throw new Error("Invalid level");
  }
  if (options.length < 2) throw new Error("At least two options are required");
  if (correctAnswers.length === 0) throw new Error("Correct answer is required");
  if (type === "gap_fill" && !text.includes("___")) {
    throw new Error('Gap-fill questions must include "___"');
  }
  for (const answer of correctAnswers) {
    if (!options.includes(answer)) {
      throw new Error(`Correct answer "${answer}" must be one of the options`);
    }
  }

  return {
    id,
    language,
    level,
    text,
    type,
    options,
    correctAnswers,
    explanation: explanation || buildSeedQuestionExplanation({ type, explanation }, correctAnswers),
    status,
    source: body.source?.toString().trim() || "admin",
    updatedAt: new Date(),
  };
}

function publicQuestionPayload(question) {
  return {
    id: question.id ?? question._id?.toString(),
    language: question.language,
    level: question.level,
    text: question.text,
    type: question.type ?? "multiple_choice",
    options: question.options ?? [],
    correctAnswers: question.correctAnswers ?? [],
    explanation: question.explanation ?? "",
    status: question.status ?? "published",
    source: question.source ?? "",
    createdAt: question.createdAt,
    updatedAt: question.updatedAt,
  };
}

function publicAdminUserPayload(user) {
  const ban = getActiveBan(user);
  return {
    userId: user._id.toString(),
    email: user.email ?? "",
    name: user.name ?? "Unknown",
    rating: typeof user.rating === "number" ? user.rating : 1000,
    role: user.role ?? "user",
    banned: Boolean(ban),
    banReason: user.banReason ?? "",
    bannedAt: user.bannedAt ?? null,
    bannedUntil: user.bannedUntil ?? null,
    createdAt: user.createdAt ?? null,
    lastSeen: user.lastSeen ?? null,
  };
}

function publicReportedPlayerPayload(row, user) {
  const userPayload = user ? publicAdminUserPayload(user) : null;
  return {
    userId: row._id?.toString() ?? "",
    reportCount: row.reportCount ?? 0,
    latestReason: row.latestReason ?? "",
    latestReportedAt: row.latestReportedAt ?? null,
    user: userPayload ?? {
      userId: row._id?.toString() ?? "",
      email: "",
      name: "Unknown player",
      rating: 1000,
      role: "user",
      banned: false,
      banReason: "",
      bannedAt: null,
      bannedUntil: null,
      createdAt: null,
      lastSeen: null,
    },
  };
}

function publicReportedQuestionPayload(row, question) {
  const fallbackQuestion = row.latestQuestion
    ? {
        id: row._id?.toString() ?? "",
        language: row.latestQuestion.language,
        level: row.latestQuestion.level,
        text: row.latestQuestion.text || row._id?.toString() || "",
        type: row.latestQuestion.type || "multiple_choice",
        options: Array.isArray(row.latestQuestion.options)
          ? row.latestQuestion.options
          : [],
        correctAnswers: Array.isArray(row.latestQuestion.correctAnswers)
          ? row.latestQuestion.correctAnswers
          : [],
        explanation: row.latestQuestion.explanation || "",
        timeLimit: row.latestQuestion.timeLimit ?? 15,
        status: "reported",
        source: "report_snapshot",
        createdAt: null,
        updatedAt: null,
      }
    : null;

  return {
    questionId: row._id?.toString() ?? "",
    reportCount: row.reportCount ?? 0,
    latestReason: row.latestReason ?? "",
    latestReportedAt: row.latestReportedAt ?? null,
    question: question ? publicQuestionPayload(question) : fallbackQuestion,
  };
}

async function loadReportedPlayers(limit = 100) {
  const rows = await db.collection("player_reports").aggregate([
    { $match: { reportedUserId: { $exists: true, $ne: "" } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$reportedUserId",
        reportCount: { $sum: 1 },
        latestReason: { $first: "$reason" },
        latestReportedAt: { $first: "$createdAt" },
      },
    },
    { $sort: { reportCount: -1, latestReportedAt: -1 } },
    { $limit: limit },
  ]).toArray();

  const objectIds = rows
    .map((row) => row._id?.toString())
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
  const usersById = new Map();
  if (objectIds.length > 0) {
    const reportedUsers = await users.find({ _id: { $in: objectIds } }).toArray();
    for (const user of reportedUsers) {
      usersById.set(user._id.toString(), user);
    }
  }

  return rows.map((row) =>
    publicReportedPlayerPayload(row, usersById.get(row._id?.toString()))
  );
}

async function loadReportedQuestions(limit = 100) {
  const rows = await db.collection("question_reports").aggregate([
    {
      $project: {
        questionId: {
          $ifNull: [
            "$questionId",
            { $ifNull: ["$reportedQuestionId", "$question.id"] },
          ],
        },
        question: 1,
        reason: 1,
        createdAt: 1,
      },
    },
    { $match: { questionId: { $exists: true, $ne: "" } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$questionId",
        reportCount: { $sum: 1 },
        latestReason: { $first: "$reason" },
        latestReportedAt: { $first: "$createdAt" },
        latestQuestion: { $first: "$question" },
      },
    },
    { $sort: { reportCount: -1, latestReportedAt: -1 } },
    { $limit: limit },
  ]).toArray();

  const questionIds = rows.map((row) => row._id?.toString()).filter(Boolean);
  const questionsById = new Map();
  if (questionIds.length > 0) {
    const reportedQuestions = await db.collection("questions")
      .find({ id: { $in: questionIds } })
      .toArray();
    for (const question of reportedQuestions) {
      questionsById.set(question.id, question);
    }
  }

  return rows.map((row) =>
    publicReportedQuestionPayload(row, questionsById.get(row._id?.toString()))
  );
}

function disconnectUserSessions(userId, reason) {
  const key = userId.toString();
  const sockets = userSockets.get(key) ?? new Set();
  for (const socket of sockets) {
    socket.emit("account_banned", { reason });
    socket.disconnect(true);
  }
  userSockets.delete(key);
}

function buildSeedQuestionExplanation(question, correctAnswers) {
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

function normalizeSeedQuestion(question) {
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
    explanation: buildSeedQuestionExplanation(question, correctAnswers),
    source: "classic_seed_questions",
  };
}

async function seedClassicQuestions() {
  if (!db || CLASSIC_SEED_QUESTIONS.length === 0) return;

  const questions = db.collection("questions");
  await questions.createIndex({ language: 1, level: 1 });
  await questions.createIndex(
    { id: 1 },
    {
      unique: true,
      partialFilterExpression: { id: { $exists: true } },
    }
  );

  const seedQuestions = CLASSIC_SEED_QUESTIONS
    .map(normalizeSeedQuestion)
    .filter((question) =>
      question.id &&
      question.text &&
      question.options.length > 0 &&
      question.correctAnswers.length > 0
    );

  if (seedQuestions.length === 0) return;

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

  const inserted = result.upsertedCount ?? 0;
  if (inserted > 0) {
    console.log(`Seeded ${inserted} classic questions`);
  }
}

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin", "index.html"));
});

app.post("/admin/api/login", async (req, res) => {
  try {
    if (!users) return res.status(503).json({ error: "Server is starting up" });

    const email = req.body?.email?.toString().trim().toLowerCase();
    const password = req.body?.password?.toString() ?? "";
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await users.findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    if (!isAdminUser(user)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const ban = getActiveBan(user);
    if (ban) return res.status(403).json({ error: ban.reason });

    const token = jwt.sign(
      { userId: user._id.toString(), admin: true },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({ token, user: adminUserPayload(user) });
  } catch (err) {
    console.error("admin login error", err);
    res.status(500).json({ error: "Could not log in" });
  }
});

app.get("/admin/api/me", requireAdmin, (req, res) => {
  res.json({ user: adminUserPayload(req.adminUser) });
});

app.get("/admin/api/dashboard", requireAdmin, async (_req, res) => {
  try {
    const now = new Date();
    const [
      totalUsers,
      totalQuestions,
      publishedQuestions,
      draftQuestions,
      activeRooms,
      playerReports,
      questionReports,
      reportedPlayers,
      reportedQuestions,
    ] = await Promise.all([
      users.countDocuments(),
      db.collection("questions").countDocuments(),
      db.collection("questions").countDocuments({
        $or: [{ status: "published" }, { status: { $exists: false } }],
      }),
      db.collection("questions").countDocuments({ status: "draft" }),
      db.collection("active_rooms").countDocuments({ expiresAt: { $gt: now } }),
      db.collection("player_reports").countDocuments(),
      db.collection("question_reports").countDocuments(),
      loadReportedPlayers(5),
      loadReportedQuestions(5),
    ]);

    res.json({
      stats: {
        activeUsers: getOnlineCount(),
        totalUsers,
        totalQuestions,
        publishedQuestions,
        draftQuestions,
        activeRooms,
        playerReports,
        questionReports,
        reportedPlayers: reportedPlayers.length,
        reportedQuestions: reportedQuestions.length,
      },
      reportedPlayers,
      reportedQuestions,
    });
  } catch (err) {
    console.error("admin dashboard error", err);
    res.status(500).json({ error: "Could not load dashboard" });
  }
});

app.get("/admin/api/questions", requireAdmin, async (req, res) => {
  try {
    const filter = {};
    const language = req.query.language?.toString();
    const level = req.query.level?.toString();
    const type = req.query.type?.toString();
    const status = req.query.status?.toString();
    const search = req.query.q?.toString().trim();
    const missingExplanation = req.query.missingExplanation === "true";

    if (language) filter.language = normalizeLanguage(language);
    if (level) filter.level = level.toUpperCase();
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (missingExplanation) {
      filter.$or = [
        { explanation: { $exists: false } },
        { explanation: null },
        { explanation: "" },
      ];
    }
    if (search) {
      filter.$and = [
        ...(filter.$and ?? []),
        {
          $or: [
            { id: { $regex: escapeRegex(search), $options: "i" } },
            { text: { $regex: escapeRegex(search), $options: "i" } },
          ],
        },
      ];
    }

    const questions = await db.collection("questions")
      .find(filter)
      .sort({ language: 1, level: 1, type: 1, text: 1 })
      .limit(200)
      .toArray();

    res.json({ questions: questions.map(publicQuestionPayload) });
  } catch (err) {
    console.error("admin list questions error", err);
    res.status(500).json({ error: "Could not load questions" });
  }
});

app.post("/admin/api/questions", requireAdmin, async (req, res) => {
  try {
    const question = normalizeAdminQuestionPayload(req.body ?? {});
    await db.collection("questions").updateOne(
      { id: question.id },
      {
        $set: question,
        $setOnInsert: {
          createdAt: new Date(),
          createdBy: req.adminUser._id,
        },
      },
      { upsert: true }
    );
    const saved = await db.collection("questions").findOne({ id: question.id });
    res.json({ question: publicQuestionPayload(saved) });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not save question" });
  }
});

app.delete("/admin/api/questions/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id?.toString();
    const result = await db.collection("questions").deleteOne({ id });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    console.error("admin delete question error", err);
    res.status(500).json({ error: "Could not delete question" });
  }
});

app.get("/admin/api/users", requireAdmin, async (req, res) => {
  try {
    const q = req.query.q?.toString().trim();
    const filter = q
      ? {
          $or: [
            { email: { $regex: escapeRegex(q), $options: "i" } },
            { name: { $regex: escapeRegex(q), $options: "i" } },
          ],
        }
      : {};
    const rows = await users
      .find(filter)
      .project({
        email: 1,
        name: 1,
        rating: 1,
        role: 1,
        banned: 1,
        banReason: 1,
        bannedAt: 1,
        bannedUntil: 1,
        createdAt: 1,
        lastSeen: 1,
      })
      .sort({ lastSeen: -1, createdAt: -1 })
      .limit(100)
      .toArray();

    res.json({ users: rows.map(publicAdminUserPayload) });
  } catch (err) {
    console.error("admin list users error", err);
    res.status(500).json({ error: "Could not load users" });
  }
});

app.get("/admin/api/reports/players", requireAdmin, async (_req, res) => {
  try {
    const reports = await loadReportedPlayers(100);
    res.json({ reports });
  } catch (err) {
    console.error("admin player reports error", err);
    res.status(500).json({ error: "Could not load player reports" });
  }
});

app.get("/admin/api/reports/questions", requireAdmin, async (_req, res) => {
  try {
    const reports = await loadReportedQuestions(100);
    res.json({ reports });
  } catch (err) {
    console.error("admin question reports error", err);
    res.status(500).json({ error: "Could not load question reports" });
  }
});

app.patch("/admin/api/users/:id/ban", requireAdmin, async (req, res) => {
  try {
    const userId = new ObjectId(req.params.id);
    if (userId.toString() === req.adminUser._id.toString()) {
      return res.status(400).json({ error: "You cannot ban yourself" });
    }

    const reason = req.body?.reason?.toString().trim() || "Account suspended";
    const bannedUntilRaw = req.body?.bannedUntil?.toString().trim();
    const bannedUntil = bannedUntilRaw ? new Date(bannedUntilRaw) : null;
    if (bannedUntilRaw && Number.isNaN(bannedUntil.getTime())) {
      return res.status(400).json({ error: "Invalid ban end date" });
    }

    await users.updateOne(
      { _id: userId },
      {
        $set: {
          banned: true,
          banReason: reason,
          bannedAt: new Date(),
          bannedUntil,
          bannedBy: req.adminUser._id,
        },
      }
    );
    disconnectUserSessions(userId, reason);
    const updated = await users.findOne({ _id: userId });
    res.json({ user: publicAdminUserPayload(updated) });
  } catch (err) {
    res.status(400).json({ error: "Could not ban user" });
  }
});

app.patch("/admin/api/users/:id/unban", requireAdmin, async (req, res) => {
  try {
    const userId = new ObjectId(req.params.id);
    await users.updateOne(
      { _id: userId },
      {
        $set: { banned: false },
        $unset: {
          banReason: "",
          bannedAt: "",
          bannedUntil: "",
          bannedBy: "",
        },
      }
    );
    const updated = await users.findOne({ _id: userId });
    res.json({ user: publicAdminUserPayload(updated) });
  } catch (err) {
    res.status(400).json({ error: "Could not unban user" });
  }
});

async function connectDB() {
  try {
    await client.connect();
    db = client.db("langbattle");

    // Check if collection exists
    const collections = await db.listCollections({ name: "users" }).toArray();
    if (collections.length === 0) {
      await db.createCollection("users", {
        validator: {
          $jsonSchema: {
            bsonType: "object",
            // Keep legacy single rating required for now for backwards compatibility
            required: ["email", "passwordHash", "rating", "createdAt"],
            properties: {
              email: { bsonType: "string", pattern: "^.+@.+\\..+$" },
              passwordHash: { bsonType: "string" },
              name: { bsonType: "string", minLength: 3, maxLength: 20 },
              // Global rating (e.g. overall or default language)
              rating: { bsonType: "int", minimum: 0 },
              // Per-language ratings; keys are optional so old documents still validate
              ratings: {
                bsonType: "object",
                properties: {
                  english: { bsonType: "int", minimum: 0 },
                  german: { bsonType: "int", minimum: 0 },
                  french: { bsonType: "int", minimum: 0 },
                },
                additionalProperties: false,
              },
              friends: {
                bsonType: "array",
                items: { bsonType: "objectId" },
              },
              createdAt: { bsonType: "date" },
              lastSeen: { bsonType: "date" },
              winStreak: { bsonType: "int", minimum: 0 }
            }
          }
        }
      });
      console.log("Created 'users' collection with validation (with per-language ratings)");
    }

    users = db.collection("users");
    await users.createIndex({ email: 1 }, { unique: true });

    // Friend requests collection (for notifications)
    friendRequests = db.collection("friend_requests");
    await friendRequests.createIndex({ to: 1, status: 1 });
    await friendRequests.createIndex({ from: 1, to: 1, status: 1 }, { unique: false });
    await db.collection("active_rooms").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection("player_reports").createIndex({ reportedUserId: 1, createdAt: -1 });
    await db.collection("question_reports").createIndex({ questionId: 1, createdAt: -1 });
    await seedClassicQuestions();

    console.log("MongoDB connected");

  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

async function getRandomQuestions(language, level, count = 4) {
  if (!db) return { questions: [], language, level };
  const languageRegex = new RegExp(`^${escapeRegex(language)}$`, "i");
  const questions = await db.collection("questions").aggregate([
    {
      $match: {
        language: languageRegex,
        level,
        $or: [{ status: "published" }, { status: { $exists: false } }],
      },
    },
    { $sample: { size: count } }
  ]).toArray();
  return {
    questions,
    language,
    level,
  };
}

/** Fallback when DB has no questions (e.g. empty collection or wrong language/level) */
function getFallbackQuestions(language) {
  const lang = normalizeLanguage(language);
  if (lang === "french") {
    return [
      { id: "fb1", text: "What is 'hello' in French?", options: ["Bonjour", "Hallo", "Ciao", "Hi"], timeLimit: 15, correctAnswer: "Bonjour" },
      { id: "fb2", text: "What is 'thank you' in French?", options: ["Merci", "Bitte", "Danke", "Yes"], timeLimit: 15, correctAnswer: "Merci" },
      { id: "fb3", text: "What is 'water' in French?", options: ["Eau", "Wasser", "Milk", "Kaffee"], timeLimit: 15, correctAnswer: "Eau" },
      { id: "fb4", text: "What is 'book' in French?", options: ["Livre", "Buch", "Table", "Maison"], timeLimit: 15, correctAnswer: "Livre" },
      { id: "fb5", text: "What is 'goodbye' in French?", options: ["Au revoir", "Tschüss", "Hello", "Danke"], timeLimit: 15, correctAnswer: "Au revoir" },
    ];
  }
  if (lang === "german") {
    return [
      { id: "fb1", text: "What is 'hello' in German?", options: ["Hallo", "Bonjour", "Ciao", "Hi"], timeLimit: 15, correctAnswer: "Hallo" },
      { id: "fb2", text: "What is 'thank you' in German?", options: ["Danke", "Bitte", "Tschüss", "Ja"], timeLimit: 15, correctAnswer: "Danke" },
      { id: "fb3", text: "What is 'water' in German?", options: ["Wasser", "Brot", "Milch", "Kaffee"], timeLimit: 15, correctAnswer: "Wasser" },
      { id: "fb4", text: "What is 'book' in German?", options: ["Buch", "Stuhl", "Tisch", "Haus"], timeLimit: 15, correctAnswer: "Buch" },
      { id: "fb5", text: "What is 'goodbye' in German?", options: ["Tschüss", "Hallo", "Danke", "Bitte"], timeLimit: 15, correctAnswer: "Tschüss" },
    ];
  }
  // english (default)
  return [
    { id: "fb1", text: "Which word means 'hello'?", options: ["Hello", "Thanks", "Book", "Water"], timeLimit: 15, correctAnswer: "Hello" },
    { id: "fb2", text: "Which word means 'thank you'?", options: ["Thanks", "Goodbye", "Yes", "No"], timeLimit: 15, correctAnswer: "Thanks" },
    { id: "fb3", text: "Which word means 'water'?", options: ["Water", "Milk", "Coffee", "Bread"], timeLimit: 15, correctAnswer: "Water" },
    { id: "fb4", text: "Which word means 'book'?", options: ["Book", "Table", "Chair", "House"], timeLimit: 15, correctAnswer: "Book" },
    { id: "fb5", text: "Which word means 'goodbye'?", options: ["Goodbye", "Hello", "Thanks", "Please"], timeLimit: 15, correctAnswer: "Goodbye" },
  ];
}

connectDB();


function ratingToLevel(rating) {
  if (rating < 400) return "A1";
  if (rating < 700) return "A2";
  if (rating < 1000) return "B1";
  if (rating < 1400) return "B2";
  if (rating < 1800) return "C1";
  return "C2";
}

function calculateElo(ratingA, ratingB, scoreA, K = 32) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  return {
    newA: Math.round(ratingA + K * (scoreA - expectedA)),
    newB: Math.round(ratingB + K * (scoreB - expectedB)),
  };
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
