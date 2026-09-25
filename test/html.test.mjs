import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { database } from "../server/db.mjs";
import { renderCampaignBody, sanitizeEmailHtml } from "../server/content.mjs";
import { sesBody, smtpMessage } from "../server/providers.mjs";
import nodemailer from "nodemailer";

const body =
  '<table cellpadding="20" style="background-color:#f2f0ff;width:100%"><tr><td><h1 style="color:#6654da">Hello &amp; welcome</h1><p>Meet our <strong>new collection</strong>.</p><a href="https://example.com/shop">Shop now</a><img src="https://example.com/banner.jpg" alt="Spring collection" width="500"></td></tr></table>';
const input = {
  body,
  contentType: "html",
  company: { name: "A & B <Studio>", address: "123 Main St\nManila" },
  unsubscribe: "https://mail.example.com/unsubscribe/test",
};

test("HTML rendering preserves email layout, creates text fallback and escapes company footer", () => {
  const result = renderCampaignBody(input);
  assert.match(result.html, /<table/);
  assert.match(result.html, /color:#6654da/);
  assert.match(result.html, /A &amp; B &lt;Studio&gt;/);
  assert.match(result.html, /123 Main St<br>Manila/);
  assert.match(
    result.html,
    /href="https:\/\/mail.example.com\/unsubscribe\/test"/,
  );
  assert.match(result.text, /Hello & welcome/i);
  assert.match(result.text, /https:\/\/example.com\/shop/);
  assert.match(
    result.text,
    /Unsubscribe: https:\/\/mail.example.com\/unsubscribe\/test/,
  );
  assert.doesNotMatch(result.text, /<table|<strong|&amp;/);
  const plain = renderCampaignBody({
    ...input,
    contentType: "text",
    body: "Literal <b>text</b>",
  });
  assert.equal(plain.html, undefined);
  assert.match(plain.text, /Literal <b>text<\/b>/);
});

test("HTML sanitization removes active markup, unsafe URLs and CSS network requests", () => {
  const cleaned = sanitizeEmailHtml(
    '<script>alert(1)</script><style>body{color:red}</style><iframe src="https://evil.test">secret</iframe><form><input name="password"></form><p onclick="alert(2)" style="color:red;background-image:url(https://evil.test);font-family:url(https://evil.test)">Safe</p><a href="javascript:alert(3)">bad</a><img src="data:text/html,bad" onerror="alert(4)"><img src="//evil.test/tracker">',
  );
  assert.match(cleaned, /color:red/);
  assert.match(cleaned, /Safe/);
  assert.doesNotMatch(
    cleaned,
    /script|iframe|onclick|onerror|javascript:|data:|evil.test|<form|<input|<style|alert\(/,
  );
});

test("SES and SMTP both produce HTML plus a text alternative", async () => {
  const message = {
    ...renderCampaignBody(input),
    subject: "HTML campaign",
    to: "reader@example.com",
    unsubscribe: input.unsubscribe,
  };
  const payload = sesBody(message);
  assert.equal(payload.Html.Data, message.html);
  assert.equal(payload.Text.Data, message.text);
  assert.equal(sesBody({ text: "plain" }).Html, undefined);
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });
  const result = await transport.sendMail(
    smtpMessage({ from: "sender@example.com", fromName: "Sender" }, message),
  );
  const mime = result.message.toString();
  assert.match(mime, /multipart\/alternative/);
  assert.match(mime, /Content-Type: text\/plain/);
  assert.match(mime, /Content-Type: text\/html/);
  assert.match(mime, /List-Unsubscribe:/);
  assert.match(mime, /List-Unsubscribe-Post:/);
});

test("additive migration preserves legacy drafts and is safe on repeated startup", () => {
  const directory = mkdtempSync(join(tmpdir(), "maildesk-html-migration-"));
  const path = join(directory, "legacy.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE campaigns(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    old
      .prepare("INSERT INTO campaigns VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        "legacy",
        "company",
        "News",
        "Hello",
        "Literal <b>text</b>",
        "draft",
        null,
        "2026-09-22",
        "2026-09-22",
      );
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = database(path),
        item = db.prepare("SELECT * FROM campaigns WHERE id=?").get("legacy");
      assert.equal(item.content_type, "text");
      assert.equal(item.body, "Literal <b>text</b>");
      assert.equal(item.status, "draft");
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
