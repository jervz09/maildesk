import sanitizeHtml from "sanitize-html";
import { convert } from "html-to-text";

export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

// Email layout and typography only. No CSS URLs, scripts, event handlers, forms,
// embedded documents, or active elements. Keep the original source for editing.
const styleValue =
  /^(?!.*(?:url|expression|image-set|element|var|attr|paint)\s*\()[a-zA-Z0-9\s#.,%()'"/:+\-]+$/i;
const styleProperties = [
  "color",
  "background-color",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-transform",
  "vertical-align",
  "width",
  "max-width",
  "min-width",
  "height",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "padding",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "border",
  "border-top",
  "border-bottom",
  "border-left",
  "border-right",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "display",
  "white-space",
  "word-break",
  "overflow-wrap",
  "table-layout",
];

export function sanitizeEmailHtml(source) {
  return sanitizeHtml(source, {
    allowedTags: [
      "a",
      "abbr",
      "b",
      "blockquote",
      "br",
      "caption",
      "center",
      "code",
      "col",
      "colgroup",
      "dd",
      "del",
      "div",
      "dl",
      "dt",
      "em",
      "font",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "img",
      "li",
      "ol",
      "p",
      "pre",
      "s",
      "small",
      "span",
      "strong",
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tfoot",
      "tr",
      "u",
      "ul",
    ],
    allowedAttributes: {
      "*": [
        "style",
        "align",
        "valign",
        "width",
        "height",
        "title",
        "dir",
        "lang",
      ],
      a: ["href"],
      img: ["src", "alt"],
      table: ["cellpadding", "cellspacing", "border", "bgcolor", "role"],
      td: ["colspan", "rowspan", "bgcolor"],
      th: ["colspan", "rowspan", "scope", "bgcolor"],
      font: ["color", "face", "size"],
      col: ["span"],
      colgroup: ["span"],
      ol: ["start", "type"],
      li: ["value"],
    },
    allowedStyles: {
      "*": Object.fromEntries(
        styleProperties.map((property) => [property, [styleValue]]),
      ),
    },
    allowedSchemes: ["https", "http", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "iframe",
      "object",
      "svg",
      "math",
      "template",
    ],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
    },
  }).trim();
}

export function renderCampaignBody({
  body,
  contentType = "text",
  company,
  unsubscribe,
}) {
  const html = contentType === "html" ? sanitizeEmailHtml(body) : null;
  const plain =
    html === null
      ? body
      : convert(html, {
          wordwrap: false,
          selectors: [
            { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
          ],
        }).trim();
  const footer = `${company.name}\n${company.address || "Add your company postal address in Settings"}\nUnsubscribe: ${unsubscribe}`;
  const text = `${plain || "This message contains HTML content. Please view it in an HTML-capable email client."}\n\n—\n${footer}`;
  if (html === null) return { text };
  const address = escapeHtml(
    company.address || "Add your company postal address in Settings",
  ).replace(/\n/g, "<br>");
  // Separate tables prevent the template's layout/styles from hiding the footer.
  const footerHtml = `<div style="margin-top:28px;padding:20px 0;border-top:1px solid #dddddd;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#666666"><strong>${escapeHtml(company.name)}</strong><br>${address}<br><a href="${escapeHtml(unsubscribe)}" style="color:#6654da">Unsubscribe</a></div>`;
  return {
    text,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}${footerHtml}</body></html>`,
  };
}
