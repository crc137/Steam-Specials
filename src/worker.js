const SEARCH_URL = "https://store.steampowered.com/search/results/";
const HELP = "/start — subscribe to notifications\n/stop — unsubscribe\n/now — see what is free now";

function log(...args) { console.log(new Date().toISOString(), ...args); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function telegram(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) {
    const e = new Error(data.description || `Telegram ${method} failed`);
    e.error_code = data.error_code;
    e.parameters = data.parameters || {};
    throw e;
  }
  return data.result;
}

async function getState(env) {
  const raw = await env.STATE.get("state");
  if (!raw) return { users: [], seen: [] };
  try {
    const s = JSON.parse(raw);
    return { users: Array.isArray(s.users) ? s.users.map(String) : [], seen: Array.isArray(s.seen) ? s.seen.map(String) : [] };
  } catch { return { users: [], seen: [] }; }
}
async function saveState(env, state) {
  state.users = [...new Set(state.users.map(String))];
  state.seen = [...new Set(state.seen.map(String))];
  await env.STATE.put("state", JSON.stringify(state));
}

function parseGames(html) {
  const games = [];
  const rowRe = /<a[^>]*class=["'][^"']*search_result_row[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
  for (const match of html.matchAll(rowRe)) {
    const row = match[0];
    const id = row.match(/data-ds-appid=["']([^"']+)["']/i)?.[1];
    const block = row.match(/<div[^>]*class=["'][^"']*discount_block[^"']*["'][^>]*>/i)?.[0] || "";
    const price = block.match(/data-price-final=["']([^"']+)["']/i)?.[1];
    const discount = block.match(/data-discount=["']([^"']+)["']/i)?.[1];
    if (!id || price !== "0" || discount !== "100") continue;
    const titleRaw = row.match(/<div[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || `App ${id}`;
    const title = titleRaw.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    const src = row.match(/<img[^>]*src=["']([^"']+)["'][^>]*>/i)?.[1];
    const img = src ? src.replace("capsule_231x87", "header") : `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`;
    games.push({ appid: String(id), title, img, url: `https://store.steampowered.com/app/${id}/` });
  }
  return games;
}

async function fetchFree(env) {
  const url = new URL(SEARCH_URL);
  for (const [k, v] of Object.entries({ hwtype: 0, maxprice: "free", category1: 998, specials: 1, ndl: 1, json: 1, infinite: 1, start: 0, count: 100, cc: env.CC || "EE", l: env.LANG_STEAM || "english" })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" } });
  if (!res.ok) throw new Error(`Steam HTTP ${res.status}`);
  const data = await res.json();
  return parseGames(data.results_html || "");
}

function caption(game) { return `<b>${esc(game.title)}</b>\nFree on Steam — yours to keep forever.`; }
function keyboard(game) { return { inline_keyboard: [[{ text: "Get on Steam", url: game.url }]] }; }

async function sendGame(env, chatId, game) {
  try {
    await telegram(env, "sendPhoto", { chat_id: chatId, photo: game.img, caption: caption(game), parse_mode: "HTML", reply_markup: keyboard(game) });
  } catch (e) {
    if (e.error_code === 400 || String(e.message).toLowerCase().includes("bad request")) {
      await telegram(env, "sendMessage", { chat_id: chatId, text: caption(game), parse_mode: "HTML", reply_markup: keyboard(game), link_preview_options: { is_disabled: true } });
      return;
    }
    throw e;
  }
}

async function allowed(env, chat, from) {
  if (!chat) return false;
  if (chat.type === "private") return true;
  if (!from) return false;
  try {
    const m = await telegram(env, "getChatMember", { chat_id: chat.id, user_id: from.id });
    return m.status === "administrator" || m.status === "creator";
  } catch (e) {
    log("permission check failed", e.message);
    return false;
  }
}

async function addUser(env, id) {
  const s = await getState(env); const key = String(id);
  if (s.users.includes(key)) return false;
  s.users.push(key); await saveState(env, s); return true;
}
async function removeUser(env, id) {
  const s = await getState(env); const key = String(id);
  const had = s.users.includes(key);
  s.users = s.users.filter(x => x !== key); await saveState(env, s); return had;
}

async function handleMessage(env, message) {
  const chat = message.chat;
  const text = message.text || "";
  const command = (text.trim().split(/\s+/)[0] || "").toLowerCase().split("@")[0];
  if (!["/start", "/stop", "/now"].includes(command)) return;
  if (!(await allowed(env, chat, message.from))) return;

  if (command === "/start") {
    const added = await addUser(env, chat.id);
    await telegram(env, "sendMessage", { chat_id: chat.id, text: (added ? "Subscription activated. I'll notify you as soon as there's a free giveaway on Steam.\n\n" : "You are already subscribed.\n\n") + HELP, link_preview_options: { is_disabled: true } });
  } else if (command === "/stop") {
    const removed = await removeUser(env, chat.id);
    await telegram(env, "sendMessage", { chat_id: chat.id, text: removed ? "Unsubscribed." : "You were not subscribed." });
  } else if (command === "/now") {
    try {
      const games = await fetchFree(env);
      if (!games.length) { await telegram(env, "sendMessage", { chat_id: chat.id, text: "There are no free giveaways at the moment." }); return; }
      for (const game of games.slice(0, 10)) { await sendWithRetry(env, chat.id, game); await sleep(100); }
    } catch (e) {
      log("/now failed", e.message);
      await telegram(env, "sendMessage", { chat_id: chat.id, text: "Failed to check Steam right now." });
    }
  }
}

async function sendWithRetry(env, chatId, game) {
  try { await sendGame(env, chatId, game); }
  catch (e) {
    if (e.parameters?.retry_after) { await sleep(Number(e.parameters.retry_after) * 1000); await sendGame(env, chatId, game); }
    else throw e;
  }
}

async function broadcast(env, game) {
  const state = await getState(env);
  for (const chatId of state.users) {
    try { await sendWithRetry(env, chatId, game); }
    catch (e) {
      if (e.parameters?.migrate_to_chat_id) {
        const newId = String(e.parameters.migrate_to_chat_id);
        await removeUser(env, chatId); await addUser(env, newId);
        try { await sendWithRetry(env, newId, game); } catch (x) { log("migrated send failed", newId, x.message); }
      } else if (e.error_code === 403 || String(e.message).toLowerCase().includes("bot was blocked")) {
        await removeUser(env, chatId);
      } else { log("send failed", chatId, e.message); }
    }
    await sleep(50);
  }
}

async function checkSteam(env) {
  const games = await fetchFree(env);
  const state = await getState(env);
  const seen = new Set(state.seen);
  const fresh = games.filter(g => !seen.has(g.appid));
  if (!fresh.length) { log("Steam scan: no new free games"); return; }
  for (const g of fresh) { seen.add(g.appid); }
  state.seen = [...seen];
  await saveState(env, state);
  for (const game of fresh) { log(`new free: ${game.title} (${game.appid})`); await broadcast(env, game); }
}

async function initialScan(env) {
  const state = await getState(env);
  if (state.seen.length) return;
  const games = await fetchFree(env);
  state.seen = games.map(g => g.appid);
  await saveState(env, state);
  log(`Initial Steam scan: ${games.length} games`);
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") return new Response("Steam-Specials Worker OK", { status: 200 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!env.BOT_TOKEN || !env.STATE) return new Response("Worker is not configured", { status: 500 });
    try {
      const update = await request.json();
      if (update.message) await handleMessage(env, update.message);
      if (update.my_chat_member) {
        const u = update.my_chat_member; const chat = u.chat;
        if (chat.type !== "private") {
          const joined = ["member", "administrator", "creator"].includes(u.new_chat_member?.status);
          if (joined) await addUser(env, chat.id); else await removeUser(env, chat.id);
        }
      }
      return new Response("ok");
    } catch (e) { log("webhook error", e.stack || e.message); return new Response("ok"); }
  },
  async scheduled(event, env) {
    try { await initialScan(env); await checkSteam(env); }
    catch (e) { log("scheduled check failed", e.stack || e.message); }
  }
};
