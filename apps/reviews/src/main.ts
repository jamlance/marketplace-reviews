import "./index.css";
import {
  initBv,
  bvApi,
  type BvSession,
  mountShell,
  statRow,
  dataTable,
  card,
  emptyState,
  pill,
  flash,
  fmtDate,
  skeletonCard,
  h,
} from "./bv-init";

interface Config {
  enabled: boolean;
  headline: string;
  thank_you: string;
}
interface Stats {
  avg_rating: number;
  reviews: number;
  pending: number;
  reviewed: number;
  requests: number;
}
interface Review {
  id: number;
  rating: number;
  comment: string | null;
  customer_name: string | null;
  published: boolean;
  created_at: string;
}
interface ReqRow {
  id: number;
  order_ref: string;
  customer_name: string | null;
  contact: string | null;
  token: string;
  status: string;
  created_at: string;
  link: string;
}

let session: BvSession;
const stars = (n: number) => "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);

boot();

async function boot() {
  try {
    session = await initBv();
  } catch (err) {
    renderFatal(err);
    return;
  }
  mountShell({
    brandIcon: "star",
    brandLogo: "/logo.svg",
    title: "Reviews",
    subtitle: `${session.merchant.name || "Your store"} · ratings & reputation`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "overview", label: "Overview", icon: "star", render: renderOverview },
      { id: "requests", label: "Requests", icon: "send", render: renderRequests },
      { id: "reviews", label: "Reviews", icon: "user", render: renderReviews },
      { id: "settings", label: "Settings", icon: "settings", render: renderSettings },
    ],
  });
}

function renderFatal(err: unknown) {
  const root = document.getElementById("root")!;
  root.innerHTML = "";
  root.append(
    h(
      "div",
      { class: "bv-fatal" },
      h("strong", null, "Couldn't start"),
      h("p", { class: "bv-muted" }, (err as any)?.message || "No session token found."),
    ),
  );
}

async function renderOverview(host: HTMLElement) {
  host.innerHTML = "";
  host.append(skeletonCard());
  const data = await bvApi<{ config: Config; stats: Stats; recent: Review[] }>("/api/overview").catch(() => null);
  host.innerHTML = "";
  if (!data) {
    host.append(emptyState({ icon: "alert", title: "Couldn't load", text: "Please try again." }));
    return;
  }
  const s = data.stats;
  const rate = s.requests ? Math.round((s.reviewed / s.requests) * 100) : 0;
  host.append(
    statRow([
      { k: "Avg rating", v: `${Number(s.avg_rating).toFixed(2)} ★`, icon: "star", tone: "accent" },
      { k: "Reviews", v: String(s.reviews), icon: "user", tone: "ok" },
      { k: "Pending asks", v: String(s.pending), icon: "send" },
      { k: "Response rate", v: `${rate}%`, icon: "trending-up" },
    ]),
  );
  host.append(
    card({
      title: "Ask for reviews",
      action: h("button", { class: "primary", onClick: () => doSync(host) }, "Create requests from recent orders"),
      body: h("p", { class: "bv-muted" }, "Turns recent paid orders into review requests with a shareable link. Find the links under the Requests tab."),
    }),
  );
  host.append(
    card({
      title: "Recent reviews",
      body: data.recent.length
        ? dataTable<Review>({
            columns: [
              { head: "When", cell: (r) => fmtDate(r.created_at) },
              { head: "Rating", cell: (r) => h("span", { style: { color: "var(--accent)" } }, stars(r.rating)) },
              { head: "Comment", cell: (r) => r.comment || "—" },
              { head: "From", cell: (r) => r.customer_name || "Customer" },
            ],
            rows: data.recent,
          })
        : emptyState({ icon: "star", title: "No reviews yet", text: "Create requests from orders, then share the links." }),
    }),
  );
}

async function doSync(host: HTMLElement) {
  const r = await bvApi<{ created: number; disabled?: boolean }>("/api/sync", { method: "POST" }).catch(() => null);
  if (!r) return flash("Sync failed", "error");
  if (r.disabled) return flash("Review asks are off — enable in Settings.", "warning");
  flash(r.created ? `Created ${r.created} new review request(s).` : "No new paid orders to ask.", r.created ? "success" : "info");
  renderOverview(host);
}

async function renderRequests(host: HTMLElement) {
  host.innerHTML = "";
  host.append(skeletonCard());
  const d = await bvApi<{ requests: ReqRow[] }>("/api/requests").catch(() => ({ requests: [] as ReqRow[] }));
  host.innerHTML = "";
  host.append(
    card({
      title: "Outstanding requests",
      body: d.requests.length
        ? dataTable<ReqRow>({
            columns: [
              { head: "Order", cell: (r) => r.order_ref },
              { head: "Customer", cell: (r) => r.customer_name || "—" },
              { head: "Contact", cell: (r) => r.contact || "—" },
              { head: "When", cell: (r) => fmtDate(r.created_at) },
            ],
            rows: d.requests,
            rowActions: (r) =>
              h("button", { class: "secondary", onClick: () => copyLink(r.link) }, "Copy link"),
          })
        : emptyState({ icon: "send", title: "No pending requests", text: "Create requests from recent orders on the Overview tab." }),
    }),
  );
}

function copyLink(link: string) {
  navigator.clipboard?.writeText(link).then(
    () => flash("Review link copied — share it with the customer.", "success"),
    () => flash(link, "info"),
  );
}

async function renderReviews(host: HTMLElement) {
  host.innerHTML = "";
  host.append(skeletonCard());
  const d = await bvApi<{ reviews: Review[] }>("/api/reviews").catch(() => ({ reviews: [] as Review[] }));
  host.innerHTML = "";
  host.append(
    card({
      title: "All reviews",
      body: d.reviews.length
        ? dataTable<Review>({
            columns: [
              { head: "When", cell: (r) => fmtDate(r.created_at) },
              { head: "Rating", cell: (r) => h("span", { style: { color: "var(--accent)" } }, stars(r.rating)) },
              { head: "Comment", cell: (r) => r.comment || "—" },
              { head: "From", cell: (r) => r.customer_name || "Customer" },
              { head: "Shown", cell: (r) => (r.published ? pill("public", "ok") : pill("hidden", "")) },
            ],
            rows: d.reviews,
            rowActions: (r) =>
              h("button", { class: "ghost", onClick: () => togglePublish(r.id, host) }, r.published ? "Hide" : "Show"),
          })
        : emptyState({ icon: "star", title: "No reviews yet" }),
    }),
  );
}

async function togglePublish(id: number, host: HTMLElement) {
  await bvApi(`/api/reviews/${id}/publish`, { method: "POST" }).catch(() => null);
  renderReviews(host);
}

async function renderSettings(host: HTMLElement) {
  host.innerHTML = "";
  host.append(skeletonCard());
  const cfg = (await bvApi<{ config: Config }>("/api/config").catch(() => null))?.config;
  host.innerHTML = "";
  if (!cfg) {
    host.append(emptyState({ icon: "alert", title: "Couldn't load settings" }));
    return;
  }
  const headline = h("input", { type: "text", value: cfg.headline }) as HTMLInputElement;
  const thanks = h("input", { type: "text", value: cfg.thank_you }) as HTMLInputElement;
  const enabled = h("input", { type: "checkbox" }) as HTMLInputElement;
  enabled.checked = cfg.enabled;
  const save = h(
    "button",
    {
      class: "primary",
      onClick: async () => {
        const r = await bvApi("/api/config", {
          method: "POST",
          body: JSON.stringify({ headline: headline.value, thank_you: thanks.value, enabled: enabled.checked }),
        }).catch(() => null);
        flash(r ? "Settings saved" : "Save failed", r ? "success" : "error");
      },
    },
    "Save settings",
  );
  host.append(
    card({
      title: "Review form",
      action: save,
      body: h(
        "div",
        { class: "bv-stack" },
        field("Form headline", headline),
        field("Thank-you message", thanks),
        h("label", { class: "bv-row" }, enabled, h("span", null, "Ask for reviews after paid orders")),
      ),
    }),
  );
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h("div", { class: "bv-field" }, h("label", { class: "bv-label" }, label), input);
}
