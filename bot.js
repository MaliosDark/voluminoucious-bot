// bot.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';
import {
  Connection, Keypair, PublicKey, Transaction,
  SystemProgram, LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { SolanaTracker } from 'solana-swap';
import TelegramBot from 'node-telegram-bot-api';

////////////////////////////////////////////////////////////////////////////////
// ─── CONFIG & ENV ─────────────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

const BOT_TOKEN      = process.env.TELEGRAM_TOKEN;
const RPC_URL        = process.env.RPC_URL;
const DB_KEY         = Buffer.from(process.env.DB_KEY||'', 'base64');
const FEE_WALLET_PUB = process.env.FEE_WALLET;
if (!BOT_TOKEN||!RPC_URL||DB_KEY.length!==32||!FEE_WALLET_PUB) {
  console.error('❌ Missing env: TELEGRAM_TOKEN, RPC_URL, DB_KEY, FEE_WALLET');
  process.exit(1);
}
const feeWalletPubkey = new PublicKey(FEE_WALLET_PUB);

const DATA_DIR = path.resolve('.data-voluminousy');
const DB_FILE  = path.join(DATA_DIR, 'sessions.enc');

////////////////////////////////////////////////////////////////////////////////
// ─── SOLANA & CONSTANTS ──────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

const conn        = new Connection(RPC_URL, 'confirmed');
const SOL_MINT    = 'So11111111111111111111111111111111111111112';
const MIN_DEPOSIT = 0.5 * LAMPORTS_PER_SOL;
const STOP_RATIO  = 0.4;
const PLATFORM_RESERVE_RATIO = 0.38;
const MAX_WALLETS = 50;

////////////////////////////////////////////////////////////////////////////////
// ─── PERSISTENT STORAGE ──────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

let sessions = {};

function encrypt(buf) {
  const iv = crypto.randomBytes(12),
        c  = crypto.createCipheriv('aes-256-gcm', DB_KEY, iv),
        ct = Buffer.concat([c.update(buf),c.final()]),
        tag= c.getAuthTag();
  return Buffer.concat([iv,tag,ct]).toString('base64');
}
function decrypt(str) {
  const d   = Buffer.from(str,'base64'),
        iv  = d.slice(0,12), tag = d.slice(12,28), ct = d.slice(28),
        dec = crypto.createDecipheriv('aes-256-gcm', DB_KEY, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct),dec.final()]);
}

async function loadSessions() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(DB_FILE)) return;
  const obj = JSON.parse(decrypt(fs.readFileSync(DB_FILE,'utf8')).toString());
  sessions = obj;
  for (let h in sessions) {
    const s = sessions[h];
    s.main        = Keypair.fromSecretKey(Buffer.from(s.main,'base64'));
    s.secondaries = s.secondaries.map(b64=>
      Keypair.fromSecretKey(Buffer.from(b64,'base64')));
  }
}

function saveSessions() {
  const out = {};
  for (let h in sessions) {
    const s = sessions[h];
    out[h] = {
      main:        Buffer.from(s.main.secretKey).toString('base64'),
      secondaries: s.secondaries.map(kp=>Buffer.from(kp.secretKey).toString('base64')),
      tokenMint:   s.tokenMint,
      panelMsg:    s.panelMsg,
      stats:       s.stats,
      config:      s.config,
      geckoCache:  s.geckoCache
    };
  }
  fs.writeFileSync(DB_FILE, encrypt(Buffer.from(JSON.stringify(out))), 'utf8');
}

////////////////////////////////////////////////////////////////////////////////
// ─── SESSION LIFECYCLE ───────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

async function initSession(handle, chat_id) {
  const old = sessions[handle];
  if (old) {
    // 1) Recolectar SOL y token de todos los secundarios
    await Promise.all(old.secondaries.map(async kp => {
      const bal = await conn.getBalance(kp.publicKey);
      if (bal>0) await transferSOL(kp, old.main, bal);
      // token también, si fuera SPL: omitir por brevedad...
    }));
    // 2) Reservar 38% de main
    const mainBal = await conn.getBalance(old.main.publicKey);
    const reserve = Math.floor(mainBal * PLATFORM_RESERVE_RATIO);
    if (reserve>0) await transferSOL(old.main, feeWalletPubkey, reserve);
  }
  // nueva sesión
  sessions[handle] = {
    main:        Keypair.generate(),
    secondaries: [],
    tokenMint:   null,
    panelMsg:    { chat_id, message_id: null },
    stats:       null,
    config:      { maxWallets:5, buyCycles:3, delayMs:2000 },
    geckoCache:  null
  };
  saveSessions();
}

function addWallet(handle) {
  const kp = Keypair.generate();
  sessions[handle].secondaries.push(kp);
  saveSessions();
  return kp;
}

function setMint(handle, m) {
  sessions[handle].tokenMint = m;
  sessions[handle].geckoCache = null;
  saveSessions();
}

function setConfig(handle, k, v) {
  sessions[handle].config[k] = v;
  saveSessions();
}

////////////////////////////////////////////////////////////////////////////////
// ─── SOLANA HELPERS ─────────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

async function getBalance(pub) {
  return conn.getBalance(pub);
}

async function getTokenBalance(pub, mint) {
  try {
    const res = await conn.getTokenAccountsByOwner(pub, { mint:new PublicKey(mint) });
    if (!res.value.length) return 0;
    const info = await conn.getTokenAccountBalance(res.value[0].pubkey);
    return info.value.uiAmount;
  } catch {
    return 0;
  }
}

async function transferSOL(f, to, lam) {
  return conn.sendTransaction(
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey:f.publicKey, toPubkey:to.publicKey, lamports:lam })
    ),
    [f],
    { skipPreflight:true }
  );
}

async function doSwap(inM, outM, tracker, kp, lam) {
  const inst = await tracker.getSwapInstructions(
    inM,outM,lam,2,kp.publicKey.toBase58(),
    0.000005*LAMPORTS_PER_SOL,false
  );
  const tx = Transaction.from(Buffer.from(inst.txn,'base64'));
  tx.sign(kp);
  const sig=await conn.sendTransaction(tx,[kp],{skipPreflight:true});
  await conn.confirmTransaction(sig,'confirmed');
}

function randomSplit(total, cnt) {
  const w = Array.from({length:cnt},()=>crypto.randomInt(1,100));
  const s = w.reduce((a,b)=>a+b,0);
  return w.map(x=>Math.floor(total*x/s));
}

////////////////////////////////////////////////////////////////////////////////
// ─── COINGECKO DATA ─────────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

async function fetchTokenInfo(handle) {
  const s = sessions[handle];
  if (s.geckoCache && Date.now()-s.geckoCache.ts<300_000) {
    return s.geckoCache.info;
  }
  const url = `https://api.coingecko.com/api/v3/coins/solana/contract/${s.tokenMint}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`CG ${r.status}`);
  const j   = await r.json();
  const md  = j.market_data;
  const info = {
    name:        j.name,
    symbol:      j.symbol.toUpperCase(),
    price:       md.current_price.usd.toFixed(6),
    market_cap:  md.market_cap.usd.toLocaleString(),
    volume_24h:  md.total_volume.usd.toLocaleString(),
    circ_supply: md.circulating_supply.toLocaleString(),
    total_supply: md.total_supply?.toLocaleString()||'–',
    change_1h:   md.price_change_percentage_1h_in_currency.usd.toFixed(2),
    change_24h:  md.price_change_percentage_24h_in_currency.usd.toFixed(2),
    change_7d:   md.price_change_percentage_7d.toFixed(2),
    rank:        j.market_cap_rank
  };
  s.geckoCache = { ts: Date.now(), info };
  saveSessions();
  return info;
}

////////////////////////////////////////////////////////////////////////////////
// ─── BUILD PANEL ────────────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

async function buildPanel(handle) {
  const s = sessions[handle], c = s.config;
  const secLines = await Promise.all(s.secondaries.map(async kp=>{
    const addr = kp.publicKey.toBase58();
    const sol  = (await getBalance(kp.publicKey))/LAMPORTS_PER_SOL;
    const tok  = s.tokenMint?await getTokenBalance(kp.publicKey,s.tokenMint):0;
    return `\`${addr}\`\nSOL: ${sol.toFixed(4)} | TOK: ${tok.toFixed(4)}`;
  }));
  const list = secLines.length?secLines.join('\n\n'):'*(none)*';

  let profit = 'n/a';
  if (s.stats?.final!=null) {
    profit = ((s.stats.initial - s.stats.final)/LAMPORTS_PER_SOL).toFixed(4);
  }

  let tkInfo = '';
  if (s.tokenMint) {
    try {
      const ti = await fetchTokenInfo(handle);
      tkInfo =
        `\n*${ti.name} (${ti.symbol})*\n` +
        `Rank: #${ti.rank} | Price: $${ti.price}\n` +
        `MCap: $${ti.market_cap} | Vol24h: $${ti.volume_24h}\n` +
        `CircSupply: ${ti.circ_supply} | TotalSupply: ${ti.total_supply}\n` +
        `Δ1h: ${ti.change_1h}% | Δ24h: ${ti.change_24h}% | Δ7d: ${ti.change_7d}%`;
    } catch {
      tkInfo = '\n*(no token data)*';
    }
  }

  const caption =
`📊 *Volume Bot Panel*

⚙️ *Settings*
• Max wallets: ${c.maxWallets}
• Cycles:      ${c.buyCycles}
• Delay:       ${c.delayMs} ms

💳 *Token mint:* \`${s.tokenMint||'unset'}\`${tkInfo}

🔑 *Secondaries (${s.secondaries.length}/${c.maxWallets}):*
${list}

💹 *Profit:* ${profit} SOL
`;

  const kb = [
    [{ text:'🆕 New Session', callback_data:'create' },{ text:'➕ Add Wallet',callback_data:'add'}],
    [{ text:'💳 Set Mint',     callback_data:'setMint'},{ text:'⚙️ Configure',callback_data:'cfg'}],
    [{ text:'🚀 Run Volume',   callback_data:'run'},{ text:'🛑 Stop',callback_data:'stop'}],
    [{ text:'🔍 Show Main',    callback_data:'showMain'},{ text:'ℹ️ Show Stats',callback_data:'status'}],
    [{ text:'💸 Sell All',     callback_data:'sellAll'},{ text:'🏦 Withdraw',  callback_data:'withdraw'}]
  ];

  return { parse_mode:'Markdown', caption, reply_markup:{inline_keyboard:kb} };
}

////////////////////////////////////////////////////////////////////////////////
// ─── VOLUME & EXTRA ACTIONS ──────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

const jobs = {};

async function runVolume(handle) {
  const s=sessions[handle],c=s.config,p=s.panelMsg;
  if(!s.tokenMint) return bot.sendMessage(p.chat_id,'❌ Mint not set');
  let bal0 = await getBalance(s.main.publicKey);
  if(bal0<MIN_DEPOSIT) return bot.sendMessage(p.chat_id,'❌ Need ≥0.5 SOL');

  // reserve + fee
  const reserve=Math.floor(bal0*PLATFORM_RESERVE_RATIO);
  await transferSOL(s.main, feeWalletPubkey, reserve);
  bal0-=reserve;

  // Add 1% fee to each transaction ( Optional )
  // const fee=Math.floor(bal0*0.01);
  // await transferSOL(s.main, feeWalletPubkey, fee);
  // bal0-=fee;

  // split
  const splits=randomSplit(bal0, Math.min(s.secondaries.length,c.maxWallets));
  for(let i=0;i<splits.length;i++){
    await transferSOL(s.main, s.secondaries[i], splits[i]);
  }

  const tracker=new SolanaTracker(s.main,RPC_URL);
  s.stats={initial:bal0,actions:0,start:Date.now()};
  saveSessions();

  jobs[handle]={stop:false};
  jobs[handle].interval=setInterval(async()=>{
    const panel=await buildPanel(handle);
    await bot.editMessageCaption(panel.caption,{
      chat_id:p.chat_id,message_id:p.message_id,
      parse_mode:'Markdown',reply_markup:panel.reply_markup
    });
  },60000);

  for(let sec of s.secondaries.slice(0,c.maxWallets)){
    let solBal=(await getBalance(sec.publicKey))/LAMPORTS_PER_SOL;
    while(solBal>STOP_RATIO && !jobs[handle].stop){
      for(let i=0;i<c.buyCycles;i++){
        const maxSpend=solBal*0.8;
        const b1=Math.random()*(maxSpend*0.6)+maxSpend*0.2;
        const b2=Math.random()*((maxSpend-b1)*0.8)+(maxSpend-b1)*0.1;
        for(let amt of [b1,b2]){
          await doSwap(SOL_MINT,s.tokenMint,tracker,sec,Math.floor(amt*LAMPORTS_PER_SOL));
          s.stats.actions++; saveSessions();
          await new Promise(r=>setTimeout(r,c.delayMs));
        }
        await doSwap(s.tokenMint,SOL_MINT,tracker,sec,Math.floor((b1+b2)*LAMPORTS_PER_SOL));
        s.stats.actions++; saveSessions();
        await new Promise(r=>setTimeout(r,c.delayMs));
      }
      solBal=(await getBalance(sec.publicKey))/LAMPORTS_PER_SOL;
    }
  }

  clearInterval(jobs[handle].interval);
  delete jobs[handle];
  s.stats.final=await getBalance(s.main.publicKey);
  saveSessions();
  bot.sendMessage(p.chat_id,'✅ Volume simulation completed');
}

function stopVolume(handle){
  const s=sessions[handle];
  if(jobs[handle]){
    jobs[handle].stop=true;
    clearInterval(jobs[handle].interval);
    delete jobs[handle];
    bot.sendMessage(s.panelMsg.chat_id,'🛑 Stopped');
  } else bot.sendMessage(s.panelMsg.chat_id,'ℹ️ No active job');
}

async function sendStats(handle){
  const s=sessions[handle],p=s.panelMsg;
  if(!s.stats) return bot.sendMessage(p.chat_id,'ℹ️ No stats');
  const elapsed=Math.floor((Date.now()-s.stats.start)/1000);
  const profit=((s.stats.initial-s.stats.final)/LAMPORTS_PER_SOL).toFixed(4);
  bot.sendMessage(p.chat_id,
    `⏱ ${elapsed}s | 🔄 ${s.stats.actions} trades\n`+
    `💹 Profit: ${profit} SOL`
  );
}

async function showMain(handle){
  const s=sessions[handle],p=s.panelMsg;
  const addr=s.main.publicKey.toBase58();
  const sol = (await getBalance(s.main.publicKey))/LAMPORTS_PER_SOL;
  const tok = s.tokenMint?await getTokenBalance(s.main.publicKey,s.tokenMint):0;
  bot.sendMessage(p.chat_id,
    `🔑 *Main Wallet*\n\`${addr}\`\n\n💰 SOL: ${sol.toFixed(4)}\n🪙 Token: ${tok}`
  ,{parse_mode:'Markdown'});
}

// vende todo y transfiere SOL y token al main
async function sellAll(handle){
  const s=sessions[handle],p=s.panelMsg;
  if(!s.tokenMint) return bot.sendMessage(p.chat_id,'❌ Mint not set');
  const tracker=new SolanaTracker(s.main,RPC_URL);
  // para cada secundario: swap tokens -> SOL, luego SOL->main
  for(let kp of s.secondaries){
    const tokBal=await getTokenBalance(kp.publicKey,s.tokenMint);
    if(tokBal>0){
      await doSwap(s.tokenMint,SOL_MINT,tracker,kp,Math.floor(tokBal*LAMPORTS_PER_SOL));
    }
    const solBal=await getBalance(kp.publicKey);
    if(solBal>0) await transferSOL(kp,s.main,solBal);
  }
  bot.sendMessage(p.chat_id,'✅ All secondaries sold & funds moved to main');
}

// retira todo del main al chat user
async function withdraw(handle){
  const s=sessions[handle],p=s.panelMsg;
  const solBal=await getBalance(s.main.publicKey);
  if(solBal>0) await transferSOL(s.main,{ publicKey:new PublicKey(p.chat_id) },solBal);
  // token withdrawal omitido (necesita ATA); hacemos solo SOL
  bot.sendMessage(p.chat_id,'✅ Withdrawn all SOL from main');
}

////////////////////////////////////////////////////////////////////////////////
// ─── TELEGRAM BOT SETUP ───────────────────────────────────────────────────────
////////////////////////////////////////////////////////////////////////////////

const bot = new TelegramBot(BOT_TOKEN, { polling:true });

bot.onText(/\/start/,async msg=>{
  const chatId=msg.chat.id, handle=msg.from.username||String(msg.from.id);
  try {
    await loadSessions();
    if(!sessions[handle]) await initSession(handle,chatId);
    const panel=await buildPanel(handle);
    const img=fs.existsSync('welcome.png')?'welcome.png':'https://i.imgur.com/yourImage.png';
    const m=await bot.sendPhoto(chatId,img,panel);
    sessions[handle].panelMsg={ chat_id:chatId, message_id:m.message_id };
    saveSessions();
  } catch(err){
    bot.sendMessage(chatId,`⚠️ /start error: ${err.message}`);
  }
});

bot.on('callback_query',async q=>{
  const chatId=q.message.chat.id, handle=q.from.username||String(q.from.id);
  try {
    if(!sessions[handle]) await initSession(handle,chatId);
    switch(q.data){
      case 'create':   await initSession(handle,chatId); break;
      case 'add':      addWallet(handle); break;
      case 'setMint':
        await bot.answerCallbackQuery(q.id);
        bot.sendMessage(chatId,'📝 Send SPL token mint:').then(()=>{
          bot.once('message',async m=>{
            setMint(handle,m.text.trim());
            const p=await buildPanel(handle);
            await bot.editMessageCaption(p.caption,{
              chat_id:sessions[handle].panelMsg.chat_id,
              message_id:sessions[handle].panelMsg.message_id,
              parse_mode:'Markdown',
              reply_markup:p.reply_markup
            });
          });
        });
        return;
      case 'cfg':
        await bot.answerCallbackQuery(q.id);
        return bot.sendMessage(chatId,
          '⚙️ *Configure*\n' +
          '/setMaxWallets <n>\n' +
          '/setBuyCycles <n>\n' +
          '/setDelayMs <ms>',
          { parse_mode:'Markdown' }
        );
      case 'run':        return runVolume(handle);
      case 'stop':       return stopVolume(handle);
      case 'status':     return sendStats(handle);
      case 'showMain':   return showMain(handle);
      case 'sellAll':    return sellAll(handle);
      case 'withdraw':   return withdraw(handle);
    }
    // redraw
    const p=await buildPanel(handle);
    await bot.editMessageCaption(p.caption,{
      chat_id:sessions[handle].panelMsg.chat_id,
      message_id:sessions[handle].panelMsg.message_id,
      parse_mode:'Markdown',
      reply_markup:p.reply_markup
    });
  } catch(err){
    try{ await bot.answerCallbackQuery(q.id); }catch{}
    bot.sendMessage(chatId,`⚠️ callback error: ${err.message}`);
  }
});

// text commands config
bot.onText(/\/setMaxWallets (.+)/,(_,m)=>{
  const h=m.from.username||String(m.from.id),n=+m.match[1];
  if(n>0&&n<=MAX_WALLETS){ setConfig(h,'maxWallets',n); bot.sendMessage(m.chat.id,`✅ maxWallets=${n}`); }
});
bot.onText(/\/setBuyCycles (.+)/,(_,m)=>{
  const h=m.from.username||String(m.from.id),n=+m.match[1];
  if(n>0){ setConfig(h,'buyCycles',n); bot.sendMessage(m.chat.id,`✅ buyCycles=${n}`); }
});
bot.onText(/\/setDelayMs (.+)/,(_,m)=>{
  const h=m.from.username||String(m.from.id),n=+m.match[1];
  if(n>=0){ setConfig(h,'delayMs',n); bot.sendMessage(m.chat.id,`✅ delayMs=${n} ms`); }
});
