import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const DATA_PATH = path.resolve(process.env.CHAT_DATA_PATH || path.join(process.cwd(), "data", "community-chat.json"));
const SESSION_COOKIE = "sklite_chat_session";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const ONLINE_TTL = 60 * 1000;
const MESSAGE_LIMIT = 500;
const MAX_MESSAGES = 5000;
const sessions = new Map();
const presence = new Map();
const limits = new Map();

class ChatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function emptyStore() {
  return {
    users: [],
    channels: [{ id: "general", name: "General", private: false, members: [], createdAt: Date.now() }],
    messages: [],
    bans: [],
    timeouts: [],
    kicks: [],
    nextMessageId: 1,
  };
}

function loadStore() {
  try {
    const store = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    if (!Array.isArray(store.users) || !Array.isArray(store.channels) || !Array.isArray(store.messages)) {
      throw new Error("Chat data has an invalid format.");
    }
    if (!store.channels.some(channel => channel.id === "general")) {
      store.channels.unshift({ id: "general", name: "General", private: false, members: [], createdAt: Date.now() });
    }
    store.bans = Array.isArray(store.bans) ? store.bans : [];
    store.timeouts = Array.isArray(store.timeouts) ? store.timeouts : [];
    store.kicks = Array.isArray(store.kicks) ? store.kicks : [];
    store.nextMessageId = Number.isSafeInteger(store.nextMessageId) ? store.nextMessageId : 1;
    return store;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyStore();
  }
}

const store = loadStore();

function saveStore() {
  mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  const temporaryPath = `${DATA_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(store), { mode: 0o600 });
  renameSync(temporaryPath, DATA_PATH);
}

function normalizeUsername(username) {
  return typeof username === "string" ? username.trim().toLowerCase() : "";
}

function publicUser(user, includeEmail = false) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    ...(includeEmail ? { email: user.email || "" } : {}),
  };
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function issueSession(req, res, user) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });
  setSessionCookie(req, res, token);
}

function requireUser(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    throw new ChatError(401, "Please sign in to continue.");
  }
  const user = store.users.find(candidate => candidate.id === session.userId);
  if (!user) throw new ChatError(401, "Please sign in to continue.");
  if (store.bans.some(ban => ban.userId === user.id)) {
    sessions.delete(token);
    throw new ChatError(403, "This account is banned from the community chat.");
  }
  return user;
}

function isOwner(user) {
  return user.role === "owner";
}

function requireModerator(user) {
  if (user.role !== "owner" && user.role !== "admin") throw new ChatError(403, "Moderator access required.");
}

function requireOwner(user) {
  if (!isOwner(user)) throw new ChatError(403, "Owner access required.");
}

function consumeLimit(key, maximum, windowMs) {
  const now = Date.now();
  const current = limits.get(key);
  if (!current || current.expiresAt <= now) {
    limits.set(key, { count: 1, expiresAt: now + windowMs });
    return true;
  }
  current.count++;
  return current.count <= maximum;
}

function requireLimit(key, maximum, windowMs, message) {
  if (!consumeLimit(key, maximum, windowMs)) throw new ChatError(429, message);
}

function validConfiguredCode(value, environmentVariable) {
  const configured = process.env[environmentVariable];
  if (!configured || typeof value !== "string") return false;
  const expected = createHash("sha256").update(configured).digest();
  const actual = createHash("sha256").update(value).digest();
  return timingSafeEqual(expected, actual);
}

function validOwnerCode(value) {
  return validConfiguredCode(value, "CHAT_OWNER_CODE");
}

function visibleChannels(user) {
  return store.channels
    .filter(channel => !channel.private || isOwner(user) || channel.members.includes(user.id))
    .map(channel => ({
      id: channel.id,
      name: channel.name,
      private: channel.private,
      memberCount: channel.private ? channel.members.length : null,
    }));
}

function getChannel(user, id) {
  const channel = store.channels.find(candidate => candidate.id === id);
  if (!channel || (channel.private && !isOwner(user) && !channel.members.includes(user.id))) {
    throw new ChatError(404, "That chat channel is unavailable.");
  }
  return channel;
}

function cleanExpiredModeration() {
  const now = Date.now();
  store.timeouts = store.timeouts.filter(timeout => timeout.until > now);
  store.kicks = store.kicks.filter(kick => kick.until > now);
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof ChatError) {
        res.status(error.status).json({ error: error.message });
      } else {
        console.error("Community chat error:", error);
        res.status(500).json({ error: "The chat request could not be completed." });
      }
    }
  };
}

export function mountCommunityChat(app) {
  app.post(
    "/chat/api/register",
    wrap(async (req, res) => {
      requireLimit(`auth:${req.ip}`, 8, 15 * 60 * 1000, "Too many sign-in attempts. Try again later.");
      const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
      const normalizedUsername = normalizeUsername(username);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
      if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) throw new ChatError(400, "Usernames must be 3 to 24 letters, numbers, underscores, or hyphens.");
      if (password.length < 10 || password.length > 128) throw new ChatError(400, "Password must be between 10 and 128 characters.");
      if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ChatError(400, "Enter a valid email address or leave it blank.");
      if (store.users.some(user => normalizeUsername(user.username) === normalizedUsername)) throw new ChatError(409, "That username is already taken.");

      const salt = randomBytes(16).toString("hex");
      const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
      if (store.users.some(user => normalizeUsername(user.username) === normalizedUsername)) throw new ChatError(409, "That username is already taken.");
      const user = {
        id: randomUUID(),
        username,
        email,
        role: "user",
        salt,
        passwordHash,
        createdAt: Date.now(),
      };
      store.users.push(user);
      saveStore();
      issueSession(req, res, user);
      res.status(201).json({ user: publicUser(user, true), channels: visibleChannels(user) });
    }),
  );

  app.post(
    "/chat/api/login",
    wrap(async (req, res) => {
      requireLimit(`auth:${req.ip}`, 8, 15 * 60 * 1000, "Too many sign-in attempts. Try again later.");
      const username = normalizeUsername(req.body?.username);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const user = store.users.find(candidate => normalizeUsername(candidate.username) === username);
      if (!user || password.length > 128) throw new ChatError(401, "Username or password is incorrect.");
      const actual = await scrypt(password, user.salt, 64);
      const expected = Buffer.from(user.passwordHash, "hex");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ChatError(401, "Username or password is incorrect.");
      if (store.bans.some(ban => ban.userId === user.id)) throw new ChatError(403, "This account is banned from the community chat.");
      issueSession(req, res, user);
      res.json({ user: publicUser(user, true), channels: visibleChannels(user) });
    }),
  );

  app.post(
    "/chat/api/logout",
    wrap(async (req, res) => {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) sessions.delete(token);
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
      res.json({ ok: true });
    }),
  );

  app.post(
    "/chat/api/owner/claim",
    wrap(async (req, res) => {
      const user = requireUser(req);
      if (!process.env.CHAT_OWNER_CODE) throw new ChatError(503, "Owner setup is not enabled on this server.");
      if (store.users.some(candidate => candidate.role === "owner")) throw new ChatError(409, "An owner account has already been claimed.");
      if (!validOwnerCode(req.body?.code)) throw new ChatError(403, "That owner code is not correct.");
      user.role = "owner";
      saveStore();
      res.json({ user: publicUser(user, true) });
    }),
  );

  app.post(
    "/chat/api/admin/claim",
    wrap(async (req, res) => {
      const user = requireUser(req);
      if (!store.users.some(candidate => candidate.role === "owner")) throw new ChatError(409, "The owner must finish setup before admin access can be claimed.");
      if (!process.env.CHAT_ADMIN_CODE) throw new ChatError(503, "Admin setup is not enabled on this server.");
      if (user.role !== "user") throw new ChatError(409, "This account already has a moderator role.");
      requireLimit(`admin-claim:${user.id}`, 5, 15 * 60 * 1000, "Too many admin setup attempts. Try again later.");
      if (!validConfiguredCode(req.body?.code, "CHAT_ADMIN_CODE")) throw new ChatError(403, "That admin code is not correct.");
      user.role = "admin";
      saveStore();
      res.json({ user: publicUser(user, true) });
    }),
  );

  app.get(
    "/chat/api/state",
    wrap(async (req, res) => {
      const user = requireUser(req);
      const channelId = typeof req.query.channel === "string" ? req.query.channel : "general";
      const channel = getChannel(user, channelId);
      cleanExpiredModeration();
      presence.set(user.id, { userId: user.id, seenAt: Date.now() });
      const after = Number.parseInt(req.query.after, 10) || 0;
      const isTimedOut = store.timeouts.some(timeout => timeout.userId === user.id && timeout.until > Date.now());
      const kick = store.kicks.find(item => item.userId === user.id && item.channelId === channel.id && item.until > Date.now());
      const messages = store.messages.filter(message => message.channelId === channel.id && message.id > after).slice(after ? 0 : -100);
      const online = [...presence.values()]
        .filter(item => item.seenAt > Date.now() - ONLINE_TTL)
        .map(item => store.users.find(candidate => candidate.id === item.userId))
        .filter(Boolean)
        .map(publicUser);
      res.set("Cache-Control", "no-store").json({
        user: publicUser(user, true),
        ownerAvailable: Boolean(process.env.CHAT_OWNER_CODE) && !store.users.some(candidate => candidate.role === "owner"),
        adminAvailable: Boolean(process.env.CHAT_ADMIN_CODE) && user.role === "user" && store.users.some(candidate => candidate.role === "owner"),
        channels: visibleChannels(user),
        channel: { id: channel.id, name: channel.name, private: channel.private },
        messages,
        online,
        timeoutUntil: isTimedOut ? store.timeouts.find(timeout => timeout.userId === user.id).until : 0,
        kickedUntil: kick?.until || 0,
      });
    }),
  );

  app.post(
    "/chat/api/messages",
    wrap(async (req, res) => {
      const user = requireUser(req);
      const channelId = typeof req.body?.channelId === "string" ? req.body.channelId : "";
      const channel = getChannel(user, channelId);
      cleanExpiredModeration();
      if (store.timeouts.some(timeout => timeout.userId === user.id && timeout.until > Date.now())) throw new ChatError(403, "You are timed out from chat.");
      if (store.kicks.some(kick => kick.userId === user.id && kick.channelId === channel.id && kick.until > Date.now())) throw new ChatError(403, "You were recently kicked from this channel.");
      requireLimit(`message:${user.id}`, 1, 800, "Please wait a moment before sending another message.");
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text || text.length > MESSAGE_LIMIT) throw new ChatError(400, `Messages must be between 1 and ${MESSAGE_LIMIT} characters.`);
      const message = {
        id: store.nextMessageId++,
        channelId: channel.id,
        userId: user.id,
        username: user.username,
        role: user.role,
        text,
        createdAt: Date.now(),
      };
      store.messages.push(message);
      if (store.messages.length > MAX_MESSAGES) store.messages.splice(0, store.messages.length - MAX_MESSAGES);
      saveStore();
      res.status(201).json({ message });
    }),
  );

  app.post(
    "/chat/api/channels",
    wrap(async (req, res) => {
      const user = requireUser(req);
      requireOwner(user);
      if (store.channels.length >= 50) throw new ChatError(400, "The server has reached its channel limit.");
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const isPrivate = req.body?.private === true;
      if (!/^[\p{L}\p{N}_ -]{2,32}$/u.test(name)) throw new ChatError(400, "Channel names must be 2 to 32 letters, numbers, spaces, hyphens, or underscores.");
      if (store.channels.some(channel => channel.name.toLowerCase() === name.toLowerCase())) throw new ChatError(409, "A channel with that name already exists.");
      const memberNames = Array.isArray(req.body?.members) ? req.body.members.slice(0, 50) : [];
      const members = new Set([user.id]);
      for (const memberName of memberNames) {
        const member = store.users.find(candidate => normalizeUsername(candidate.username) === normalizeUsername(memberName));
        if (!member) throw new ChatError(404, `No account was found for ${String(memberName).slice(0, 24)}.`);
        members.add(member.id);
      }
      const channel = {
        id: randomUUID(),
        name,
        private: isPrivate,
        members: isPrivate ? [...members] : [],
        createdAt: Date.now(),
      };
      store.channels.push(channel);
      saveStore();
      res.status(201).json({ channels: visibleChannels(user), channel: { id: channel.id, name: channel.name, private: channel.private } });
    }),
  );

  app.delete(
    "/chat/api/channels/:channelId",
    wrap(async (req, res) => {
      const user = requireUser(req);
      requireOwner(user);
      if (req.params.channelId === "general") throw new ChatError(400, "The General channel cannot be deleted.");
      const index = store.channels.findIndex(channel => channel.id === req.params.channelId);
      if (index < 0) throw new ChatError(404, "Channel not found.");
      store.channels.splice(index, 1);
      store.messages = store.messages.filter(message => message.channelId !== req.params.channelId);
      store.kicks = store.kicks.filter(kick => kick.channelId !== req.params.channelId);
      saveStore();
      res.json({ channels: visibleChannels(user) });
    }),
  );

  app.get(
    "/chat/api/users",
    wrap(async (req, res) => {
      const user = requireUser(req);
      requireOwner(user);
      res.json({ users: store.users.map(candidate => ({ ...publicUser(candidate), banned: store.bans.some(ban => ban.userId === candidate.id) })) });
    }),
  );

  app.patch(
    "/chat/api/users/:userId/role",
    wrap(async (req, res) => {
      const user = requireUser(req);
      requireOwner(user);
      const target = store.users.find(candidate => candidate.id === req.params.userId);
      if (!target || target.id === user.id || target.role === "owner") throw new ChatError(404, "That account cannot be changed.");
      if (req.body?.role !== "user" && req.body?.role !== "admin") throw new ChatError(400, "Choose user or admin.");
      target.role = req.body.role;
      saveStore();
      res.json({ user: publicUser(target) });
    }),
  );

  app.post(
    "/chat/api/users/:userId/moderation",
    wrap(async (req, res) => {
      const user = requireUser(req);
      requireModerator(user);
      const target = store.users.find(candidate => candidate.id === req.params.userId);
      if (!target || target.id === user.id || target.role === "owner" || (user.role === "admin" && target.role !== "user")) {
        throw new ChatError(404, "That account cannot be moderated.");
      }
      const action = req.body?.action;
      cleanExpiredModeration();
      if (action === "kick") {
        const channel = getChannel(user, typeof req.body?.channelId === "string" ? req.body.channelId : "general");
        store.kicks = store.kicks.filter(kick => kick.userId !== target.id || kick.channelId !== channel.id);
        store.kicks.push({ userId: target.id, channelId: channel.id, until: Date.now() + 10 * 60 * 1000 });
      } else if (action === "timeout") {
        const minutes = Math.min(1440, Math.max(1, Number.parseInt(req.body?.minutes, 10) || 5));
        store.timeouts = store.timeouts.filter(timeout => timeout.userId !== target.id);
        store.timeouts.push({ userId: target.id, until: Date.now() + minutes * 60 * 1000 });
      } else if (action === "ban" && isOwner(user)) {
        if (!store.bans.some(ban => ban.userId === target.id)) store.bans.push({ userId: target.id, at: Date.now() });
        for (const [token, session] of sessions) if (session.userId === target.id) sessions.delete(token);
      } else {
        throw new ChatError(403, "Admins may kick or time out users; only the owner may ban.");
      }
      saveStore();
      res.json({ ok: true });
    }),
  );

  app.delete(
    "/chat/api/users/:userId/ban",
    wrap(async (req, res) => {
      const user = requireUser(req);
      requireOwner(user);
      store.bans = store.bans.filter(ban => ban.userId !== req.params.userId);
      saveStore();
      res.json({ ok: true });
    }),
  );
}
