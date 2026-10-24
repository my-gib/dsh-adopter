import { chromium } from "../src/browser/playwright.mjs";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9227", { timeout: 20000 });
const pages = browser.contexts().flatMap(c => c.pages());
let page = null;
for (const c of pages) { const n = await c.evaluate(() => window.name).catch(() => ""); if (n === "deepseek-douyin-api-chat") page = c; }
const out = await page.evaluate(() => {
  const rect = e => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
  const wraps = [...document.querySelectorAll(".semi-modal-wrap")];
  const container = document.querySelector("#pc-im-popup-container");
  return {
    modalWrapCount: wraps.length,
    modalWraps: wraps.map(w => ({
      cls: w.getAttribute("class"),
      rect: rect(w),
      visible: vis(w),
      display: getComputedStyle(w).display,
      opacity: getComputedStyle(w).opacity,
      zIndex: getComputedStyle(w).zIndex,
      childCls: [...w.children].map(c => (c.getAttribute("class") || "").slice(0, 80)),
      text: (w.textContent || "").trim().slice(0, 160),
      htmlHead: w.outerHTML.slice(0, 700),
    })),
    popupContainer: container ? { childCls: [...container.children].map(c => ({ cls: (c.getAttribute("class") || "").slice(0, 70), rect: rect(c), visible: vis(c), text: (c.textContent || "").trim().slice(0, 60) })) } : null,
    // 谁在输入框那个点 (1129,751) 的最上层？
    topmostAtInput: (() => { const e = document.elementFromPoint(1129, 751); return e ? { tag: e.tagName.toLowerCase(), cls: (e.getAttribute("class") || "").slice(0, 90), e2e: e.getAttribute("data-e2e"), closestWrap: Boolean(e.closest(".semi-modal-wrap")) } : null; })(),
    topmostAtUpload: (() => { const e = document.elementFromPoint(1097, 751); return e ? { tag: e.tagName.toLowerCase(), cls: (e.getAttribute("class") || "").slice(0, 90), closestWrap: Boolean(e.closest(".semi-modal-wrap")) } : null; })(),
  };
});
console.log(JSON.stringify(out, null, 2));
await page.screenshot({ path: "archive/diag-modal.png" }).catch(() => {});
await browser.close();
