// ========== WhatsApp Bot - PBS (Local/Server) ==========
import "dotenv/config";
import express from "express";
import qrcode from "qrcode-terminal";
import QR from "qrcode";
import { parse } from "csv-parse/sync";
import crypto from "crypto";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;

/* ---------------- ENV ---------------- */
const SHEET_URL  = process.env.SHEET_URL || "";                    // CSV publik: Produk (punya kolom alias di kolom J)
const SHEET_URL_PROMO = process.env.SHEET_URL_PROMO || "";         // CSV publik: Promo (opsional; jika kosong => promo non-aktif)
const ADMIN_JIDS = new Set((process.env.ADMINS || "").split(",").map(s=>s.trim()).filter(Boolean));
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || "";
const CLIENT_ID = process.env.CLIENT_ID || "botwa-local";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";         // ex: https://xxx.trycloudflare.com

// Apps Script (stok & order log)
const GAS_URL    = process.env.GAS_WEBHOOK_URL || "";
const GAS_SECRET = process.env.GAS_SECRET || "";

// Payment (Midtrans)
const PAY_PROV = (process.env.PAYMENT_PROVIDER || "midtrans").toLowerCase();
const MID_SKEY = process.env.MIDTRANS_SERVER_KEY || "";
const MID_PROD = (process.env.MIDTRANS_IS_PRODUCTION || "false") === "true";

// Control (baru)
const SHOW_PRODUCT_IMAGE = (process.env.SHOW_PRODUCT_IMAGE || "false").toLowerCase() === "true";
const QUIET_MODE = (process.env.QUIET_MODE || "true").toLowerCase() === "true";      // default ON
const COOLDOWN_MS = Math.max(0, Number(process.env.COOLDOWN_SEC || 2) * 1000);       // default 2s

// Chromium path (Windows/Mac biarkan undefined; Linux isi /usr/bin/chromium)
const EXEC_PATH =
  (process.env.PUPPETEER_EXECUTABLE_PATH || "").trim() ||
  (process.platform === "linux" ? "/usr/bin/chromium" : undefined);

/* --------------- Server keepalive + Webhook --------------- */
const app = express();
app.use(express.json({ type: ['application/json','application/*+json'] }));
app.use(express.urlencoded({ extended: true }));
app.get("/", (_req,res)=>res.send("OK - PBS Bot is running"));
app.get("/status", (_req,res)=>res.json({ok:true}));

/* --------------- Utils --------------- */
const norm = (s="") => s.toString().toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
const normCode = (s="") => norm(s).replace(/[^\p{L}\p{N}]+/gu, ""); // untuk banding kode/alias: abaikan spasi & simbol
const toID = (s="") => s.replace(/\D/g, "");
const isHttp = (u="") => /^https?:\/\//i.test(u || "");
const IDR = (n) => new Intl.NumberFormat("id-ID", { style:"currency", currency:"IDR", maximumFractionDigits:0 }).format(Number(n||0));
const paginate = (arr, page=1, per=8) => {
  const total = Math.max(1, Math.ceil(arr.length/per));
  const p = Math.min(Math.max(1, page), total);
  const start = (p-1)*per;
  return { items: arr.slice(start, start+per), page: p, total };
};
const pipesToComma = (text="") => String(text).split("||").map(s=>s.trim()).filter(Boolean).join(", ");
async function postJSON(url, body) {
  const res = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
  return res.json();
}

/* --------------- Data (Sheet CSV: Produk & Promo) --------------- */
// Produk kolom: nama,harga,ikon,deskripsi,kategori,wa,harga_lama,stok,kode,alias,(terjual,total)
let PRODUCTS = []; let LAST = 0; const TTL = 1000*60*5;
let PRODUCT_TOKENS = new Set(); // untuk smart intent (saat QUIET_MODE=false)
let PROMOS = []; let LAST_PROMO = 0; const TTL_PROMO = 1000*60*5;

function rowToProduct(r) {
  const o = {}; for (const k of Object.keys(r)) o[k.trim().toLowerCase()] = (r[k] ?? "").toString().trim();
  return {
    nama:o.nama||"", harga:o.harga||"", ikon:o.ikon||"",
    deskripsi:o.deskripsi||"", kategori:o.kategori||"", wa:o.wa||"",
    harga_lama:o.harga_lama||"", stok:o.stok||"", kode:o.kode||"",
    alias:o.alias||"", terjual:o.terjual||"", total:o.total||""
  };
}
function splitAliases(s="") {
  return String(s)
    .split(/[\n,;|/]+/g) // dukung koma, pipe, titik-koma, garis miring, baris baru
    .map(t=>t.trim())
    .filter(Boolean);
}
function buildProductTokens() {
  const tokens = new Set();
  for (const p of PRODUCTS) {
    if (p.kode) tokens.add(norm(p.kode));
    String(p.nama||"").toLowerCase().split(/[^a-z0-9]+/i)
      .map(s=>s.trim()).filter(w=>w && w.length>=3).forEach(w=>tokens.add(w));
    // alias → pecah multi delimiter
    splitAliases(p.alias).forEach(w=>{
      w.split(/[^a-z0-9]+/i).filter(x=>x && x.length>=3).forEach(x=>tokens.add(x.toLowerCase()));
    });
  }
  PRODUCT_TOKENS = tokens;
}
async function loadData(force=false) {
  if (!force && PRODUCTS.length && Date.now()-LAST < TTL) return;
  if (!SHEET_URL) { PRODUCTS=[{nama:"Contoh",harga:"10000",kode:"contoh",alias:"sample, demo",wa:ADMIN_CONTACT}]; LAST=Date.now(); buildProductTokens(); return; }
  const r = await fetch(SHEET_URL);
  if (!r.ok) throw new Error("Fetch sheet failed: "+r.status);
  const csv = await r.text();
  const rows = parse(csv, { columns:true, skip_empty_lines:true });
  PRODUCTS = rows.map(rowToProduct).filter(p=>p.nama && p.kode);
  LAST = Date.now();
  buildProductTokens();
}
const categories = () => [...new Set(PRODUCTS.map(p=>p.kategori).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
const search = (q) => {
  const s=norm(q);
  return PRODUCTS.filter(p =>
    [p.nama,p.deskripsi,p.kode,p.kategori,p.alias].some(v=>norm(v).includes(s)));
};
const byKode = (code) => {
  const c = normCode(code);
  return PRODUCTS.find(p => {
    if (normCode(p.kode) === c) return true;
    const aliases = splitAliases(p.alias);
    return aliases.some(a => normCode(a) === c);
  });
};

// ---- Promo loader (fleksibel header) ----
function rowToPromo(r) {
  const o = {}; for (const k of Object.keys(r)) o[k.trim().toLowerCase()] = (r[k] ?? "").toString().trim();
  // header umum: code,type,value,applies_to,min_qty,min_amount,quota,used,expires_at,active,label
  const appliesRaw = o.applies_to || o.applies || "";
  const applies = appliesRaw ? appliesRaw.split(/[,|]/).map(s=>norm(s)).filter(Boolean) : ["all"];
  return {
    code: (o.code || o.kode || "").toUpperCase(),
    type: (o.type || o.jenis || "").toLowerCase(), // percent|nominal
    value: Number(o.value || o.nilai || 0) || 0,
    applies_to: applies.length ? applies : ["all"],
    min_qty: Number(o.min_qty || o.minqty || 0) || 0,
    min_amount: Number(o.min_amount || o.min || 0) || 0,
    quota: Number(o.quota || 0) || 0,
    used: Number(o.used || 0) || 0,
    expires_at: o.expires_at || o.expired || "",
    active: ((o.active || o.aktif || "true").toString().toLowerCase()) === "true",
    label: o.label || ""
  };
}
function isPromoValidFor(promo, { kode, qty, total }) {
  if (!promo?.active) return { ok:false, reason:"non-active" };
  if (promo.expires_at) {
    const now = Date.now();
    const exp = new Date(promo.expires_at).getTime();
    if (!isNaN(exp) && now > exp) return { ok:false, reason:"expired" };
  }
  if (promo.quota && promo.used && promo.used >= promo.quota) return { ok:false, reason:"quota" };
  if (promo.min_qty && qty < promo.min_qty) return { ok:false, reason:"min_qty" };
  if (promo.min_amount && total < promo.min_amount) return { ok:false, reason:"min_amount" };
  const applies = promo.applies_to || ["all"];
  if (!applies.includes("all") && !applies.includes(norm(kode))) return { ok:false, reason:"applies" };
  if (!["percent","nominal"].includes(promo.type)) return { ok:false, reason:"type" };
  if (!(promo.value > 0)) return { ok:false, reason:"value" };
  return { ok:true };
}
function applyPromo(promo, { total }) {
  if (promo.type === "percent") {
    const disc = Math.floor((promo.value/100) * total);
    return Math.min(disc, total);
  }
  // nominal
  return Math.min(Math.floor(promo.value), total);
}
async function loadPromos(force=false) {
  if (!SHEET_URL_PROMO) { PROMOS = []; LAST_PROMO = Date.now(); return; }
  if (!force && PROMOS.length && Date.now() - LAST_PROMO < TTL_PROMO) return;
  const r = await fetch(SHEET_URL_PROMO);
  if (!r.ok) throw new Error("Fetch promos failed: "+r.status);
  const csv = await r.text();
  const rows = parse(csv, { columns:true, skip_empty_lines:true });
  PROMOS = rows.map(rowToPromo).filter(p=>p.code);
  LAST_PROMO = Date.now();
}

/* --------------- Cards --------------- */
const cardHeader = () => [
  `╭────〔 BOT AUTO ORDER 〕─`,
  `┊・Untuk membeli ketik perintah berikut`,
  `┊・#buynow Kode(spasi)JumlahAkun`,
  `┊・Contact Admin: ${ADMIN_CONTACT || "-"}`,
  `╰┈┈┈┈┈┈┈┈`
].join("\n");

function cardProduk(p){
  const hargaNow = IDR(p.harga);
  const hargaOld = p.harga_lama ? `~${IDR(p.harga_lama)}~ → *${hargaNow}*` : `*${hargaNow}*`;
  const stokTersedia = p.stok || "-";
  const stokTerjual = p.terjual || "-";
  const totalStok = p.total || (p.stok && p.terjual ? (Number(p.stok)+Number(p.terjual)) : "-");
  const deskPretty = p.deskripsi ? pipesToComma(p.deskripsi) : "-";
  const aliasShow = p.alias ? `\n┊・Alias: ${p.alias}` : "";
  return [
    `*╭────〔 ${p.nama.toUpperCase()} 〕─*`,
    `┊・Harga: ${hargaOld}`,
    `┊・Stok Tersedia: ${stokTersedia}`,
    `┊・Stok Terjual: ${stokTerjual}`,
    `┊・Total Stok: ${totalStok}`,
    `┊・Kode: ${p.kode || "-"}`,
    `┊・Desk: ${deskPretty}${aliasShow}`,
    `╰┈┈┈┈┈┈┈┈`
  ].join("\n");
}

/* --------------- Apps Script (stok & log) --------------- */
async function reserveStock({ kode, qty, order_id, buyer_jid }) {
  if (!GAS_URL) return { ok:false, msg:"GAS_URL missing" };
  return postJSON(GAS_URL, { secret:GAS_SECRET, action:"reserve", kode, qty, order_id, buyer_jid });
}
async function finalizeStock({ order_id, total }) {
  if (!GAS_URL) return { ok:false, msg:"GAS_URL missing" };
  return postJSON(GAS_URL, { secret:GAS_SECRET, action:"finalize", order_id, total });
}
async function releaseStock({ order_id }) {
  if (!GAS_URL) return { ok:false, msg:"GAS_URL missing" };
  return postJSON(GAS_URL, { secret:GAS_SECRET, action:"release", order_id });
}

/* --------------- Midtrans --------------- */
function midtransBase(){
  const host = MID_PROD ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
  const auth = Buffer.from(MID_SKEY + ":").toString("base64");
  return { host, auth };
}
async function createMidtransInvoice({ order_id, gross_amount, customer_phone, product_name }) {
  const { host, auth } = midtransBase();
  const payload = {
    transaction_details: { order_id, gross_amount },
    item_details: [{ id: order_id, price: gross_amount, quantity: 1, name: product_name } ],
    customer_details: { phone: customer_phone },
    callbacks: { finish: PUBLIC_BASE_URL ? (PUBLIC_BASE_URL + "/pay/finish") : undefined },
    credit_card: { secure: true }
  };
  const res = await fetch(host + "/snap/v1/transactions", {
    method:"POST",
    headers:{ "content-type":"application/json", Authorization:`Basic ${auth}` },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("Midtrans create error: "+res.status+" "+await res.text());
  return res.json(); // { token, redirect_url }
}
function verifyMidtransSignature({ order_id, status_code, gross_amount, signature_key }) {
  const raw = order_id + status_code + gross_amount + MID_SKEY;
  const calc = crypto.createHash("sha512").update(raw).digest("hex");
  return calc === signature_key;
}
async function midtransStatus(order_id){
  const { host, auth } = midtransBase();
  const res = await fetch(`${host}/v2/${encodeURIComponent(order_id)}/status`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) throw new Error("Midtrans status error: "+res.status);
  return res.json();
}

/* ---- Core API: QRIS charge (tanpa Snap) ---- */
async function createMidtransQRISCharge({ order_id, gross_amount }) {
  const { host, auth } = midtransBase();
  const payload = { payment_type: "qris", transaction_details: { order_id, gross_amount } };
  const res = await fetch(host + "/v2/charge", {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("QRIS charge error: " + res.status + " " + await res.text());
  return res.json(); // actions, qr_string, dll.
}

/* ----- Akun parsing & transaksi box ----- */
function normalizeKey(k="") {
  const s = k.toString().trim().toLowerCase();
  if (/^e(-)?mail$|^email$|^user(name)?$/.test(s)) return "email";
  if (/^pass(word)?$|^pw$|^sandi$/.test(s)) return "password";
  if (/^profil(e)?$/.test(s)) return "profile";
  if (/^pin$/.test(s)) return "pin";
  if (/^redeem(code)?$|^kode ?redeem$/.test(s)) return "redeem";
  if (/^durasi$|^masa ?aktif$|^valid$/.test(s)) return "duration";
  return s;
}
function parseKV(raw="") {
  const kv = {};
  const parts = String(raw).split(/\|\||\||,/).map(s=>s.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^([^:=]+)\s*[:=]\s*(.+)$/);
    if (m) kv[normalizeKey(m[1])] = m[2].trim();
    else kv.info = kv.info ? (kv.info + " | " + p) : p;
  }
  return kv;
}
function detectSingleToken(raw="") {
  const s = String(raw).trim();
  if (!s) return null;
  if (/[=:]/.test(s)) return null;
  const parts = s.split(/\|\||\||,/).map(t=>t.trim()).filter(Boolean);
  if (parts.length === 1) return parts[0];
  return null;
}
function formatAccountDetailsStacked(items=[]) {
  const lines = ["( ACCOUNT DETAIL )"];
  items.forEach((it, idx) => {
    const raw = String(it?.data || "").trim();
    if (!raw) return;
    const single = detectSingleToken(raw);
    const n = idx + 1;
    if (single) { lines.push(`${n}. ${single}`); return; }
    const kv = parseKV(raw);
    if (kv.info && Object.keys(kv).length === 1) { lines.push(`${n}. ${kv.info}`); return; }
    if (kv.email) lines.push(`${n}. Email: ${kv.email}`); else lines.push(`${n}. -`);
    if (kv.password) lines.push(`- Password: ${kv.password}`);
    if (kv.profile)  lines.push(`- Profile: ${kv.profile}`);
    if (kv.pin)      lines.push(`- Pin: ${kv.pin}`);
    if (kv.redeem)   lines.push(`- Redeem: ${kv.redeem}`);
    if (kv.duration) lines.push(`- Durasi: ${kv.duration}`);
    const shown = new Set(["email","password","profile","pin","redeem","duration","info"]);
    for (const [k,v] of Object.entries(kv)) if (!shown.has(k)) lines.push(`- ${k[0].toUpperCase()+k.slice(1)}: ${v}`);
    if (kv.info) lines.push(`- Info: ${kv.info}`);
  });
  return lines.join("\n");
}
function indoDateTime(iso) {
  try {
    const d = new Date(iso);
    const bln = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
    const tgl = d.getDate();
    const bulan = bln[d.getMonth()];
    const th = d.getFullYear();
    const hh = String(d.getHours()).padStart(2,"0");
    const mm = String(d.getMinutes()).padStart(2,"0");
    return `${tgl} ${bulan} ${th} pukul ${hh}.${mm}`;
  } catch { return iso; }
}
function mapPaymentType(ev) {
  const t = (ev?.payment_type || "").toLowerCase();
  if (t==="qris") return "QRIS";
  if (t==="bank_transfer") {
    if (ev?.va_numbers?.[0]?.bank) return `Virtual Account ${ev.va_numbers[0].bank.toUpperCase()}`;
    if (ev?.permata_va_number) return "Virtual Account PERMATA";
    return "Virtual Account";
  }
  if (t==="echannel") return "Mandiri Bill";
  if (t==="gopay") return "GoPay";
  if (t==="credit_card") return "Kartu Kredit";
  if (t==="shopeepay") return "ShopeePay";
  if (t==="alfamart" || t==="indomaret") return t.charAt(0).toUpperCase()+t.slice(1);
  return t || "-";
}
function simpleBuyerId(chatId) {
  if (!chatId) return "-";
  const only = toID(chatId);
  if (!only) return "-";
  return only.slice(-5);
}
function formatTransaksiSuksesBox({ ev, meta, gross }) {
  const payId   = ev?.transaction_id || "-";
  const orderId = ev?.order_id || "-";
  const product = meta?.product_name || meta?.kode || "-";
  const idBuyer = simpleBuyerId(meta?.chatId);
  const noBuyer = toID(meta?.chatId||"");
  const qty     = Number(meta?.qty||0);
  const akun    = Number(qty);
  const harga   = Number(meta?.unit_price||0) || (Number(gross||0) / (qty||1));
  const total   = Number(gross||0);
  const payM    = mapPaymentType(ev) || "-";
  const timeISO = ev?.settlement_time || ev?.transaction_time || new Date().toISOString();
  const waktu   = indoDateTime(timeISO);
  return [
    "╭───〔 TRANSAKSI SUKSES 〕─",
    `: Pay ID : ${payId}`,
    `: Kode Unik : ${orderId}`,
    `: Nama Produk : ${product}`,
    `: ID Buyer : ${idBuyer}`,
    `: Nomor Buyer : ${noBuyer}`,
    `: Jumlah Beli : ${qty}`,
    `: Jumlah Akun didapat : ${akun}`,
    `: Harga : ${IDR(harga)}`,
    `: Total Dibayar : ${IDR(total)}`,
    `: Methode Pay : ${payM}`,
    `: Tanggal/Jam Transaksi : ${waktu}`,
    "╰────────────────────────"
  ].join("\n");
}

/* ==== State ==== */
const ORDERS = new Map();      // order_id -> { chatId, kode, qty, buyerPhone, total, unit_price, product_name, timer? }
const SENT_ORDERS = new Set(); // prevent double-send via webhook retry
const LAST_QR = new Map();     // cache QR per chat (opsional)
const LAST_SEEN = new Map();   // anti-spam cooldown: jid -> timestamp

/* ==== Smart intent helpers (hanya dipakai bila QUIET_MODE=false) ==== */
const STOPWORDS = new Set([
  "stok","stock","harga","beli","order","pesan","list","kategori","produk","product",
  "minta","tolong","dong","kak","bang","min","gan","bro","sist","sista","admin",
  "gaada","nggak","tidak","iya","halo","hai","terimakasih","makasih","makasi","assalamualaikum","salam","p",
  "test","coba","udah","sudah","lagi","banget","lol","wkwk"
]);
function tokenizeClean(s="") { return norm(s).split(/[^a-z0-9]+/i).filter(Boolean); }
function cleanQuery(s="") {
  const x = norm(s).replace(/^#/, "").replace(/[^\p{L}\p{N}\s\-_.]/gu, " ");
  const parts = x.split(/\s+/).filter(Boolean).filter(w => !STOPWORDS.has(w));
  return (parts.join(" ") || norm(s)).trim();
}
function isLikelyQuery(text="") {
  if (QUIET_MODE) return false;                // kalau mode diam → nonaktif
  if (!text) return false;
  if (text.trim().startsWith("#")) return false;
  if (text.includes("?")) return false;
  if (/(https?:\/\/)/i.test(text)) return false;
  const tokens = tokenizeClean(text).filter(t => !STOPWORDS.has(t));
  if (!tokens.length) return false;
  let hasSignal = false;
  for (const t of tokens) { if (t.length >= 3 && PRODUCT_TOKENS.has(t)) { hasSignal = true; break; } }
  if (!hasSignal) return false;
  if (tokens.length >= 8 && !/\d/.test(text)) return false;
  return true;
}

/* --------------- WhatsApp Client --------------- */
const client = new Client({
  authStrategy: new LocalAuth({ clientId: CLIENT_ID }),
  puppeteer: {
    headless: true,
    ...(EXEC_PATH ? { executablePath: EXEC_PATH } : {}),
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-extensions"]
  }
});

/* ---- QR handling + /qr PNG ---- */
let lastQR = "";
client.on("qr", (qr)=>{ lastQR=qr; console.log("Scan QR berikut:"); qrcode.generate(qr, { small:true }); });
client.on("authenticated", ()=> lastQR = "");
client.on("ready", async ()=>{ lastQR=""; console.log("✅ Bot siap! (Local/Server)"); try{ await loadData(true); await loadPromos(true); console.log("📦 Items:", PRODUCTS.length, " | 🎟️ Promos:", PROMOS.length); }catch(e){ console.error(e); } });

app.get("/qr", async (_req,res)=>{
  if (!lastQR) return res.status(204).send("");
  try { const png = await QR.toBuffer(lastQR, { type:"png", width:320, margin:1 }); res.set("Content-Type","image/png"); res.send(png); }
  catch { res.status(500).send("QR gen error"); }
});

app.get("/pay/finish", (_req,res)=> res.send("Terima kasih! Silakan cek WhatsApp Anda untuk konfirmasi & produk."));

/* ---- Midtrans Webhook ---- */
app.post("/webhook/midtrans", async (req,res)=>{
  try{
    const ev = req.body || {};
    if (!verifyMidtransSignature(ev)) return res.status(401).send("bad signature");

    const order_id = ev.order_id;
    const status   = ev.transaction_status; // settlement, capture, deny, cancel, expire, pending
    const grossStr = String(ev.gross_amount || "0");
    const gross    = Number(grossStr);

    if (status==="settlement" || status==="capture") {
      if (SENT_ORDERS.has(order_id)) return res.send("ok");
      SENT_ORDERS.add(order_id);
      setTimeout(() => SENT_ORDERS.delete(order_id), 10 * 60 * 1000);

      const fin = await finalizeStock({ order_id, total: grossStr });
      if (fin?.ok) {
        const meta = ORDERS.get(order_id);
        if (meta?.timer) clearTimeout(meta.timer);
        if (meta?.chatId) {
          const items = fin.items || [];
          const box = formatTransaksiSuksesBox({ ev, meta, gross });
          await client.sendMessage(meta.chatId, box, { linkPreview: false });
          const detailMsg = items.length
            ? formatAccountDetailsStacked(items)
            : "( ACCOUNT DETAIL )\n- Stok akan dikirim manual oleh admin.";
          await client.sendMessage(meta.chatId, detailMsg, { linkPreview: false });
          if (fin.after_msg) await client.sendMessage(meta.chatId, fin.after_msg, { linkPreview: false });
          LAST_QR.delete(meta.chatId);
        }
        ORDERS.delete(order_id);
      }
      return res.send("ok");
    }

    if (status==="expire" || status==="cancel" || status==="deny") {
      await releaseStock({ order_id }).catch(()=>{});
      const meta = ORDERS.get(order_id);
      if (meta?.timer) clearTimeout(meta.timer);
      if (meta?.chatId) await client.sendMessage(meta.chatId, `❌ Pembayaran *${status}*. Order dibatalkan dan stok dikembalikan.`);
      ORDERS.delete(order_id);
      return res.send("ok");
    }

    return res.send("ok");
  }catch(e){ console.error("webhook midtrans:", e); res.status(500).send("error"); }
});

/* --------------- Command List --------------- */
const COMMANDS = ["#menu","#ping","#kategori","#list","#harga","#detail","#beli","#buynow","#status","#refresh"];

/* --------------- Command Handler --------------- */
client.on("message", async (msg)=>{
  try{
    const text = (msg.body||"").trim();
    const from = msg.from;
    if (msg.isStatus) return;

    const looksLikeCommand = /^[#\/!]/.test(text);
    const likelyQuery = isLikelyQuery(text);

    // Bukan command dan juga bukan query yang mengarah ke produk → abaikan (tanpa react)
    if (!looksLikeCommand && !likelyQuery) return;

    // Anti-spam cooldown (hanya untuk pesan yang akan ditangani)
    const now = Date.now();
    const last = LAST_SEEN.get(from) || 0;
    if (now - last < COOLDOWN_MS) return;
    LAST_SEEN.set(from, now);

    // Tunjukkan progres hanya ketika kita akan memproses
    try { await msg.react("⏳"); } catch (e) { /* ignore */ }

    // ===== Perintah klasik =====
    if (/^#menu$/i.test(text)) {
      await msg.reply([
        "📜 *Menu Bot*",
        "• #ping",
        "• #kategori",
        "• #list [kategori] [hal]",
        "• #harga <keyword>",
        "• #detail <kode>",
        "• #beli <kode>",
        "• #buynow <kode> <jumlah> [PROMO]",
        "• #status <OrderID>",
        ADMIN_JIDS.has(from) ? "• #refresh (admin)" : null
      ].filter(Boolean).join("\n"));
      try{ await msg.react("✅"); }catch{}
      return;
    }

    if (/^#ping$/i.test(text)) { await msg.reply("Pong ✅ Bot aktif."); try{ await msg.react("✅"); }catch{} return; }

    if (/^#refresh$/i.test(text)) {
      if (!ADMIN_JIDS.has(from)) { await msg.reply("❌ Hanya admin."); try{ await msg.react("❌"); }catch{} return; }
      await Promise.all([loadData(true), loadPromos(true)]);
      await msg.reply(`✅ Reload sukses. Items: ${PRODUCTS.length} | Promos: ${PROMOS.length}`);
      try{ await msg.react("✅"); }catch{}
      return;
    }

    if (/^#kategori$/i.test(text)) {
      await loadData();
      const cats=categories();
      await msg.reply(cats.length ? `🗂️ *Kategori*\n• ${cats.join("\n• ")}` : "Belum ada kategori.");
      try{ await msg.react("✅"); }catch{}
      return;
    }

    if (/^#list\b/i.test(text)) {
      await loadData();
      const parts = text.split(/\s+/).slice(1);
      let cat=""; let page=1;
      if (parts.length===1 && /^\d+$/.test(parts[0])) page=Number(parts[0]);
      else if (parts.length>=1) { const last=parts[parts.length-1]; if (/^\d+$/.test(last)) { page=Number(last); cat=parts.slice(0,-1).join(" "); } else { cat=parts.join(" "); } }
      let data=PRODUCTS; if (cat) data=data.filter(p=>norm(p.kategori).includes(norm(cat)));
      const { items, page:p, total } = paginate(data, page, 8);
      if (!items.length) { await msg.reply(cat ? `Tidak ada produk untuk kategori *${cat}*.` : "Belum ada produk."); try{ await msg.react("❌"); }catch{} return; }
      const chunks=[cardHeader(), ...items.map(cardProduk)];
      await msg.reply(chunks.join("\n\n") + `\n\nHalaman ${p}/${total} — *#list ${cat?cat+" ":""}${p+1}* untuk berikutnya.`);
      try{ await msg.react("✅"); }catch{}
      return;
    }

    if (/^#(harga|cari)\b/i.test(text)) {
      await loadData();
      const q = text.replace(/^#(harga|cari)\s*/i, "");
      if (!q) { await msg.reply("Format: *#harga <kata kunci>*"); try{ await msg.react("❌"); }catch{} return; }
      const found = search(q).slice(0,6);
      if (!found.length) { await msg.reply("❌ Tidak ditemukan."); try{ await msg.react("❌"); }catch{} return; }
      const chunks=[cardHeader(), ...found.map(cardProduk)];
      await msg.reply(chunks.join("\n\n"));
      try{ await msg.react("✅"); }catch{}
      return;
    }

    if (/^#detail\s+/i.test(text)) {
      await loadData();
      const code = text.split(/\s+/)[1] || "";
      const p = byKode(code); if (!p) { await msg.reply("Kode tidak ditemukan."); try{ await msg.react("❌"); }catch{} return; }
      const cap = [cardHeader(), cardProduk(p)].join("\n\n");
      if (SHOW_PRODUCT_IMAGE && isHttp(p.ikon)) {
        try{ const media=await MessageMedia.fromUrl(p.ikon); await msg.reply(media, undefined, { caption: cap }); }
        catch { await msg.reply(cap); }
      } else { await msg.reply(cap); }
      try{ await msg.react("✅"); }catch{}
      return;
    }

    if (/^#beli\s+/i.test(text)) {
      await loadData();
      const code = text.split(/\s+/)[1] || "";
      const p = byKode(code); if (!p) { await msg.reply("Kode tidak ditemukan."); try{ await msg.react("❌"); }catch{} return; }
      const link = `https://wa.me/${toID(p.wa||ADMIN_CONTACT)}?text=${encodeURIComponent(`Halo admin, saya ingin beli ${p.nama} (kode: ${p.kode}).`)}`;
      await msg.reply(`Silakan order ke admin:\n${link}`);
      try{ await msg.react("✅"); }catch{}
      return;
    }

    if (/^#buynow\s+/i.test(text)) {
      await Promise.all([loadData(), loadPromos()]);
      const m = text.match(/^#buynow\s+(\S+)(?:\s+(\d+))?(?:\s+(\S+))?/i);
      const code = m?.[1] || ""; const qty = Math.max(1, Number(m?.[2] || "1") || 1);
      const promoCode = (m?.[3] || "").toUpperCase();
      const p = byKode(code); if (!p) { await msg.reply("Kode tidak ditemukan. Contoh: *#buynow spo3b 1*"); try{ await msg.react("❌"); }catch{} return; }

      const order_id = `PBS-${Date.now()}`;
      const unitPrice = Number(p.harga)||0;
      let total = unitPrice * qty;

      // === Promo (via CSV PROMO) ===
      let promoInfo = "";
      if (promoCode && PROMOS.length) {
        const promo = PROMOS.find(x => x.code === promoCode);
        if (!promo) {
          promoInfo = "\n( Kode promo tidak dikenal )";
        } else {
          const chk = isPromoValidFor(promo, { kode: p.kode, qty, total });
          if (!chk.ok) {
            promoInfo = `\n( Promo tidak valid: ${chk.reason} )`;
          } else {
            const disc = applyPromo(promo, { total });
            if (disc > 0) {
              total = Math.max(0, total - disc);
              promoInfo = `\n( Promo ${promo.label || promo.code}: -${IDR(disc)} )`;
            }
          }
        }
      } else if (promoCode) {
        promoInfo = "\n( Promo data belum dikonfigurasi )";
      }

      // 1) Reserve stock
      const reserve = await reserveStock({ kode: p.kode, qty, order_id, buyer_jid: from });
      if (!reserve.ok) { await msg.reply("Maaf, stok tidak mencukupi. Coba kurangi jumlah / pilih produk lain."); try{ await msg.react("❌"); }catch{} return; }

      // 2) Save mapping (untuk webhook)
      ORDERS.set(order_id, {
        chatId: from,
        kode: p.kode,
        qty,
        buyerPhone: toID(from),
        total,
        unit_price: unitPrice,
        product_name: p.nama||code
      });

      // 3) Otomatis batalkan jika tidak dibayar (TTL)
      const ttlMs = Number(process.env.PAY_TTL_MS || 20*60*1000);
      const timer = setTimeout(async () => {
        if (ORDERS.has(order_id) && !SENT_ORDERS.has(order_id)) {
          await releaseStock({ order_id }).catch(()=>{});
          const meta = ORDERS.get(order_id);
          if (meta?.chatId) {
            await client.sendMessage(meta.chatId, "⚠️ Pembayaran belum diterima dan order dibatalkan otomatis. Silakan #buynow lagi bila masih ingin membeli.");
          }
          ORDERS.delete(order_id);
        }
      }, ttlMs);
      ORDERS.get(order_id).timer = timer;

      // 4) MIDTRANS: Charge QRIS & kirim gambar QR
      if (PAY_PROV === "midtrans") {
        try {
          const charge = await createMidtransQRISCharge({ order_id, gross_amount: total });

          let payLink = "";
          if (Array.isArray(charge?.actions)) {
            const prefer = (names) => charge.actions.find(a => names.some(n => (a?.name||"").toLowerCase().includes(n)));
            const a1 = prefer(["desktop","web"]);
            const a2 = prefer(["mobile"]);
            const a3 = prefer(["deeplink"]);
            const aAny = charge.actions[0];
            payLink = (a1?.url || a2?.url || a3?.url || aAny?.url || "");
          }

          const qrString = charge?.qr_string || "";
          let media = null;
          if (qrString) {
            const buf = await QR.toBuffer(qrString, { type:"png", width:512, margin:1 });
            media = new MessageMedia("image/png", buf.toString("base64"), `qris-${order_id}.png`);
          }

          const caption = [
            "🧾 *Order dibuat!*",
            `Order ID: ${order_id}`,
            `Produk: ${p.nama} x ${qty}`,
            `Subtotal: ${IDR(unitPrice*qty)}`,
            promoInfo ? promoInfo : "",
            `Total Bayar: ${IDR(total)}`,
            "",
            "Silakan scan QRIS berikut untuk membayar.",
            payLink ? `Link Checkout: ${payLink}` : "(Jika QR tidak muncul, balas: *#buynow* lagi.)"
          ].filter(Boolean).join("\n");

          if (media) await msg.reply(media, undefined, { caption });
          else await msg.reply(caption + (qrString ? `\n\nQR String:\n${qrString}` : ""));
          try{ await msg.react("✅"); }catch{}
          return;
        } catch (e) {
          console.error("qris:", e);
          const inv = await createMidtransInvoice({
            order_id, gross_amount: total, customer_phone: toID(from), product_name: `${p.nama} x ${qty}`
          });
          await msg.reply(["⚠️ QRIS sedang bermasalah, fallback ke link:", inv.redirect_url].join("\n"));
          try{ await msg.react("✅"); }catch{}
          return;
        }
      }

      await msg.reply("Provider pembayaran belum dikonfigurasi.");
      try{ await msg.react("❌"); }catch{}
      return;
    }

    if (/^#status\s+/i.test(text)) {
      const order_id = text.split(/\s+/)[1] || "";
      if (!order_id) { await msg.reply("Format: *#status <OrderID>*"); try{ await msg.react("❌"); }catch{} return; }
      try{
        const st = await midtransStatus(order_id);
        // contoh field: transaction_status, payment_type, gross_amount, transaction_time, settlement_time
        const status = (st.transaction_status || "-").toUpperCase();
        const payT   = mapPaymentType(st);
        const amt    = IDR(st.gross_amount || 0);
        const tTime  = indoDateTime(st.transaction_time || "");
        const sTime  = st.settlement_time ? "\n- Settled: "+indoDateTime(st.settlement_time) : "";
        await msg.reply([
          `📦 *Status Order* ${order_id}`,
          `- Status: ${status}`,
          `- Metode: ${payT}`,
          `- Nominal: ${amt}`,
          `- Dibuat: ${tTime}${sTime}`
        ].join("\n"));
        try{ await msg.react("✅"); }catch{}
      }catch(e){
        console.error("status:", e);
        await msg.reply("❌ OrderID tidak ditemukan atau belum ada transaksi.");
        try{ await msg.react("❌"); }catch{}
      }
      return;
    }

    // ---- Smart intent (hanya bila QUIET_MODE=false) ----
    if (isLikelyQuery(text)) {
      await loadData();
      const rawQ = cleanQuery(text);
      const mPage = rawQ.match(/\s+(\d{1,3})$/);
      const pageReq = mPage ? Number(mPage[1]) : 1;
      const q = mPage ? rawQ.replace(/\s+\d{1,3}$/, "").trim() : rawQ;

      const pByCode = byKode(q);
      if (pByCode) {
        const cap = [cardHeader(), cardProduk(pByCode)].join("\n\n");
        if (SHOW_PRODUCT_IMAGE && isHttp(pByCode.ikon)) {
          try { const media=await MessageMedia.fromUrl(pByCode.ikon); await msg.reply(media, undefined, { caption: cap }); }
          catch { await msg.reply(cap); }
        } else { await msg.reply(cap); }
        try{ await msg.react("✅"); }catch{}
        return;
      }

      const cats = categories();
      const catHit = cats.find(c => norm(c).includes(norm(q)));
      if (catHit) {
        const data = PRODUCTS.filter(p => norm(p.kategori).includes(norm(catHit)));
        const { items, page, total } = paginate(data, pageReq, 8);
        if (!items.length) { await msg.reply(`Tidak ada produk untuk kategori *${catHit}*.`); try{ await msg.react("❌"); }catch{} return; }
        const chunks = [cardHeader(), ...items.map(cardProduk)];
        chunks.push(`\nHalaman ${page}/${total} — ketik: *${catHit} ${page+1}* untuk berikutnya.`);
        await msg.reply(chunks.join("\n\n"));
        try{ await msg.react("✅"); }catch{}
        return;
      }

      const found = search(q);
      if (!found.length) { await msg.reply("❌ Tidak ditemukan. Coba ketik nama produk/kode yang lebih spesifik."); try{ await msg.react("❌"); }catch{} return; }
      if (found.length === 1) {
        const p = found[0];
        const cap = [cardHeader(), cardProduk(p)].join("\n\n");
        if (SHOW_PRODUCT_IMAGE && isHttp(p.ikon)) {
          try { const media=await MessageMedia.fromUrl(p.ikon); await msg.reply(media, undefined, { caption: cap }); }
          catch { await msg.reply(cap); }
        } else { await msg.reply(cap); }
        try{ await msg.react("✅"); }catch{}
        return;
      }

      const { items, page, total } = paginate(found, pageReq, 8);
      const chunks = [cardHeader(), ...items.map(cardProduk)];
      if (total > 1) chunks.push(`\nHalaman ${page}/${total} — ketik: *${q} ${page+1}* untuk berikutnya.`);
      await msg.reply(chunks.join("\n\n"));
      try{ await msg.react("✅"); }catch{}
      return;
    }

    // --- Fallback: hanya bila terlihat seperti command (#/!/slash) ---
    if (looksLikeCommand) {
      const lower = text.toLowerCase();
      const suggest = COMMANDS.filter(c => c.includes(lower.replace(/[#\s]+/g,""))).slice(0,4);
      let help = "❌ Perintah tidak ditemukan.\n";
      help += "Coba salah satu ini:\n• " + COMMANDS.join("\n• ");
      if (suggest.length) help = "❌ Perintah tidak ditemukan.\nMungkin maksud Anda:\n• " + suggest.join("\n• ");
      await msg.reply(help);
      try{ await msg.react("❌"); }catch{}
      return;
    }

    // Bukan command & bukan smart intent → diam (tanpa react)
    return;

  }catch(e){
    console.error("handler:", e);
    try{ await msg.reply("⚠️ Terjadi error. Coba lagi nanti."); }catch{}
    try{ await msg.react("❌"); }catch{}
  }
});

/* --------------- Lifecycle --------------- */
process.on("SIGINT", async ()=>{
  console.log("\n🛑 Shutting down...");
  try{ await client.destroy(); }catch{}
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("HTTP keepalive on :", PORT));

/* ==== Admin webhook secret ==== */
const ADMIN_SECRET = process.env.ADMIN_WEBHOOK_SECRET || "";

/* ==== Helper kirim pesan ke semua admin ==== */
async function notifyAdmins(text) {
  for (const jid of ADMIN_JIDS) {
    try { await client.sendMessage(jid, text); } catch {}
  }
}

/* ==== Endpoint: push-reload dari Sheets ==== */
app.post("/admin/reload", async (req, res) => {
  try {
    if (!ADMIN_SECRET || req.body?.secret !== ADMIN_SECRET) return res.status(401).send("forbidden");
    const what = (req.body?.what || "all").toLowerCase();
    if (what === "produk" || what === "all") { LAST = 0; await loadData(true); }
    if (what === "promo"  || what === "all") { LAST_PROMO = 0; await loadPromos(true); }
    if (req.body?.note) await notifyAdmins(`♻️ Reload diminta: ${req.body.note}`);
    return res.json({ ok:true, products: PRODUCTS.length, promos: PROMOS.length });
  } catch (e) {
    console.error("admin/reload:", e);
    return res.status(200).json({ ok:false, error: String(e) });
  }
});

/* ==== Endpoint: low-stock alert ==== */
app.post("/admin/lowstock", async (req, res) => {
  try {
    if (!ADMIN_SECRET || req.body?.secret !== ADMIN_SECRET) return res.status(401).send("forbidden");
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json({ ok:true });
    let msg = ["⚠️ *Low Stock Alert*"];
    for (const it of items) msg.push(`• ${it.kode}: ready ${it.ready}`);
    await notifyAdmins(msg.join("\n"));
    return res.json({ ok:true });
  } catch (e) {
    console.error("admin/lowstock:", e);
    return res.status(200).json({ ok:false, error: String(e) });
  }
});

client.initialize();
