#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { Bot, InlineKeyboard } = require("grammy");
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const INTERVAL = Number.parseInt(process.env.CHECK_INTERVAL || "600", 10);
const STATE_FILE = process.env.STATE_FILE || "state.json";
const CC = process.env.CC || "EE";
const LANG = process.env.LANG_STEAM || "english";
const SEARCH_URL = "https://store.steampowered.com/search/results/";
const PARAMS = {hwtype: 0,maxprice: "free",category1: 998,specials: 1,ndl: 1,json: 1,infinite: 1,start: 0,count: 100,cc: CC,l: LANG};
const HEADERS = {"User-Agent": "Mozilla/5.0","Accept-Language": "en-US,en;q=0.9"};
function logInfo(...args) {console.log(new Date().toISOString(),"INFO:",...args);}
function logWarn(...args) {console.warn(new Date().toISOString(),"WARNING:",...args);}
function logError(...args) {console.error(new Date().toISOString(),"ERROR:",...args);}
function sleep(ms) {return new Promise(resolve => setTimeout(resolve, ms));}
function isTelegramError(error, text) {return (error && typeof error.description === "string" && error.description.toLowerCase().includes(text.toLowerCase()));}
class State {
    constructor(filePath) {
        this.path = filePath;
        this.users = new Set();
        this.seen = new Set();
        this.lock = Promise.resolve();
        try {
            if (fs.existsSync(this.path)) {
                const raw = fs.readFileSync(this.path, "utf8");
                const data = JSON.parse(raw);

                for (const uid of data.users || []) {this.users.add(Number(uid));}
                for (const id of data.seen || []) {this.seen.add(String(id));}
            }
        } catch (error) {
            logError("Failed to read state file:", this.path);
            console.error(error);
        }
    }
    async withLock(fn) {
        const previous = this.lock;
        let release;
        this.lock = new Promise(resolve => {release = resolve;});
        await previous;
        try {return await fn();} finally {release();}
    }
    flush() {
        const dir = path.dirname(this.path);
        fs.mkdirSync(dir, {recursive: true});
        const tmp = this.path.replace(path.extname(this.path),".tmp");
        const data = {users: [...this.users].sort((a, b) => a - b),seen: [...this.seen].sort()};
        fs.writeFileSync(tmp,JSON.stringify(data, null, 2),"utf8");
        fs.renameSync(tmp, this.path);
    }
    async add(uid) {
        return this.withLock(async () => {
            const newUser = !this.users.has(uid);
            this.users.add(uid);
            if (newUser) {this.flush();}
            return newUser;
        });
    }
    async remove(uid) {
        return this.withLock(async () => {
            const had = this.users.has(uid);
            this.users.delete(uid);
            if (had) {this.flush();}
            return had;
        });
    }
    async mark(ids) {
        if (!ids.length) {return;}
        return this.withLock(async () => {
            const before = this.seen.size;
            for (const id of ids) {this.seen.add(String(id));}
            if (this.seen.size !== before) {this.flush();}
        });
    }
}
async function fetchFree() {
    const response = await axios.get(SEARCH_URL,{params: PARAMS,headers: HEADERS,timeout: 30000,responseType: "json"});
    const html = response.data?.results_html || "";
    const $ = cheerio.load(html);
    const games = [];
    $("a.search_result_row").each((_, element) => {
        const row = $(element);
        const appid = row.attr("data-ds-appid");
        const block = row.find(".discount_block").first();
        if (!appid || !block.length) {return;}
        const priceFinal = block.attr("data-price-final");
        const discount = block.attr("data-discount");
        if (!(priceFinal === "0" || priceFinal === 0)) {return;}
        if (discount !== "100") {return;}
        const capsule = row.find(".search_capsule img").first();
        let img = capsule.attr("src");
        if (img) {img = img.replace("capsule_231x87","header");} else {img =`https://shared.fastly.steamstatic.com/` +`store_item_assets/steam/apps/${appid}/header.jpg`;}
        const titleNode =row.find(".title").first();
        const title = titleNode.length? titleNode.text().trim(): `App ${appid}`;
        games.push({appid: String(appid),title,img,url:`https://store.steampowered.com/app/` +`${appid}/`});
    });
    return games;
}
function caption(game) {return (`<b>${escapeHtml(game.title)}</b>\n` +`Free on Steam — yours to keep forever.`);}
function escapeHtml(text) {return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");}
function keyboard(game) {return new InlineKeyboard().url("Get on Steam", game.url);}
async function sendGame(bot, chatId, game) {
    try {await bot.api.sendPhoto(chatId,game.img,{caption: caption(game),parse_mode: "HTML",reply_markup: keyboard(game)});} catch (error) {
        if (error?.error_code === 400 || isTelegramError(error, "Bad Request")) {
            await bot.api.sendMessage(chatId,caption(game),{parse_mode: "HTML",reply_markup: keyboard(game),link_preview_options: {is_disabled: true}});
            return;
        }
        throw error;
    }
}
async function allowed(ctx) {
    const chat = ctx.chat;
    if (!chat) {return false;}
    if (chat.type === "private") {return true;}
    if (!ctx.from) {return false;}
    try {
        const member = await ctx.api.getChatMember(chat.id,ctx.from.id);
        return (member.status === "administrator" || member.status === "creator");
    } catch (error) {
        logWarn("Failed to check member permissions:",error?.description || error);
        return false;
    }
}
if (!BOT_TOKEN) {
    console.error("BOT_TOKEN is not set");
    process.exit(1);
}
const bot = new Bot(BOT_TOKEN);
let state;
const HELP = "/start — subscribe to notifications\n" +"/stop — unsubscribe\n" +"/now — see what is free now";
bot.command("start", async ctx => {
    if (!(await allowed(ctx))) {return;}
    const newSubscription = await state.add(ctx.chat.id);
    const text = newSubscription ? ("Subscription activated. " +"I'll notify you as soon as there's " +"a free giveaway on Steam.\n\n"): "You are already subscribed.\n\n";
    await ctx.reply(text + HELP,{link_preview_options: {is_disabled: true}});
});
bot.command("stop", async ctx => {
    if (!(await allowed(ctx))) {return;}
    const removed = await state.remove(ctx.chat.id);
    await ctx.reply(removed? "Unsubscribed.": "You were not subscribed.");
});
bot.command("now", async ctx => {
    try {
        const games = await fetchFree();
        if (!games.length) {
            await ctx.reply("There are no free giveaways at the moment.");
            return;
        }
        for (const game of games.slice(0, 10)) {
            try {await sendGame(bot,ctx.chat.id,game);} catch (error) {
                const retryAfter = error?.parameters?.retry_after;
                if (retryAfter) {
                    logWarn("Rate limited while /now:",`retry_after=${retryAfter}`);
                    await sleep(retryAfter * 1000);
                    await sendGame(bot,ctx.chat.id,game);
                } else {throw error;}
            }
            await sleep(100);
        }
    } catch (error) {logError("/now failed:",error?.description || error);await ctx.reply("Failed to check Steam right now.");}
});
bot.on("my_chat_member", async ctx => {
    const update = ctx.myChatMember;
    if (!update) {return;}
    const chat = update.chat;
    if (chat.type === "private") {return;}
    const status = update.new_chat_member.status;
    const joined = new Set(["member","administrator","creator"]);
    if (joined.has(status)) {
        const added = await state.add(chat.id);
        if (added) {logInfo(`subscribed chat ${chat.id} (${chat.type})`);}
    } else {await state.remove(chat.id);}
});
async function broadcast(game) {
    const dead = [];
    const users = [...state.users];
    for (const chatId of users) {
        try {await sendGame(bot,chatId,game);}
        catch (error) {
            const retryAfter = error?.parameters?.retry_after;
            if (retryAfter) {
                const delay = Math.max(1,Math.floor(retryAfter));
                logWarn(`Telegram rate limit for chat ${chatId}; ` +`waiting ${delay}s`);
                await sleep(delay * 1000);
                try {await sendGame(bot,chatId,game);}
                catch (retryError) {if (retryError?.error_code === 403 || isTelegramError(retryError,"bot was blocked")) {dead.push(chatId);} else {logWarn(`retry send ${chatId} failed:`,retryError?.description || retryError);}
                }
            }
            else if (error?.parameters?.migrate_to_chat_id) {
                const oldChatId = chatId;
                const newChatId = error.parameters.migrate_to_chat_id;
                logInfo(`Migrating chat ${oldChatId} -> ${newChatId}`);
                await state.remove(oldChatId);
                await state.add(newChatId);
                try {await sendGame(bot,newChatId,game);} catch (migrateError) {logWarn(`send migrated chat ${newChatId} failed:`,migrateError?.description || migrateError);}
            }
            else if (error?.error_code === 403 || isTelegramError(error,"bot was blocked")) {dead.push(chatId);}
            else {logWarn(`send ${chatId} failed:`,error?.description || error);}
        }
        await sleep(50);
    }
    for (const chatId of dead) {await state.remove(chatId);}
}
async function watcher() {
    while (true) {
        try {
            const games = await fetchFree();
            const fresh = games.filter(game => !state.seen.has(game.appid));
            if (fresh.length) {
                await state.mark(fresh.map(game => game.appid));
                for (const game of fresh) {
                    logInfo(`new free: ${game.title} (${game.appid})`);
                    await broadcast(game);
                }
            }
        }
        catch (error) {logError("check failed:",error?.stack || error?.description || error);}
        await sleep(INTERVAL * 1000);
    }
}
async function main() {
    state = new State(STATE_FILE);
    const me = await bot.api.getMe();
    logInfo(`Starting @${me.username} id=${me.id} PID=${process.pid}`);
    if (state.seen.size === 0) {
        try {
            const games = await fetchFree();
            await state.mark(games.map(game => game.appid));
            logInfo(`Initial Steam scan: ${games.length} games`);
        }
        catch (error) {logError("Initial Steam scan failed:", error?.stack || error?.description || error);}
    }
    const watcherPromise = watcher();
    try {
        logInfo("Starting Telegram polling");
        await bot.start({onStart: botInfo => {logInfo(`Telegram polling started as @${botInfo.username}`);}});
    }
    finally {
        logInfo("Stopping bot");
        await bot.stop();
        void watcherPromise;
    }
}
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) {return;}
    shuttingDown = true;
    logInfo(`Received ${signal}, stopping bot...`);
    try {await bot.stop();} catch (error) {logWarn("Error while stopping bot:",error);}
    process.exit(0);
}
process.once("SIGINT",() => shutdown("SIGINT"));
process.once("SIGTERM",() => shutdown("SIGTERM"));
main().catch(error => {
    logError("Fatal error:", error?.stack || error?.description || error);
    process.exit(1);
});
