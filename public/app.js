const root = document.querySelector("#app"),
  modal = document.querySelector("#modal");
const state = {
  me: null,
  view: "overview",
  selected: null,
  providerKind: "gmail",
  provider: null,
  contacts: [],
  contactOffset: 0,
  auth: "login",
  signupEnabled: true,
};
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (v) => Number(v || 0).toLocaleString();
const date = (v) =>
  v
    ? new Date(v).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
const titles = {
  overview: "Overview",
  campaigns: "Campaigns",
  contacts: "Audience",
  providers: "Email providers",
  integrations: "Integrations",
  settings: "Settings",
};
const icon = {
  overview: "◫",
  campaigns: "↗",
  contacts: "♧",
  providers: "⌘",
  integrations: "⟨⟩",
  settings: "⚙",
};
const badge = (v) => `<span class="pill ${esc(v)}">${esc(v)}</span>`;
async function api(path, options = {}) {
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body && new TextEncoder().encode(body).length > 4 * 1024 * 1024)
    throw new Error(
      "This request is too large. Split the import into smaller files.",
    );
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    body,
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.me) {
      state.me = null;
      authView();
    }
    throw new Error(data.error || "Request failed.");
  }
  return data;
}
let toastTimer;
function toast(message, error = false) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.className = `visible ${error ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.className = ""), 6500);
}
let fieldSequence = 0;
function field(name, label, value = "", type = "text", extra = "", help = "") {
  const inputId = `field-${name}-${++fieldSequence}`;
  return `<div class="field"><label for="${inputId}">${label}</label><input id="${inputId}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>${help ? `<small>${help}</small>` : ""}</div>`;
}
function empty(title, text, action, label) {
  return `<div class="empty"><div class="empty-symbol">✉</div><h3>${title}</h3><p>${text}</p>${action ? `<button class="secondary" data-action="${action}">${label}</button>` : ""}</div>`;
}
function heading(title, description, action = "", label = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${action ? `<button data-action="${action}">${label}</button>` : ""}</div>`;
}
function authView() {
  const register = state.auth === "register";
  root.innerHTML = `<main class="auth"><section class="auth-story"><div class="brand"><span class="brand-icon">✉</span>maildesk</div><div class="auth-copy"><span class="auth-badge">YOUR EMAIL. YOUR PROVIDER.</span><h1>A better home<br>for every send.</h1><p>Connect your email provider, bring your audience, and send thoughtful campaigns. All in one workspace.</p><div class="auth-feature"><span>✓</span>AWS SES, Gmail, or your own SMTP</div><div class="auth-feature"><span>✓</span>A private workspace for every company</div><div class="auth-feature"><span>✓</span>Campaigns and an API that work together</div></div><div class="auth-footer">Built for teams that want to stay in control.</div></section><section class="auth-form"><h2>${register ? "Create your workspace" : "Welcome back"}</h2><p>${register ? "One company. One private place for your email." : "Sign in to your company’s email workspace."}</p><form id="auth-form">${register ? field("company", "Company name", "", "text", 'required maxlength="120" placeholder="Acme Studio"') : ""}${field("email", "Work email", "", "email", 'required autocomplete="username" placeholder="you@company.com"')}${field("password", "Password", "", "password", `required minlength="12" maxlength="128" autocomplete="${register ? "new-password" : "current-password"}"`, register ? "Use at least 12 characters." : "")}<div id="auth-error" class="error" role="alert"></div><button type="submit">${register ? "Create workspace →" : "Sign in →"}</button></form>${state.signupEnabled ? `<div class="auth-switch">${register ? "Already have a workspace?" : "New to Maildesk?"} <button class="ghost" data-action="auth-switch">${register ? "Sign in" : "Create a workspace"}</button></div>` : ""}</section></main>`;
}
function shell() {
  const org = state.me.organization;
  root.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#overview"><span class="brand-icon">✉</span>maildesk</a><div class="workspace"><span class="avatar">${esc(org.name.slice(0, 1).toUpperCase())}</span><div><strong>${esc(org.name)}</strong><small>Company workspace</small></div></div><div class="nav-label">Workspace</div><nav class="nav">${Object.keys(
    titles,
  )
    .map(
      (key) =>
        `<a href="#${key}" class="${key === state.view ? "active" : ""}"><span class="nav-icon">${icon[key]}</span>${titles[key]}</a>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-bottom"><div class="tenant-note">Your company’s contacts, credentials, and campaigns stay in this workspace.</div></div></aside><main class="main"><header class="topbar"><div class="crumb">Workspace <span>/ &nbsp;${titles[state.view]}</span></div><div class="account"><span class="email">${esc(state.me.email)}</span><span class="avatar">${esc(state.me.email[0].toUpperCase())}</span><button class="ghost" data-action="logout">Sign out</button></div></header><div class="content" id="content"><div class="loading">Loading your workspace…</div></div></main></div>`;
}
let renderVersion = 0;
async function render() {
  if (!state.me) return authView();
  state.view = titles[location.hash.slice(1)]
    ? location.hash.slice(1)
    : "overview";
  const version = ++renderVersion;
  shell();
  try {
    const html = await views[state.view]();
    if (version === renderVersion && state.me)
      document.querySelector("#content").innerHTML = html;
  } catch (error) {
    if (version === renderVersion && state.me)
      document.querySelector("#content").innerHTML =
        `<div class="card"><h2>We couldn’t load this page</h2><p>${esc(error.message)}</p><button data-action="refresh">Try again</button></div>`;
  }
}
const views = {
  async overview() {
    const [data, campaigns] = await Promise.all([
      api("/dashboard"),
      api("/v1/campaigns"),
    ]);
    state.provider = data.provider;
    const accepted =
      data.outcomes.find((o) => o.status === "accepted")?.count || 0;
    const ready = !!data.provider?.verifiedAt;
    return (
      heading(
        "Your email, at a glance",
        "A little clarity before your next big send.",
        "new-campaign",
        "＋ Create campaign",
      ) +
      `<div class="stats">${[
        [
          "Send attempts this month",
          data.usage.monthly,
          "of 100,000 monthly allowance",
          "↗",
        ],
        [
          "Accepted by provider",
          accepted,
          "Provider acceptance, not delivery",
          "✓",
        ],
        [
          "Audience contacts",
          data.contacts,
          `${fmt(data.suppressed)} suppressed addresses`,
          "♧",
        ],
        [
          "Email provider",
          data.provider ? data.provider.kind.toUpperCase() : "Not connected",
          ready ? "Connection checked" : "Connect a provider to start",
          "⌘",
        ],
      ]
        .map(
          ([label, value, sub, symbol]) =>
            `<article class="stat"><div class="stat-label">${label}<span class="mini-icon">${symbol}</span></div><div class="stat-value">${typeof value === "number" ? fmt(value) : value}</div><small>${sub}</small></article>`,
        )
        .join("")}</div>
      ${!ready ? `<section class="card hero"><div><div class="eyebrow">Make yourself at home</div><h2>Your next campaign starts here.</h2><p>Bring an AWS SES account, connect Gmail with an app password, or use your own SMTP provider. We’ll help you check the connection.</p><button data-action="go-providers">Connect email provider →</button></div><div class="hero-art"><div class="envelope">✉</div></div></section>` : ""}
      <div class="two-col"><section class="card flush"><div class="card-header"><h2>Recent campaigns</h2><a href="#campaigns">View all ↗</a></div>${campaigns.length ? campaignTable(campaigns.slice(0, 5)) : empty("Good things start with a first send", "Once you create a campaign, you can follow its progress here.", "new-campaign", "Create your first campaign")}</section><div><section class="card"><div class="card-header"><h2>Your setup checklist</h2><span class="pill">${[ready, !!data.contacts, !!state.me.organization.address].filter(Boolean).length} / 3</span></div><ul class="checklist">${[
        [
          ready,
          "Connect an email provider",
          "Choose SES, Gmail, or custom SMTP.",
          "providers",
        ],
        [
          !!state.me.organization.address,
          "Add your company address",
          "Included in your campaign footer.",
          "settings",
        ],
        [
          !!data.contacts,
          "Bring your audience",
          "Import a CSV or connect your app.",
          "contacts",
        ],
      ]
        .map(
          ([done, title, sub, view], i) =>
            `<li><span class="step ${done ? "done" : ""}">${done ? "✓" : i + 1}</span><div><a href="#${view}"><strong>${title}</strong></a><small>${sub}</small></div></li>`,
        )
        .join(
          "",
        )}</ul></section><section class="card"><h3>A note on sending limits</h3><p>Maildesk allows up to 100,000 attempts per company each month. Your provider’s quota may be lower. Gmail is best for smaller sends.</p><a href="#providers">Manage provider settings →</a></section></div></div>`
    );
  },
  async campaigns() {
    if (state.selected === "new") return composer();
    if (state.selected) {
      const detail = await api(`/v1/campaigns/${state.selected}`);
      state.detail = detail;
      return campaignDetail(detail);
    }
    const campaigns = await api("/v1/campaigns");
    return (
      heading(
        "Campaigns",
        "Create, review, and keep track of every send.",
        "new-campaign",
        "＋ Create campaign",
      ) +
      `<section class="card flush"><div class="card-header"><h2>All campaigns</h2><span class="pill">${campaigns.length} campaigns</span></div>${campaigns.length ? campaignTable(campaigns) : empty("Your audience is waiting", "Create a campaign with a subject, message, and a snapshot of your subscribed contacts.", "new-campaign", "Create campaign")}</section><p><small>Showing up to 100 recent campaigns. Accepted means your provider received the message; it does not confirm inbox delivery.</small></p>`
    );
  },
  async contacts() {
    const data = await api(`/v1/contacts?offset=${state.contactOffset}`);
    state.contacts = data.contacts;
    return (
      heading(
        "Your audience",
        "A company-owned contact list, with consent at its core.",
        "add-contact",
        "＋ Add contact",
      ) +
      `<div class="two-col"><section class="card"><div class="card-header"><h2>Import from CSV</h2><span class="pill">Up to 100,000 contacts</span></div><p>Use <strong>email,name</strong> column headers. Duplicate addresses are skipped; unsubscribed addresses stay suppressed.</p><form id="import-form"><label class="upload">Choose a CSV file, up to 3 MB<input type="file" name="file" accept=".csv,text/csv" required></label>${field("consent", "How did these contacts opt in?", "", "text", 'required maxlength="300" placeholder="Newsletter signup on our website"')}<button type="submit">Import contacts</button></form></section><section class="card"><h2>Bring contacts from your app</h2><p>Use a company API key to sync contacts from your CMS, storefront, or another application.</p><a href="#integrations">Explore the API →</a><div class="split-title"><h3>Consent stays with every contact</h3></div><p>Import only people who agreed to receive your emails. Unsubscribes are applied to future sends across this company’s campaigns.</p></section></div><section class="card flush"><div class="card-header"><h2>Contacts</h2><span class="pill">${fmt(data.total)} total</span></div>${data.contacts.length ? `<div class="table-wrap"><table><thead><tr><th>Contact</th><th>Consent source</th><th>Status</th><th></th></tr></thead><tbody>${data.contacts.map((c) => `<tr><td>${esc(c.name || c.email)}<small>${esc(c.email)}</small></td><td>${esc(c.consent)}</td><td>${badge(c.suppression || "subscribed")}</td><td>${!c.suppression ? `<button class="ghost" data-action="suppress" data-email="${esc(c.email)}">Suppress</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : empty("No contacts yet", "Add a contact, import your CSV, or connect an app.")}</section><div class="inline">${state.contactOffset ? '<button class="secondary" data-action="contacts-prev">Previous 500</button>' : ""}${state.contactOffset + 500 < data.total ? '<button class="secondary" data-action="contacts-next">Next 500</button>' : ""}</div>`
    );
  },
  async providers() {
    state.provider = await api("/provider");
    const saved = state.provider;
    if (!state.providerChosen) state.providerKind = saved?.kind || "gmail";
    const kind = state.providerKind,
      c = saved?.kind === kind ? saved : {};
    return (
      heading(
        "Connect your email provider",
        "Choose how your company sends. Your credentials are encrypted on the server.",
      ) +
      `<div class="provider-options">${[
        ["ses", "aws", "Amazon SES", "For growing lists and larger campaigns."],
        ["gmail", "G", "Gmail", "Use your Google account’s app password."],
        ["smtp", "✉", "Custom SMTP", "Bring an existing email service."],
      ]
        .map(
          ([id, logo, name, desc]) =>
            `<button class="provider-option ${kind === id ? "selected" : ""}" data-action="provider-kind" data-kind="${id}"><span class="provider-logo">${logo}</span>${name}<small>${desc}</small></button>`,
        )
        .join("")}</div>
      <div class="two-col"><section class="card"><div class="card-header"><h2>${kind === "ses" ? "AWS SES" : kind === "gmail" ? "Gmail" : "SMTP"} configuration</h2>${c.verifiedAt ? '<span class="pill green">✓ Connection checked</span>' : '<span class="pill">Needs connection check</span>'}</div><form id="provider-form"><input type="hidden" name="kind" value="${kind}"><div class="form-grid">
      ${
        kind === "ses"
          ? `${field("region", "AWS region", c.region || "ap-southeast-1", "text", 'required placeholder="ap-southeast-1"')}${field("dailyLimit", "Daily send limit", c.dailyLimit || 5000, "number", 'required min="1" max="100000"')}${field("accessKeyId", "Access key ID", "", "password", `autocomplete="off" ${c.hasCredentials ? "" : "required"}`, c.hasCredentials ? "Saved securely. Leave blank to keep it." : "Use a dedicated IAM identity with SES permissions.")}${field("secretAccessKey", "Secret access key", "", "password", `autocomplete="new-password" ${c.hasCredentials ? "" : "required"}`)}${field("sessionToken", "Session token (optional)", "", "password", 'autocomplete="new-password"')}${field("configurationSet", "Configuration set (optional)", c.configurationSet || "")}`
          : `${kind === "smtp" ? `${field("host", "SMTP hostname", c.host || "", "text", 'required placeholder="smtp.example.com"')}<div class="field"><label for="port">Connection security</label><select name="port" id="port"><option value="465" ${c.port === 587 ? "" : "selected"}>Port 465 · TLS</option><option value="587" ${c.port === 587 ? "selected" : ""}>Port 587 · STARTTLS</option></select><small>Encrypted connections are required.</small></div>` : ""}${field("username", kind === "gmail" ? "Gmail address" : "SMTP username", c.username || "", kind === "gmail" ? "email" : "text", 'required autocomplete="off"')}${field("password", kind === "gmail" ? "Google app password" : "SMTP password", "", "password", `autocomplete="new-password" ${c.hasCredentials ? "" : "required"}`, c.hasCredentials ? "Leave blank to keep the saved password." : kind === "gmail" ? "Never use your normal Google password." : "Use the SMTP credentials supplied by your provider.")}${field("dailyLimit", "Daily send limit", c.dailyLimit || (kind === "gmail" ? 10 : 1000), "number", `required min="1" max="${kind === "gmail" ? 500 : 100000}"`)}${kind === "gmail" ? '<div class="notice span-2">Gmail preset: smtp.gmail.com · port 465 · TLS. Your Gmail address is used as the sender. This preset uses an app password, not Google OAuth.</div>' : ""}`
      }
      ${field("fromName", "Sender name", c.fromName || state.me.organization.name, "text", 'required maxlength="100"')}${kind !== "gmail" ? field("from", "Sender email", c.from || "", "email", 'required placeholder="hello@company.com"') : ""}${field("replyTo", "Reply-to email (optional)", c.replyTo || "", "email")}</div><div class="form-actions"><button type="submit">Save configuration</button><span class="muted">Saving requires a new connection check.</span></div></form></section>
      <div><section class="card"><h2>${kind === "ses" ? "Before connecting AWS" : kind === "gmail" ? "Connect your Gmail account" : "A few details from your provider"}</h2><ol class="help-list">${kind === "ses" ? "<li>Verify your sender or domain in the selected AWS region and publish the DKIM DNS records.</li><li>Request SES production access. Campaigns stay blocked while the account is in the sandbox.</li><li>Grant <code>ses:SendEmail</code>, <code>ses:GetAccount</code>, and <code>ses:GetEmailIdentity</code> to a dedicated IAM identity.</li><li>Set a daily limit within your SES quota and configure bounce/complaint handling in AWS.</li>" : kind === "gmail" ? "<li>Turn on 2-Step Verification for your Google account.</li><li>Create an app password for Maildesk and paste it into the password field.</li><li>Use a small daily limit. Your Google account’s sending limits still apply.</li><li>If app passwords are unavailable for your account, use another SMTP provider or AWS SES.</li>" : "<li>Find your SMTP hostname, username, and password in your email provider’s dashboard.</li><li>Choose port 465 with TLS or 587 with STARTTLS.</li><li>Use a sender address that your provider authorizes.</li><li>Set a daily limit within your provider’s allowance.</li>"}</ol><a target="_blank" rel="noreferrer" href="${kind === "ses" ? "https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html" : kind === "gmail" ? "https://support.google.com/accounts/answer/185833" : "https://nodemailer.com/smtp"}">Read setup instructions ↗</a></section>
      ${saved ? `<section class="card"><h2>Check your saved connection</h2><p>These actions use the configuration you last saved.</p>${saved.info ? `<div class="notice ${saved.verifiedAt ? "success" : "warning"}">${esc(saved.info.summary)}</div>` : ""}<button class="secondary" data-action="verify-provider">Check connection</button><form id="test-form"><div class="split-title"><h3>Send a test email</h3></div>${field("to", "Recipient email", state.me.email, "email", "required")}<button type="submit" ${saved.verifiedAt ? "" : "disabled"}>Send test email</button><small>Counts toward your sending allowance.</small></form></section>` : ""}</div></div>`
    );
  },
  async integrations() {
    const keys = await api("/keys");
    return (
      heading(
        "Connect your applications",
        "Use company-scoped API keys to sync contacts and create campaigns.",
      ) +
      `<div class="two-col"><section class="card"><div class="card-header"><h2>API keys</h2><span class="pill">${keys.length} / 10</span></div><form id="key-form" class="inline"><input name="name" aria-label="API key name" placeholder="e.g. PawnHero CMS" required maxlength="100"><button>Create key</button></form><div id="new-key"></div>${keys.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Key</th><th></th></tr></thead><tbody>${keys.map((k) => `<tr><td>${esc(k.name)}<small>${date(k.created_at)}</small></td><td><code>${esc(k.prefix)}…</code></td><td><button class="ghost" data-action="revoke-key" data-id="${esc(k.id)}">Revoke</button></td></tr>`).join("")}</tbody></table></div>` : empty("No integration keys", "Create a key for your application. The full key is shown only once.")}</section><section class="card"><h2>A private key for your company</h2><p>Keys can access only this company’s contacts and campaigns. Store them on your application’s server, never in browser code.</p><p>Provider settings and credentials are available only through the signed-in web UI.</p></section></div><section class="card"><h2>1. Add opted-in contacts</h2><pre class="code">${esc(`curl '${location.origin}/api/v1/contacts' \\n  -H 'Authorization: Bearer YOUR_API_KEY' \\n  -H 'Content-Type: application/json' \\n  -d '{"contacts":[{"email":"reader@example.com","name":"Alex"}],"consent":"Website newsletter signup"}'`.replace(/\\n/g, "\\\n"))}</pre><h2>2. Create a draft campaign</h2><pre class="code">${esc(`POST /api/v1/campaigns\nAuthorization: Bearer YOUR_API_KEY\nIdempotency-Key: newsletter-september-2026\n\n{"name":"September update","subject":"A little news","body":"Hello from our team!","audience":"all"}`)}</pre><p>Review the draft in Campaigns, then confirm and send. To queue through the API, use <code>POST /api/v1/campaigns/:id/start</code> with <code>{"confirmConsent":true}</code>. Provider and company setup checks still apply.</p></section>`
    );
  },
  async settings() {
    const c = state.me.organization;
    return (
      heading("Company settings", "The details that make your emails yours.") +
      `<div class="two-col"><section class="card"><h2>Company profile</h2><form id="settings-form">${field("name", "Company name", c.name, "text", 'required maxlength="120"')}<div class="field"><label for="address">Company postal address</label><textarea id="address" name="address" required maxlength="500" placeholder="Street address, city, region, postal code, country">${esc(c.address)}</textarea><small>Included in every campaign footer, together with an unsubscribe link.</small></div><button>Save company details</button></form></section><section class="card"><h2>Your workspace</h2><p><strong>${esc(state.me.email)}</strong><br>Workspace owner</p><p>Contacts, campaigns, API keys, and provider credentials are isolated from other companies.</p><div class="notice">This version has one owner account per company. Team invitations and account recovery are not enabled.</div></section></div>`
    );
  },
};
function campaignTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Audience</th><th>Created</th></tr></thead><tbody>${items.map((c) => `<tr><td><button class="table-link" data-action="open-campaign" data-id="${esc(c.id)}">${esc(c.name)}<small>${esc(c.subject)}</small></button></td><td>${badge(c.status)}</td><td>${fmt(c.recipient_count)}</td><td>${date(c.created_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
function previewMarkup(preview) {
  if (!preview)
    return '<p class="muted">Click Preview message to see how this draft will look.</p>';
  if (preview.html)
    return `<iframe class="email-preview" title="HTML email preview" sandbox="" referrerpolicy="no-referrer" src="${esc(preview.url)}"></iframe><p class="preview-note">External images are blocked and links are disabled in this preview. Email clients may render the layout differently.</p><details class="text-alternative"><summary>Plain-text fallback</summary><pre class="preview">${esc(preview.text)}</pre></details>`;
  return `<pre class="preview">${esc(preview.text)}</pre>`;
}
function composer(c = {}) {
  const format = c.content_type || "html";
  return (
    heading(
      c.id ? "Edit draft" : "Create a campaign",
      "Your subscribed audience is captured when the draft is created.",
      "campaign-list",
      "← All campaigns",
    ) +
    `<div class="two-col campaign-editor"><section class="card"><h2>Make it worth opening</h2><form id="campaign-form" data-id="${esc(c.id || "")}">
    ${field("name", "Campaign name", c.name || "", "text", 'required maxlength="120" placeholder="September newsletter"')}
    ${field("subject", "Email subject", c.subject || "", "text", 'required maxlength="200" placeholder="A little news from our team"')}
    <div class="field"><label for="contentType">Message format</label><select id="contentType" name="contentType"><option value="html" ${format === "html" ? "selected" : ""}>HTML email</option><option value="text" ${format === "text" ? "selected" : ""}>Plain text</option></select></div>
    <div id="html-import" ${format === "html" ? "" : "hidden"}><label class="upload">Import an HTML file (optional)<input id="html-file" type="file" accept=".html,.htm,text/html"></label></div>
    <div class="field"><label for="body" id="body-label">${format === "html" ? "HTML source" : "Message"}</label><textarea id="body" name="body" class="${format === "html" ? "html-source" : ""}" rows="14" required maxlength="50000" spellcheck="${format === "html" ? "false" : "true"}" placeholder="${format === "html" ? "Paste your HTML email here…" : "Write your message here…"}">${esc(c.body || "")}</textarea>
    <small id="format-help">${format === "html" ? "Paste HTML with inline styles. Tables, links, and HTTPS images are supported. Scripts, forms, and style blocks are removed; a plain-text fallback is generated automatically." : "Plain-text email. HTML tags will appear as text."} Your company address and unsubscribe link are added automatically.</small></div>
    <div class="form-actions"><button>Save draft →</button><button type="button" class="secondary" data-action="preview-campaign">Preview message</button></div></form></section>
    <div><section class="card"><div class="card-header"><h2>Message preview</h2><span class="pill">Nothing is sent</span></div><div id="editor-preview">${previewMarkup(c.preview)}</div></section><section class="card"><h2>${c.id ? "Audience snapshot" : "Who will receive this?"}</h2><p>${c.id ? "This draft keeps the audience captured when it was created." : "All currently subscribed contacts in this company’s audience. Unsubscribed and suppressed contacts are excluded."}</p><div class="notice">Saving a draft does not send email. Review your message and audience before confirming.</div><a href="#contacts">Manage your audience →</a></section></div></div>`
  );
}
function campaignDetail(c) {
  const count = Object.fromEntries(c.counts.map((x) => [x.status, x.count])),
    total = c.counts.reduce((a, b) => a + b.count, 0);
  return (
    heading(
      esc(c.name),
      `Created ${date(c.created_at)} · ${fmt(total)} recipients`,
      "campaign-list",
      "← All campaigns",
    ) +
    `${c.error ? `<div class="notice warning">${esc(c.error)}</div>` : ""}<div class="stats">${[
      ["Status", c.status],
      ["Accepted", count.accepted || 0],
      ["Pending", count.pending || 0],
      ["Failed / uncertain", (count.failed || 0) + (count.uncertain || 0)],
    ]
      .map(
        ([k, v]) =>
          `<div class="stat"><div class="stat-label">${k}</div><div class="stat-value">${typeof v === "number" ? fmt(v) : badge(v)}</div></div>`,
      )
      .join(
        "",
      )}</div><div class="two-col"><section class="card"><div class="card-header"><h2>Email preview</h2>${c.status === "draft" ? '<button class="secondary" data-action="edit-campaign">Edit draft</button>' : ""}</div><div class="preview-subject">${esc(c.subject)} <span class="pill">${c.content_type === "html" ? "HTML" : "Plain text"}</span></div>${previewMarkup(c.preview)}</section><section class="card"><h2>${c.status === "queued" ? "Your campaign is queued" : "Ready for the next step?"}</h2><p>Maildesk sends one email at a time. Daily and monthly limits apply. A provider error pauses the campaign for review.</p>${["draft", "paused"].includes(c.status) ? '<button data-action="review-send">Review & send →</button>' : c.status === "queued" ? '<button class="secondary" data-action="pause-campaign">Pause campaign</button>' : ""}<div class="form-actions"><button class="ghost" data-action="refresh">↻ Refresh status</button></div><p><small>Pausing stops future sends. A message already being sent cannot be recalled. Uncertain sends are never automatically retried.</small></p></section></div><section class="card flush"><div class="card-header"><h2>Recipient activity</h2><span class="pill">First 100 recipients</span></div><div class="table-wrap"><table><thead><tr><th>Email</th><th>Status</th><th>Details</th></tr></thead><tbody>${c.recipients.map((r) => `<tr><td>${esc(r.email)}</td><td>${badge(r.status)}</td><td>${esc(r.error || "—")}</td></tr>`).join("")}</tbody></table></div></section>`
  );
}
function navigate(view) {
  if (location.hash === `#${view}`) render();
  else location.hash = view;
}
function dialog(html) {
  modal.innerHTML = html;
  modal.showModal();
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === "auth-switch") {
      state.auth = state.auth === "login" ? "register" : "login";
      return authView();
    }
    if (action === "logout") {
      await api("/auth/logout", { method: "POST", body: {} });
      state.me = null;
      modal.close();
      return authView();
    }
    if (action === "refresh") return render();
    if (action === "go-providers") return navigate("providers");
    if (action === "new-campaign") {
      state.selected = "new";
      return navigate("campaigns");
    }
    if (action === "campaign-list") {
      state.selected = null;
      return navigate("campaigns");
    }
    if (action === "open-campaign") {
      state.selected = button.dataset.id;
      return navigate("campaigns");
    }
    if (action === "edit-campaign") {
      document.querySelector("#content").innerHTML = composer(state.detail);
      return;
    }
    if (action === "provider-kind") {
      state.providerKind = button.dataset.kind;
      state.providerChosen = true;
      return render();
    }
    if (action === "close-modal") return modal.close();
    if (action === "contacts-next") {
      state.contactOffset += 500;
      return render();
    }
    if (action === "contacts-prev") {
      state.contactOffset = Math.max(0, state.contactOffset - 500);
      return render();
    }
    if (action === "add-contact")
      return dialog(
        `<h2>Add a contact</h2><p>Only add people who agreed to receive your emails.</p><form id="contact-form">${field("email", "Email address", "", "email", "required")}${field("name", "Name (optional)")}${field("consent", "Consent source", "", "text", 'required maxlength="300"')}<div class="form-actions"><button>Add contact</button><button type="button" class="secondary" data-action="close-modal">Cancel</button></div></form>`,
      );
    if (action === "suppress")
      return dialog(
        `<h2>Suppress this address?</h2><p>${esc(button.dataset.email)} will be excluded from future campaign sends for this company.</p><form id="suppress-form"><input type="hidden" name="email" value="${esc(button.dataset.email)}"><div class="field"><label for="reason">Reason</label><select name="reason" id="reason"><option value="unsubscribe">Unsubscribe request</option><option value="bounce">Bounce</option><option value="complaint">Spam complaint</option></select></div><div class="form-actions"><button>Confirm suppression</button><button type="button" class="secondary" data-action="close-modal">Cancel</button></div></form>`,
      );
    if (action === "review-send")
      return dialog(
        `<h2>Review your campaign</h2><p>You’re about to queue <strong>${esc(state.detail.name)}</strong> for <strong>${fmt(state.detail.counts.find((c) => c.status === "pending")?.count || 0)} pending recipients</strong>.</p><div class="preview-subject">${esc(state.detail.subject)}</div>${previewMarkup(state.detail.preview)}<form id="start-form"><div class="form-actions"><label class="checkbox"><input name="consent" type="checkbox" required> I confirm these recipients opted in to receive this campaign from our company.</label></div><div class="form-actions"><button>Confirm & queue campaign</button><button type="button" class="secondary" data-action="close-modal">Keep reviewing</button></div></form>`,
      );
    if (action === "revoke-key")
      return dialog(
        `<h2>Revoke this API key?</h2><p>Applications using this key will lose access immediately.</p><form id="revoke-form"><input type="hidden" name="id" value="${esc(button.dataset.id)}"><div class="form-actions"><button>Revoke key</button><button type="button" class="secondary" data-action="close-modal">Cancel</button></div></form>`,
      );
    button.disabled = true;
    if (action === "preview-campaign") {
      const form = document.querySelector("#campaign-form");
      const body = form.elements.body.value,
        contentType = form.elements.contentType.value;
      if (!body.trim()) throw new Error("Add your message before previewing.");
      const preview = await api("/campaigns/preview", {
        method: "POST",
        body: { body, contentType },
      });
      if (
        form.isConnected &&
        form.elements.body.value === body &&
        form.elements.contentType.value === contentType
      ) {
        document.querySelector("#editor-preview").innerHTML =
          previewMarkup(preview);
      }
    }
    if (action === "verify-provider") {
      const result = await api("/provider/verify", {
        method: "POST",
        body: {},
      });
      toast(result.summary, !result.ready);
      await render();
    }
    if (action === "pause-campaign") {
      await api(`/v1/campaigns/${state.selected}/pause`, {
        method: "POST",
        body: {},
      });
      toast("Campaign paused.");
      await render();
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.id) return;
  event.preventDefault();
  const button = form.querySelector("button[type=submit],button:not([type])");
  if (button) button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    switch (form.id) {
      case "auth-form":
        await api(`/auth/${state.auth === "register" ? "register" : "login"}`, {
          method: "POST",
          body: values,
        });
        state.me = await api("/me");
        return render();
      case "provider-form":
        values.dailyLimit = Number(values.dailyLimit);
        if (values.port) values.port = Number(values.port);
        await api("/provider", { method: "PUT", body: values });
        toast("Configuration saved. Check your connection next.");
        break;
      case "test-form":
        await api("/provider/test", { method: "POST", body: values });
        toast(
          "Test email accepted by your provider. Check the recipient’s inbox.",
        );
        break;
      case "settings-form":
        await api("/organization", { method: "PUT", body: values });
        state.me = await api("/me");
        toast("Company details saved.");
        break;
      case "contact-form":
        await api("/v1/contacts", {
          method: "POST",
          body: {
            contacts: [{ email: values.email, name: values.name }],
            consent: values.consent,
          },
        });
        modal.close();
        toast("Contact added.");
        break;
      case "import-form": {
        if (values.file.size > 3 * 1024 * 1024)
          throw new Error("CSV must be 3 MB or smaller.");
        const result = await api("/contacts/import", {
          method: "POST",
          body: { csv: await values.file.text(), consent: values.consent },
        });
        toast(
          `Imported ${fmt(result.added)} contacts. Skipped ${fmt(result.duplicates)} duplicates.`,
        );
        break;
      }
      case "suppress-form":
        await api("/contacts/suppress", { method: "POST", body: values });
        modal.close();
        toast("Address suppressed for this company.");
        break;
      case "campaign-form": {
        const id = form.dataset.id;
        const c = await api(`/v1/campaigns${id ? "/" + id : ""}`, {
          method: id ? "PUT" : "POST",
          body: values,
        });
        state.selected = c.id;
        toast("Draft saved. Nothing has been sent.");
        break;
      }
      case "start-form":
        await api(`/v1/campaigns/${state.selected}/start`, {
          method: "POST",
          body: { confirmConsent: values.consent === "on" },
        });
        modal.close();
        toast("Campaign queued.");
        break;
      case "key-form": {
        const result = await api("/keys", { method: "POST", body: values });
        await render();
        document.querySelector("#new-key").innerHTML =
          `<div class="notice success">Copy this key now. It won’t be shown again.</div><p class="key-output">${esc(result.token)}</p>`;
        return;
      }
      case "revoke-form":
        await api(`/keys/${values.id}`, { method: "DELETE", body: {} });
        modal.close();
        toast("API key revoked.");
        break;
      default:
        return;
    }
    await render();
  } catch (error) {
    if (form.id === "auth-form") {
      document.querySelector("#auth-error").textContent = error.message;
    } else toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
});

function updateFormat() {
  const html = document.querySelector("#contentType").value === "html";
  document.querySelector("#html-import").hidden = !html;
  document.querySelector("#body-label").textContent = html
    ? "HTML source"
    : "Message";
  const body = document.querySelector("#body");
  body.classList.toggle("html-source", html);
  body.spellcheck = !html;
  body.placeholder = html
    ? "Paste your HTML email here…"
    : "Write your message here…";
  document.querySelector("#format-help").textContent =
    (html
      ? "Use inline styles. Tables, links, and HTTPS images are supported. Scripts, forms, and style blocks are removed; a plain-text fallback is generated automatically."
      : "Plain-text email. HTML tags will appear as text.") +
    " Your company address and unsubscribe link are added automatically.";
  document.querySelector("#editor-preview").innerHTML =
    '<p class="muted">Message changed. Click Preview message to update.</p>';
}
document.addEventListener("change", async (event) => {
  if (event.target.id === "contentType") updateFormat();
  if (event.target.id === "html-file") {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 200000)
        throw new Error("HTML file is too large. Maximum 50,000 characters.");
      const source = await file.text();
      if (source.length > 50000)
        throw new Error("HTML file is too large. Maximum 50,000 characters.");
      if (!source.trim()) throw new Error("This HTML file is empty.");
      const body = document.querySelector("#body");
      if (!event.target.isConnected || !body) return;
      body.value = source;
      document.querySelector("#contentType").value = "html";
      updateFormat();
      toast("HTML imported. Preview it before saving.");
    } catch (error) {
      toast(error.message, true);
    } finally {
      event.target.value = "";
    }
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "body" && document.querySelector("#editor-preview")) {
    document.querySelector("#editor-preview").innerHTML =
      '<p class="muted">Message changed. Click Preview message to update.</p>';
  }
});

window.addEventListener("hashchange", () => {
  if (location.hash !== "#campaigns") state.selected = null;
  render();
});
async function boot() {
  try {
    const setup = await api("/setup");
    state.signupEnabled = setup.signupEnabled;
    state.me = await api("/me");
  } catch {}
  await render();
}
boot();
