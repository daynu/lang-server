//Websocket
const dotenv = require("dotenv");
dotenv.config();
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET
const http = require("http");
const app = require("express")();

const server = http.createServer(app);

app.get("/", (req, res) => {
  res.send("OK");
});

const io = new Server(server, {
  cors: { origin: "*" },
  methods: ["GET", "POST"],
  maxHttpBufferSize: 2e6,
});

const queuesByLanguage = {
  english: [],
  german: [],
  french: [],
};
let rooms = {};
const userSockets = new Map();

function normalizeLanguage(lang) {
  const v = (lang ?? "").toString().trim().toLowerCase();
  if (v === "en" || v === "english") return "english";
  if (v === "de" || v === "german" || v === "deutsch") return "german";
  if (v === "fr" || v === "french" || v === "français" || v === "francais") return "french";
  // default
  return "english";
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

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.emit("connected");

  // Player joins matchmaking queue
  socket.on("join_queue", async (data = {}) => {
    if (!socket.userName) {
      socket.emit("error_msg", "You must be authenticated to join the queue");
      return;
    }

    // Prevent same user from queuing on multiple devices
    const alreadyInQueue = Object.values(queuesByLanguage)
      .some(q => q.some(s => s.userId?.toString() === socket.userId?.toString()));

    if (alreadyInQueue) {
      socket.emit("error_msg", "You are already in a queue on another device");
      return;
    }

    // Prevent same user from being in an active room
    const alreadyInRoom = Object.values(rooms)
      .some(room => room.players?.some(p => p.userId?.toString() === socket.userId?.toString()));

    if (alreadyInRoom) {
      socket.emit("error_msg", "You are already in a game on another device");
      return;
    }

    const language = normalizeLanguage(data.language);
    socket.selectedLanguage = language;

    // Remove from any previous queue (if client re-joins)
    for (const lang of Object.keys(queuesByLanguage)) {
      queuesByLanguage[lang] = queuesByLanguage[lang].filter((s) => s !== socket);
    }

    const queue = queuesByLanguage[language] ?? (queuesByLanguage[language] = []);
    queue.push(socket);
    console.log("Player joined queue:", queue.length, "user:", socket.userName, "language:", language);

    // Match players when we have at least 2
    if (queue.length >= 2) {
      const p1 = queue.shift();
      const p2 = queue.shift();
      const roomId = Math.random().toString(36).substring(2, 8);
      let questionsPayload = { questions: [], language, level: "A1" };

      p1.join(roomId);
      p2.join(roomId);


      try {
        const langKey = language.toLowerCase();
        const r1 = (p1.ratings && p1.ratings[langKey]) || 1000;
        const r2 = (p2.ratings && p2.ratings[langKey]) || 1000;
        const avgRating = Math.round((r1 + r2) / 2);
        const level = ratingToLevel(avgRating);
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
          level: result.level
        };
      } catch (err) {
        console.error("Failed to fetch questions:", err);
        questionsPayload.questions = getFallbackQuestions(language);
      }

      rooms[roomId] = {
        players: [p1, p2],
        language,
        scores: { [p1.id]: 0, [p2.id]: 0 },
        finished: new Set(),
        questions: Object.fromEntries(
          questionsPayload.questions.map(q => [q.id, q.correctAnswers || (q.correctAnswer ? [q.correctAnswer] : [])])
        ),
      };

      await db.collection("active_rooms").insertOne({
        roomId,
        players: [
          { userId: p1.userId.toString(), socketId: p1.id, name: p1.userName, score: 0 },
          { userId: p2.userId.toString(), socketId: p2.id, name: p2.userName, score: 0 },
        ],
        questions: questionsPayload.questions,
        currentIndexes: {
          [p1.userId.toString()]: 0,
          [p2.userId.toString()]: 0,
        },
        finished: [],
        language,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min TTL
      });

      console.log("Match created:", roomId, "questions:", questionsPayload.questions.length);

      io.to(roomId).emit("match_found", {
        roomId,
        players: [
          { id: p1.id, userId: p1.userId?.toString(), name: p1.userName, avatarBase64: p1.avatarBase64 ?? null },
          { id: p2.id, userId: p2.userId?.toString(), name: p2.userName, avatarBase64: p2.avatarBase64 ?? null }
        ],
        ...questionsPayload
      });
    }
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
        questions: room.questions,
        myScore: me?.score ?? 0,
        opponentScore: opponent?.score ?? 0,
        opponentName: opponent?.name ?? "Opponent",
        myCurrentIndex: room.currentIndexes?.[userId] ?? 0,
        opponentFinished: room.finished?.includes(opponent?.userId),
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

  // Relay player actions (answers, moves, etc.)
  socket.on("player_event", async (data) => {
    let isCorrect = false;

    if (data.payload?.action === "answer") {
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

    // Broadcast modified event to opponents
    io.to(data.roomId).emit("player_event", data.payload);

    // Persist progress
    if (data.payload?.action === "answer" && socket.userId) {
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

    if (data.payload?.action === "finish" && socket.userId) {
      const userId = socket.userId.toString();
      await db.collection("active_rooms").updateOne(
        { roomId: data.roomId },
        { $addToSet: { finished: userId } }
      );

      const memRoom = rooms[data.roomId];
      if (memRoom) {
        memRoom.finished.add(socket.id);
        if (memRoom.finished.size >= 2) {
          resolveRoom(data.roomId);
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
          },
          friendsCount: meFriendsCount,
        });

        emitToUser(friend._id, "friend_added", {
          friend: {
            userId: meId.toString(),
            name: me.name,
            rating: meRating,
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
    for (const lang of Object.keys(queuesByLanguage)) {
      queuesByLanguage[lang] = queuesByLanguage[lang].filter((s) => s !== socket);
    }
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
        .project({ name: 1, rating: 1, friends: 1, avatarBase64: 1 })
        .limit(50)
        .toArray();

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
      const games = await db.collection("games")
        .find({ "players.userId": socket.userId })
        .sort({ playedAt: -1 })
        .limit(20)
        .toArray();

      socket.emit("game_history", {
        games: games.map(g => ({
          id: g._id.toString(),
          players: g.players.map(p => ({
            ...p,
            userId: p.userId.toString(),
          })),
          language: g.language,
          level: g.level,
          playedAt: g.playedAt,
        }))
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
        { projection: { name: 1, rating: 1, friends: 1 } }
      );
      const other = await users.findOne(
        { _id: request.from },
        { projection: { name: 1, rating: 1, friends: 1 } }
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

      emitToUser(request.to, "friend_added", {
        friend: {
          userId: request.from.toString(),
          name: other?.name || "Unknown",
          rating: otherRating,
        },
        friendsCount: meFriendsCount,
      });

      emitToUser(request.from, "friend_added", {
        friend: {
          userId: request.to.toString(),
          name: me?.name || "Unknown",
          rating: meRating,
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
        .project({ name: 1, rating: 1, avatarBase64: 1 })
        .toArray();

      socket.emit("friends_list", {
        friends: friendsDocs.map((u) => ({
          userId: u._id.toString(),
          name: u.name,
          rating:
            typeof u.rating === "number" && !isNaN(u.rating) ? u.rating : 1000,
          avatarBase64: u.avatarBase64 ?? null
        })),
        friendsCount: friendsDocs.length,
      });
    } catch (err) {
      console.error("get_friends error", err);
      socket.emit("error_msg", "Could not load friends");
    }
  });

  socket.on("register", async ({ email, password, name, language, startingRating }) => {
    try {
      if (!email || !password) {
        return socket.emit("error_msg", "Missing credentials");
      }

      const lang = normalizeLanguage(language ?? 'english');
      const rating = typeof startingRating === 'number' ? startingRating : 200;

      const ratings = {
        english: null,
        german: null,
        french: null,
        [lang]: rating,
      };

      const passwordHash = await bcrypt.hash(password, 10);

      now = new Date();

      const result = await users.insertOne({
        email,
        passwordHash,
        name,
        rating,
        ratings,
        friends: [],
        createdAt: now,
        lastSeen: now,
      });

      socket.userId = result.insertedId;
      socket.userName = name;
      socket.rating = rating;
      socket.ratings = ratings;

      socket.emit("register_success", {
        userId: socket.userId,
        name,
        rating,
        ratings,
        friendsCount: 0,
        createdAt: now,
        lastSeen: now,
        avatarBase64: null
      });

    } catch (err) {
      socket.emit("error_msg", "Email already exists");
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

    socket.rating = baseRating;

    await users.updateOne(
      { _id: user._id },
      { $set: { lastSeen: new Date() } }
    );

    socket.emit("login_success", {
      token,
      userId: user._id,
      name: user.name,
      rating: baseRating,
      ratings,
      friendsCount,
      createdAt: user.createdAt,
      lastSeen: user.lastSeen,
      avatarBase64: user.avatarBase64 ?? null
    });
  });


  // Handle disconnect
  socket.on("disconnect", () => {
    untrackSocketForUser(socket);
    io.emit('online_count', { count: getOnlineCount() });

    for (const lang of Object.keys(queuesByLanguage)) {
      queuesByLanguage[lang] = queuesByLanguage[lang].filter(s => s !== socket);
    }

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

      socket.userId = user._id;
      socket.userName = user.name;
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

      console.log("Auth OK for", user.name);
      console.log(getOnlineCount(), "users online");

      socket.emit("auth_success", {
        userId: user._id.toString(),
        name: user.name,
        rating: baseRating,
        ratings,
        friendsCount,
        createdAt: user.createdAt,
        lastSeen: user.lastSeen,
        avatarBase64: user.avatarBase64 ?? null,
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
  const { newA, newB } = calculateElo(r1, r2, scoreA);

  if (users && p1.userId && p2.userId) {
    try {
      const now = new Date();

      await users.updateOne({ _id: p1.userId }, {
        $set: { [`ratings.${langKey}`]: newA },
        $push: { ratingHistory: { rating: newA, language: langKey, date: now } }
      });
      await users.updateOne({ _id: p2.userId }, {
        $set: { [`ratings.${langKey}`]: newB },
        $push: { ratingHistory: { rating: newB, language: langKey, date: now } }
      });

      await db.collection("games").insertOne({
        players: [
          { userId: p1.userId, name: p1.userName, score: s1, ratingBefore: r1, ratingAfter: newA, avatarBase64: p1.avatarBase64 ?? null },
          { userId: p2.userId, name: p2.userName, score: s2, ratingBefore: r2, ratingAfter: newB, avatarBase64: p2.avatarBase64 ?? null },
        ],
        language: langKey,
        level: ratingToLevel(Math.round((r1 + r2) / 2)),
        playedAt: now,
      });

    } catch (err) {
      console.error("ELO update error:", err);
    }
  }

  if (p1.ratings) p1.ratings[langKey] = newA;
  if (p2.ratings) p2.ratings[langKey] = newB;

  p1.emit("rating_updated", { language: langKey, oldRating: r1, newRating: newA, delta: newA - r1, newLevel: ratingToLevel(newA) });
  p2.emit("rating_updated", { language: langKey, oldRating: r2, newRating: newB, delta: newB - r2, newLevel: ratingToLevel(newB) });

  console.log(`ELO updated: ${p1.userName} ${r1}→${newA}  ${p2.userName} ${r2}→${newB}`);
  delete rooms[roomId];
}



//database
const { MongoClient } = require("mongodb");
const bcrypt = require("bcrypt");
const { get } = require("mongoose");

const mongo_db_URI = process.env.mongo_db_URI;
console.log("Connecting to MongoDB at", mongo_db_URI);

const client = new MongoClient(mongo_db_URI);

let db;
let users;
let friendRequests;

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
              lastSeen: { bsonType: "date" }
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

    console.log("MongoDB connected");

  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

async function getRandomQuestions(language, level, count = 4) {
  if (!db) return { questions: [], language, level };
  const languageRegex = new RegExp(`^${escapeRegex(language)}$`, "i");
  const questions = await db.collection("questions").aggregate([
    { $match: { language: languageRegex, level } },
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
