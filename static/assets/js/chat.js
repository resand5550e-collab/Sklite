const chatApi = "/chat/api";
const authView = document.getElementById("auth-view");
const chatView = document.getElementById("chat-view");
const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const chatError = document.getElementById("chat-error");
const authTabs = [...document.querySelectorAll(".auth-tab")];
const emailField = document.getElementById("email-field");
const authPassword = document.getElementById("auth-password");
const authSubmitLabel = document.getElementById("auth-submit-label");
const channelList = document.getElementById("channel-list");
const messagesElement = document.getElementById("messages");
const messageInput = document.getElementById("message-input");
const messageForm = document.getElementById("message-form");
const ownerClaimForm = document.getElementById("owner-claim-form");
const adminClaimForm = document.getElementById("admin-claim-form");
const channelForm = document.getElementById("channel-form");
const moderationPanel = document.getElementById("moderation-panel");
const moderationUser = document.getElementById("moderation-user");

let authMode = "login";
let currentUser = null;
let currentChannel = "general";
let messageCursor = 0;
let ownerAvailable = false;
let adminAvailable = false;
let onlineUsers = [];
let managedUsers = [];
let managedUsersAt = 0;
let pollTimer = null;
let pollInFlight = false;

async function requestChat(path, options = {}) {
  const response = await fetch(`${chatApi}${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
  return payload;
}

function showAuth(message = "") {
  currentUser = null;
  authView.hidden = false;
  chatView.hidden = true;
  authError.textContent = message;
  clearInterval(pollTimer);
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  emailField.hidden = !registering;
  document.getElementById("auth-email").required = false;
  authPassword.autocomplete = registering ? "new-password" : "current-password";
  authPassword.minLength = registering ? 10 : 1;
  authSubmitLabel.textContent = registering ? "Create account" : "Sign in";
  authTabs.forEach(tab => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  authError.textContent = "";
}

function roleLabel(role) {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "";
}

function showRoleControls() {
  const isOwner = currentUser?.role === "owner";
  const isModerator = isOwner || currentUser?.role === "admin";
  document.querySelectorAll(".owner-only").forEach(element => {
    if (element.id === "moderation-panel") element.hidden = !isModerator;
    else if (element.id === "channel-form") element.hidden = !isOwner;
    else if (element.id === "delete-channel") element.hidden = !isOwner || currentChannel === "general";
    else if (element.dataset.moderation === "ban" || element.dataset.moderation === "role" || element.dataset.moderation === "unban") element.hidden = !isOwner;
  });
  const ownerSetupAvailable = ownerAvailable && currentUser?.role === "user";
  ownerClaimForm.hidden = !ownerSetupAvailable;
  adminClaimForm.hidden = !adminAvailable || currentUser?.role !== "user";
  document.getElementById("current-user").textContent = currentUser ? `${currentUser.username}${roleLabel(currentUser.role) ? ` · ${roleLabel(currentUser.role)}` : ""}` : "";
  document.getElementById("current-user").className = `current-user ${currentUser?.role || ""}`;
}

function renderChannels(channels) {
  channelList.replaceChildren();
  document.getElementById("channel-count").textContent = String(channels.length);
  for (const channel of channels) {
    const row = document.createElement("div");
    row.className = "channel-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `channel-button${channel.id === currentChannel ? " is-active" : ""}`;
    button.dataset.channelId = channel.id;
    const icon = document.createElement("i");
    icon.className = `fa-solid ${channel.private ? "fa-lock" : "fa-hashtag"}`;
    const label = document.createElement("span");
    label.textContent = channel.name;
    button.append(icon, label);
    row.append(button);
    if (currentUser?.role === "owner" && channel.id !== "general") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "channel-delete";
      remove.title = `Delete ${channel.name}`;
      remove.setAttribute("aria-label", `Delete ${channel.name}`);
      remove.dataset.deleteChannel = channel.id;
      remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      row.append(remove);
    }
    channelList.append(row);
  }
  showRoleControls();
}

function appendMessage(message) {
  const item = document.createElement("article");
  item.className = "chat-message";
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = (message.username || "?").slice(0, 1).toUpperCase();
  const content = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  name.className = `message-name ${message.role || ""}`;
  name.textContent = message.username;
  meta.append(name);
  const label = roleLabel(message.role);
  if (label) {
    const badge = document.createElement("span");
    badge.className = "role-tag";
    badge.textContent = label;
    meta.append(badge);
  }
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = new Date(message.createdAt).toISOString();
  time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  meta.append(time);
  const text = document.createElement("p");
  text.className = "message-text";
  text.textContent = message.text;
  content.append(meta, text);
  item.append(avatar, content);
  messagesElement.append(item);
}

function renderOnline(users) {
  onlineUsers = users;
  const list = document.getElementById("online-list");
  list.replaceChildren();
  document.getElementById("online-count").textContent = String(users.length);
  for (const user of users) {
    const item = document.createElement("li");
    item.className = "online-user";
    const dot = document.createElement("span");
    dot.className = "online-dot";
    const name = document.createElement("span");
    name.textContent = `${user.username}${roleLabel(user.role) ? ` · ${roleLabel(user.role)}` : ""}`;
    name.classList.add(user.role);
    item.append(dot, name);
    list.append(item);
  }
  if (currentUser?.role !== "owner") renderModerationUsers(users);
}

function renderModerationUsers(users) {
  const selected = moderationUser.value;
  moderationUser.replaceChildren();
  const candidates = users.filter(user => user.id !== currentUser?.id && user.role !== "owner" && (currentUser?.role === "owner" || user.role === "user"));
  for (const user of candidates) {
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = `${user.username}${user.role === "admin" ? " · Admin" : ""}${user.banned ? " · Banned" : ""}`;
    moderationUser.append(option);
  }
  if (candidates.some(user => user.id === selected)) moderationUser.value = selected;
  updateRoleAction();
}

function updateRoleAction() {
  const selected = managedUsers.find(user => user.id === moderationUser.value) || onlineUsers.find(user => user.id === moderationUser.value);
  const roleLabelElement = document.getElementById("role-action-label");
  if (roleLabelElement) roleLabelElement.textContent = selected?.role === "admin" ? "Remove admin" : "Make admin";
  const unban = document.querySelector('[data-moderation="unban"]');
  if (unban) unban.hidden = currentUser?.role !== "owner" || !selected?.banned;
}

async function refreshManagedUsers() {
  if (currentUser?.role !== "owner") {
    managedUsers = [];
    return;
  }
  try {
    managedUsers = (await requestChat("/users")).users;
    managedUsersAt = Date.now();
    renderModerationUsers(managedUsers);
  } catch (error) {
    chatError.textContent = error.message;
  }
}

function updateNotice(state) {
  const notice = document.getElementById("chat-notice");
  const isTimedOut = state.timeoutUntil > Date.now();
  const isKicked = state.kickedUntil > Date.now();
  const inputDisabled = isTimedOut || isKicked;
  messageInput.disabled = inputDisabled;
  messageForm.querySelector("button").disabled = inputDisabled;
  if (isTimedOut) notice.textContent = `You are timed out until ${new Date(state.timeoutUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
  else if (isKicked) notice.textContent = "You were kicked from this channel. You can return when the temporary restriction expires.";
  else notice.textContent = "";
}

function applyState(state, resetMessages) {
  currentUser = state.user;
  ownerAvailable = state.ownerAvailable;
  adminAvailable = state.adminAvailable;
  const visible = state.channels;
  if (!visible.some(channel => channel.id === currentChannel)) currentChannel = visible[0]?.id || "general";
  document.getElementById("active-channel").textContent = state.channel.name;
  document.getElementById("channel-kind").textContent = state.channel.private ? "PRIVATE CHANNEL" : "PUBLIC CHANNEL";
  if (resetMessages) {
    messagesElement.replaceChildren();
    messageCursor = 0;
  }
  for (const message of state.messages) {
    appendMessage(message);
    messageCursor = Math.max(messageCursor, message.id);
  }
  if (!messagesElement.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "empty-messages";
    empty.textContent = "No messages yet. Start the conversation.";
    messagesElement.append(empty);
  } else if (state.messages.length) {
    messagesElement.querySelector(".empty-messages")?.remove();
    messagesElement.scrollTop = messagesElement.scrollHeight;
  }
  renderChannels(visible);
  renderOnline(state.online);
  updateNotice(state);
  authView.hidden = true;
  chatView.hidden = false;
  showRoleControls();
  chatError.textContent = "";
}

async function pollChat(resetMessages = false) {
  if (pollInFlight || !currentUser) return;
  pollInFlight = true;
  try {
    const query = new URLSearchParams({ channel: currentChannel, after: String(resetMessages ? 0 : messageCursor) });
    const state = await requestChat(`/state?${query}`);
    applyState(state, resetMessages);
    if (currentUser.role === "owner" && Date.now() - managedUsersAt > 10000) await refreshManagedUsers();
  } catch (error) {
    if (error.message === "Please sign in to continue.") showAuth();
    else if (error.message === "That chat channel is unavailable." && currentChannel !== "general") {
      currentChannel = "general";
      messageCursor = 0;
      await pollChat(true);
    } else chatError.textContent = error.message;
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") pollChat();
  }, 3000);
}

async function enterChat(resetMessages = true) {
  authView.hidden = true;
  chatView.hidden = false;
  messageCursor = 0;
  managedUsers = [];
  await pollChat(resetMessages);
  startPolling();
}

async function submitAuth(event) {
  event.preventDefault();
  authError.textContent = "";
  const formData = new FormData(authForm);
  const body = {
    username: formData.get("username"),
    password: formData.get("password"),
  };
  if (authMode === "register") body.email = formData.get("email");
  try {
    const result = await requestChat(authMode === "register" ? "/register" : "/login", { method: "POST", body: JSON.stringify(body) });
    currentUser = result.user;
    currentChannel = "general";
    messageCursor = 0;
    await enterChat(true);
    authForm.reset();
  } catch (error) {
    authError.textContent = error.message;
  }
}

async function submitMessage(event) {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.disabled = true;
  try {
    const result = await requestChat("/messages", {
      method: "POST",
      body: JSON.stringify({ channelId: currentChannel, text }),
    });
    if (messagesElement.querySelector(".empty-messages")) messagesElement.replaceChildren();
    appendMessage(result.message);
    messageCursor = Math.max(messageCursor, result.message.id);
    messagesElement.scrollTop = messagesElement.scrollHeight;
    messageInput.value = "";
    chatError.textContent = "";
  } catch (error) {
    chatError.textContent = error.message;
  } finally {
    messageInput.disabled = false;
    messageInput.focus();
  }
}

async function submitOwnerClaim(event) {
  event.preventDefault();
  chatError.textContent = "";
  try {
    await requestChat("/owner/claim", {
      method: "POST",
      body: JSON.stringify({ code: document.getElementById("owner-code").value }),
    });
    document.getElementById("owner-code").value = "";
    await pollChat(true);
    await refreshManagedUsers();
  } catch (error) {
    chatError.textContent = error.message;
  }
}

async function submitAdminClaim(event) {
  event.preventDefault();
  chatError.textContent = "";
  try {
    await requestChat("/admin/claim", {
      method: "POST",
      body: JSON.stringify({ code: document.getElementById("admin-code").value }),
    });
    document.getElementById("admin-code").value = "";
    await pollChat(true);
  } catch (error) {
    chatError.textContent = error.message;
  }
}

async function submitChannel(event) {
  event.preventDefault();
  const name = document.getElementById("channel-name").value.trim();
  const isPrivate = document.getElementById("channel-private").checked;
  const members = document
    .getElementById("channel-members")
    .value.split(",")
    .map(value => value.trim())
    .filter(Boolean);
  try {
    const result = await requestChat("/channels", {
      method: "POST",
      body: JSON.stringify({ name, private: isPrivate, members }),
    });
    channelForm.reset();
    document.getElementById("channel-members-field").hidden = true;
    currentChannel = result.channel.id;
    channelForm.reset();
    await pollChat(true);
  } catch (error) {
    chatError.textContent = error.message;
  }
}

async function performModeration(action) {
  const target = managedUsers.find(user => user.id === moderationUser.value) || onlineUsers.find(user => user.id === moderationUser.value);
  if (!target) return;
  if (["ban", "kick"].includes(action) && !window.confirm(`${action === "ban" ? "Ban" : "Kick"} ${target.username}?`)) return;
  try {
    if (action === "role") {
      await requestChat(`/users/${target.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role: target.role === "admin" ? "user" : "admin" }),
      });
    } else if (action === "unban") {
      await requestChat(`/users/${target.id}/ban`, { method: "DELETE" });
    } else {
      await requestChat(`/users/${target.id}/moderation`, {
        method: "POST",
        body: JSON.stringify({ action, channelId: currentChannel, minutes: 5 }),
      });
    }
    chatError.textContent = "";
    await refreshManagedUsers();
    await pollChat();
  } catch (error) {
    chatError.textContent = error.message;
  }
}

authTabs.forEach(tab => {
  tab.addEventListener("click", () => setAuthMode(tab.dataset.mode));
});
authForm.addEventListener("submit", submitAuth);
messageForm.addEventListener("submit", submitMessage);
ownerClaimForm.addEventListener("submit", submitOwnerClaim);
adminClaimForm.addEventListener("submit", submitAdminClaim);
channelForm.addEventListener("submit", submitChannel);
document.getElementById("channel-private").addEventListener("change", event => {
  document.getElementById("channel-members-field").hidden = !event.target.checked;
});
channelList.addEventListener("click", async event => {
  const deleteButton = event.target.closest("[data-delete-channel]");
  if (deleteButton) {
    const channelId = deleteButton.dataset.deleteChannel;
    if (!window.confirm("Delete this channel and its messages?")) return;
    try {
      const result = await requestChat(`/channels/${channelId}`, { method: "DELETE" });
      currentChannel = result.channels[0]?.id || "general";
      await pollChat(true);
    } catch (error) {
      chatError.textContent = error.message;
    }
    return;
  }
  const channelButton = event.target.closest("[data-channel-id]");
  if (!channelButton || channelButton.dataset.channelId === currentChannel) return;
  currentChannel = channelButton.dataset.channelId;
  chatError.textContent = "";
  await pollChat(true);
});
document.querySelectorAll("[data-moderation]").forEach(button => {
  button.addEventListener("click", () => performModeration(button.dataset.moderation));
});
moderationUser.addEventListener("change", updateRoleAction);
document.getElementById("delete-channel").addEventListener("click", async () => {
  if (currentChannel === "general" || !window.confirm("Delete this channel and its messages?")) return;
  try {
    const result = await requestChat(`/channels/${currentChannel}`, { method: "DELETE" });
    currentChannel = result.channels[0]?.id || "general";
    await pollChat(true);
  } catch (error) {
    chatError.textContent = error.message;
  }
});
document.getElementById("signout-button").addEventListener("click", async () => {
  await requestChat("/logout", { method: "POST" }).catch(() => {});
  showAuth();
});

async function restoreSession() {
  try {
    const state = await requestChat("/state?channel=general&after=0");
    currentChannel = state.channel.id;
    applyState(state, true);
    startPolling();
  } catch (error) {
    showAuth(error.message === "Please sign in to continue." ? "" : error.message);
  }
}

setAuthMode("login");
restoreSession();
