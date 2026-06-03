/**
 * Reviews / Reputation collection — backend.
 *
 * Self-contained: turns the merchant's paid Inkress orders (orders:read) into
 * review requests with a public link, collects ratings via a public form
 * (/r/:token, no session), and computes a reputation score. State lives in its
 * own Postgres schema (reviews). The Inkress access token never leaves here.
 *
 *   GET  /api/overview              KPIs (avg rating, reviews, pending) + recent
 *   GET/POST /api/config            ask settings
 *   POST /api/sync                  paid orders → pending review requests (link)
 *   GET  /api/requests              outstanding requests + their public link
 *   GET  /api/reviews               collected reviews
 *   POST /api/reviews/:id/publish   show/hide a review
 *   GET  /r/:token                  public review form (customer)
 *   POST /r/:token                  public submit rating + comment
 */
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const BASE = process.env.PUBLIC_BASE_URL || "";

for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) {
    console.error(`[reviews] Missing env: ${k}`);
    process.exit(1);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  merchant_id bigint PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT true,
  headline    text NOT NULL DEFAULT 'How was your experience?',
  thank_you   text NOT NULL DEFAULT 'Thanks for your feedback!',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS requests (
  id           bigserial PRIMARY KEY,
  merchant_id  bigint NOT NULL,
  order_ref    text NOT NULL,
  customer_ref text,
  contact      text,
  customer_name text,
  token        text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz
);
CREATE TABLE IF NOT EXISTS reviews (
  id            bigserial PRIMARY KEY,
  merchant_id   bigint NOT NULL,
  request_id    bigint,
  rating        integer NOT NULL,
  comment       text,
  customer_name text,
  published     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS requests_order_idx ON requests (merchant_id, order_ref);
CREATE INDEX IF NOT EXISTS reviews_merchant_idx ON reviews (merchant_id, created_at DESC);
`;

const app = express();
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE,
  frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const db = await openPg("reviews", SCHEMA);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const token = () => crypto.randomBytes(9).toString("base64url");
const PAID = new Set(["paid", "confirmed", "prepared", "shipped", "delivered", "completed", "fulfilled"]);

async function getConfig(mid) {
  let c = await db.one("SELECT * FROM config WHERE merchant_id=$1", [mid]);
  if (!c) {
    await db.run("INSERT INTO config (merchant_id) VALUES ($1) ON CONFLICT DO NOTHING", [mid]);
    c = await db.one("SELECT * FROM config WHERE merchant_id=$1", [mid]);
  }
  return c;
}

app.get("/api/overview", core.requireSession, async (req, res) => {
  try {
    const mid = req.session.merchantId;
    const config = await getConfig(mid);
    const stats = await db.one(
      `SELECT
         (SELECT coalesce(round(avg(rating)::numeric,2),0) FROM reviews WHERE merchant_id=$1) AS avg_rating,
         (SELECT count(*) FROM reviews WHERE merchant_id=$1) AS reviews,
         (SELECT count(*) FROM requests WHERE merchant_id=$1 AND status='pending') AS pending,
         (SELECT count(*) FROM requests WHERE merchant_id=$1 AND status='reviewed') AS reviewed,
         (SELECT count(*) FROM requests WHERE merchant_id=$1) AS requests`,
      [mid],
    );
    const recent = await db.q(
      "SELECT id, rating, comment, customer_name, published, created_at FROM reviews WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 12",
      [mid],
    );
    res.json({ config, stats, recent });
  } catch (err) {
    res.status(500).json({ error: "overview_failed", message: err?.message });
  }
});

app.get("/api/config", core.requireSession, async (req, res) => {
  res.json({ config: await getConfig(req.session.merchantId) });
});
app.post("/api/config", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  await getConfig(mid);
  const b = req.body || {};
  await db.run(
    "UPDATE config SET enabled=$2, headline=$3, thank_you=$4, updated_at=now() WHERE merchant_id=$1",
    [mid, b.enabled !== false, String(b.headline || "How was your experience?").slice(0, 140), String(b.thank_you || "Thanks for your feedback!").slice(0, 200)],
  );
  res.json({ config: await getConfig(mid) });
});

app.post("/api/sync", core.requireSession, async (req, res) => {
  try {
    const mid = req.session.merchantId;
    const cfg = await getConfig(mid);
    if (!cfg.enabled) return res.json({ created: 0, disabled: true });
    const r = await core.callInkress(req.session, "orders?limit=200&order=id desc").catch(() => null);
    const orders = r?.result?.entries || r?.result || [];
    let created = 0;
    for (const o of orders) {
      const status = (o.status_name || o.status || "").toString().toLowerCase();
      if (!PAID.has(status)) continue;
      const ref = String(o.id ?? o.code ?? "");
      if (!ref) continue;
      const c = o.customer || {};
      const r2 = await db.run(
        `INSERT INTO requests (merchant_id, order_ref, customer_ref, contact, customer_name, token)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (merchant_id, order_ref) DO NOTHING`,
        [mid, ref, String(c.id ?? o.customer_id ?? ""), c.phone || c.email || null, c.name || o.customer_name || "Customer", token()],
      );
      if (r2.rowCount) created += 1;
    }
    res.json({ created });
  } catch (err) {
    res.status(502).json({ error: "sync_failed", message: err?.message });
  }
});

app.get("/api/requests", core.requireSession, async (req, res) => {
  const rows = await db.q(
    "SELECT id, order_ref, customer_name, contact, token, status, created_at FROM requests WHERE merchant_id=$1 AND status IN ('pending','sent') ORDER BY created_at DESC LIMIT 200",
    [req.session.merchantId],
  );
  res.json({ requests: rows.map((r) => ({ ...r, link: `${BASE}/r/${r.token}` })) });
});

app.get("/api/reviews", core.requireSession, async (req, res) => {
  res.json({
    reviews: await db.q(
      "SELECT id, rating, comment, customer_name, published, created_at FROM reviews WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 300",
      [req.session.merchantId],
    ),
  });
});

app.post("/api/reviews/:id/publish", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const id = parseInt(req.params.id, 10);
  await db.run("UPDATE reviews SET published = NOT published WHERE id=$1 AND merchant_id=$2", [id, mid]);
  res.json({ ok: true });
});

// ---- public review form (no session) -----------------------------------
function page(body) {
  return `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Leave a review</title><style>
  body{font:16px/1.5 system-ui,sans-serif;background:#faf7f5;margin:0;color:#1f2430;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;border:1px solid #ece8e4;border-radius:18px;padding:30px;max-width:440px;width:92%;box-shadow:0 8px 30px rgba(30,20,40,.06)}
  h1{font-size:21px;margin:0 0 4px}.muted{color:#7a7268;font-size:14px;margin:0 0 18px}
  .stars{display:flex;gap:8px;font-size:38px;cursor:pointer;margin:6px 0 16px}.star{color:#e2ddd6;transition:.1s}.star.on{color:#f5a623}
  textarea{width:100%;box-sizing:border-box;border:1px solid #e2ddd6;border-radius:11px;padding:11px;font:inherit;min-height:90px;resize:vertical}
  button{margin-top:16px;width:100%;background:#f5a623;color:#1f2430;border:0;border-radius:11px;padding:13px;font:600 16px system-ui;cursor:pointer}
  </style></head><body><div class=card>${body}</div></body></html>`;
}

app.get("/r/:token", async (req, res) => {
  const reqRow = await db.one("SELECT * FROM requests WHERE token=$1", [req.params.token]);
  if (!reqRow) return res.status(404).send(page("<h1>Link not found</h1><p class=muted>This review link is invalid.</p>"));
  if (reqRow.status === "reviewed") return res.send(page("<h1>Already reviewed</h1><p class=muted>Thanks — you've already left a rating for this order.</p>"));
  const cfg = await getConfig(reqRow.merchant_id);
  res.send(page(`
    <h1>${esc(cfg.headline)}</h1>
    <p class=muted>Tap a star to rate, and add a note if you like.</p>
    <form method=post action="/r/${esc(req.params.token)}">
      <input type=hidden name=rating id=rating value="5">
      <div class=stars id=stars>${[1, 2, 3, 4, 5].map((n) => `<span class="star on" data-n="${n}">★</span>`).join("")}</div>
      <textarea name=comment placeholder="What stood out? (optional)"></textarea>
      <button type=submit>Submit review</button>
    </form>
    <script>
      var r=document.getElementById('rating'),ss=[].slice.call(document.querySelectorAll('.star'));
      ss.forEach(function(s){s.onclick=function(){var n=+s.dataset.n;r.value=n;ss.forEach(function(x){x.classList.toggle('on',+x.dataset.n<=n)})}});
    </script>`));
});

app.post("/r/:token", async (req, res) => {
  const reqRow = await db.one("SELECT * FROM requests WHERE token=$1", [req.params.token]);
  if (!reqRow) return res.status(404).send(page("<h1>Link not found</h1>"));
  if (reqRow.status === "reviewed") return res.send(page("<h1>Already reviewed</h1>"));
  const rating = Math.min(5, Math.max(1, parseInt(req.body?.rating, 10) || 5));
  const comment = String(req.body?.comment || "").slice(0, 1000);
  const cfg = await getConfig(reqRow.merchant_id);
  await db.tx(async (cx) => {
    await cx.query(
      "INSERT INTO reviews (merchant_id, request_id, rating, comment, customer_name) VALUES ($1,$2,$3,$4,$5)",
      [reqRow.merchant_id, reqRow.id, rating, comment || null, reqRow.customer_name],
    );
    await cx.query("UPDATE requests SET status='reviewed', reviewed_at=now() WHERE id=$1", [reqRow.id]);
  });
  res.send(page(`<h1>${esc(cfg.thank_you)}</h1><p class=muted>Your ${rating}-star rating was recorded. 🙏</p>`));
});

app.listen(PORT, HOST, () => console.log(`[reviews] listening on ${HOST}:${PORT}`));
