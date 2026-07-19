import { expect, test } from "@playwright/test";

const fakeLanguageModel = (config = {}) => {
  const audit = { creates: [], prompts: [], destroyed: 0, throwCreate: false };
  window.__languageModelAudit = audit;
  class FakeSession {
    async *promptStreaming(prompt, { signal } = {}) {
      audit.prompts.push(prompt);
      if (config.generationErrorFor && prompt.includes(config.generationErrorFor)) throw new Error("Fake generation failure");
      for (const part of [`fake: ${prompt.slice(0, 5)}`, " response"]) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await new Promise(resolve => setTimeout(resolve, prompt.includes("slow") ? 250 : 10));
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        yield part;
      }
    }
    async prompt(prompt, { signal } = {}) {
      audit.prompts.push(prompt);
      if (config.generationErrorFor && prompt.includes(config.generationErrorFor)) throw new Error("Fake generation failure");
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return `single: ${prompt}`;
    }
    async destroy() { audit.destroyed += 1; }
  }
  const languageModel = {
    availability: async () => config.availability ?? "available",
    create: async options => {
      audit.creates.push(JSON.parse(JSON.stringify(options)));
      if (options.monitor && config.progress) options.monitor({ addEventListener: (_name, handler) => handler({ ...config.progress }) });
      if (config.createDelayMs) await new Promise(resolve => setTimeout(resolve, config.createDelayMs));
      if (config.createError || audit.throwCreate) throw new Error("Fake create failure");
      return new FakeSession();
    },
  };
  if (!config.paramsUnavailable) languageModel.params = async () => ({ defaultTemperature: 0.7, maxTemperature: 1, defaultTopK: 8, maxTopK: 32 });
  window.LanguageModel = languageModel;
};

async function openWithFake(page, config = {}) {
  await page.addInitScript(fakeLanguageModel, config);
  await page.goto("/");
}

async function send(page, prompt) {
  await page.locator("#user-prompt").fill(prompt);
  await page.locator("#send-prompt").click();
  await expect(page.locator("#run-status")).toHaveText("待機中");
}

test("fake LanguageModel supports streaming, records, and reload restoration", async ({ page }) => {
  await openWithFake(page);
  await expect(page.locator("#api-status")).toHaveText("利用可能");
  await expect(page.locator("#temperature")).toBeEnabled();
  await send(page, "hello from test");
  await expect(page.locator(".turn.assistant")).toContainText("fake: hello response");
  await expect(page.locator("#record-count")).toHaveText("記録: 1 件");
  await page.reload();
  await expect(page.locator(".turn.assistant")).toContainText("fake: hello response");
  await expect(page.locator("#session-status")).toHaveText("未作成");
});

test("reset boundary excludes earlier turns and survives reload", async ({ page }) => {
  await openWithFake(page);
  await send(page, "before reset");
  await page.locator("#reset-session").click();
  await send(page, "after reset");
  const secondCreate = await page.evaluate(() => window.__languageModelAudit.creates[1].initialPrompts);
  expect(secondCreate.map(item => item.content)).not.toContain("before reset");
  await page.reload();
  await send(page, "after reload");
  const reloadCreate = await page.evaluate(() => window.__languageModelAudit.creates[0].initialPrompts);
  expect(reloadCreate.map(item => item.content)).toContain("after reset");
  expect(reloadCreate.map(item => item.content)).not.toContain("before reset");
});

test("non-streaming, reset, and clear preserve records", async ({ page }) => {
  await openWithFake(page);
  await page.locator("#streaming").uncheck();
  await send(page, "one response");
  await expect(page.locator(".turn.assistant")).toContainText("single: one response");
  await page.locator("#reset-session").click();
  await expect(page.locator("#session-status")).toHaveText("リセット済み");
  await expect(page.locator("#record-count")).toHaveText("記録: 1 件");
  await page.locator("#clear-history").click();
  await expect(page.locator(".turn")).toHaveCount(0);
  await expect(page.locator("#record-count")).toHaveText("記録: 1 件");
});

test("cancel destroys the session and excludes the cancelled turn from the next context", async ({ page }) => {
  await openWithFake(page);
  await page.locator("#user-prompt").fill("slow request");
  await page.locator("#send-prompt").click();
  await expect(page.locator("#cancel-prompt")).toBeEnabled();
  await page.locator("#cancel-prompt").click();
  await expect(page.locator(".turn.assistant.cancelled")).toBeVisible();
  await send(page, "next request");
  const audit = await page.evaluate(() => window.__languageModelAudit);
  expect(audit.destroyed).toBeGreaterThanOrEqual(1);
  expect(audit.creates).toHaveLength(2);
  expect(audit.creates[1].initialPrompts.map(item => item.content)).not.toContain("slow request");
});

test("generation error destroys the session and does not reintroduce a failed turn", async ({ page }) => {
  await openWithFake(page, { generationErrorFor: "error request" });
  await send(page, "error request");
  await expect(page.locator(".turn.assistant.failed")).toBeVisible();
  await send(page, "next request");
  const audit = await page.evaluate(() => window.__languageModelAudit);
  expect(audit.destroyed).toBeGreaterThanOrEqual(1);
  expect(audit.creates[1].initialPrompts.map(item => item.content)).not.toContain("error request");
});

test("pre-session creation failure records the run without rewriting the earlier assistant turn", async ({ page }) => {
  await openWithFake(page);
  await send(page, "first response");
  await page.locator("#reset-session").click();
  await page.evaluate(() => { window.__languageModelAudit.throwCreate = true; });
  await send(page, "will fail before session");
  await expect(page.locator(".turn.assistant")).toHaveCount(2);
  await expect(page.locator(".turn.assistant.completed")).toHaveCount(1);
  await expect(page.locator(".turn.assistant.failed")).toHaveCount(1);
  await expect(page.locator("#record-count")).toHaveText("記録: 2 件");
});

test("case selection retains its ID but sends the edited textarea content", async ({ page }) => {
  await openWithFake(page);
  await page.locator("#case-select").selectOption("en-ja-short");
  await page.locator("#user-prompt").fill("edited case prompt");
  await send(page, "edited case prompt");
  const audit = await page.evaluate(() => window.__languageModelAudit);
  expect(audit.prompts.at(-1)).toBe("edited case prompt");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download-json").click()]);
  const exported = JSON.parse(await readDownload(download));
  expect(exported.records[0].caseId).toBe("en-ja-short");
  expect(exported.records[0].input.resolvedPrompt).toBe("edited case prompt");
  expect(exported.records[0].environment).toHaveProperty("online");
});

test("JSON and Markdown downloads contain the fixed prefix and complete record detail", async ({ page }) => {
  await openWithFake(page);
  await page.locator("#system-prompt").fill("system with `backtick`");
  await page.locator("#system-prompt").press("Tab");
  await send(page, "input with ``` fence");
  const [jsonDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#download-json").click()]);
  expect(jsonDownload.suggestedFilename()).toMatch(/^aion-prompt-evaluation-[0-9TZ-]+\.json$/);
  const exported = JSON.parse(await readDownload(jsonDownload));
  expect(exported.records[0]).toMatchObject({ schemaVersion: "1.0", status: "success" });
  expect(exported.records[0].timings).toHaveProperty("timeToFirstTextMs");
  const [markdownDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#download-markdown").click()]);
  expect(markdownDownload.suggestedFilename()).toMatch(/^aion-prompt-evaluation-[0-9TZ-]+\.md$/);
  const markdown = await readDownload(markdownDownload);
  expect(markdown).toContain("### System prompt");
  expect(markdown).toContain("Temperature:");
  expect(markdown).toContain("入力 (20 文字)");
  expect(markdown).toContain("````");
});

test("progress uses loaded/total fractions and keeps unknown totals indeterminate", async ({ page }) => {
  await openWithFake(page, { createDelayMs: 300, progress: { loaded: 2, total: 4 } });
  await page.locator("#prepare-session").click();
  await expect(page.locator("#download-progress")).toBeVisible();
  await expect(page.locator("#download-progress")).toHaveJSProperty("value", 0.5);
  await expect(page.locator("#prepare-session")).toBeDisabled();
  await page.waitForTimeout(350);
  await page.reload();
  await page.evaluate(() => {
    window.LanguageModel.create = async options => {
      options.monitor({ addEventListener: (_name, handler) => handler({ loaded: 5 }) });
      await new Promise(resolve => setTimeout(resolve, 300));
      return { destroy: async () => {} };
    };
  });
  await page.locator("#prepare-session").click();
  await expect(page.locator("#download-progress")).toBeVisible();
  await expect(page.locator("#download-progress")).not.toHaveAttribute("value");
  await expect(page.locator("#status-message")).toContainText("総量を取得できない");
});

test("running generation locks mutation controls and double prepare creates only one session", async ({ page }) => {
  await openWithFake(page, { createDelayMs: 100 });
  await Promise.all([page.locator("#prepare-session").click(), page.locator("#prepare-session").click()]);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__languageModelAudit.creates)).toHaveLength(1);
  await page.locator("#reset-session").click();
  await page.locator("#user-prompt").fill("slow request");
  await page.locator("#send-prompt").click();
  await expect(page.locator("#system-prompt")).toBeDisabled();
  await expect(page.locator("#temperature")).toBeDisabled();
  await expect(page.locator("#streaming")).toBeDisabled();
  await expect(page.locator("#case-select")).toBeDisabled();
  await expect(page.locator("#prepare-session")).toBeDisabled();
  await page.locator("#cancel-prompt").click();
  await expect(page.locator("#run-status")).toHaveText("待機中");
});

test("API absent, params unavailable, and unknown availability are explicit and cannot create", async ({ browser }) => {
  const absent = await browser.newPage();
  await absent.addInitScript(() => { delete window.LanguageModel; });
  await absent.goto("http://127.0.0.1:5188/");
  await expect(absent.locator("#api-status")).toHaveText("未対応");
  await absent.locator("#prepare-session").click();
  await expect(absent.locator("#error-message")).toContainText("LanguageModel API");
  await absent.close();

  const paramsUnavailable = await browser.newPage();
  await openWithFake(paramsUnavailable, { paramsUnavailable: true });
  await expect(paramsUnavailable.locator("#temperature")).toBeDisabled();
  await expect(paramsUnavailable.locator("#parameter-support")).toContainText("未対応");
  await paramsUnavailable.close();

  const unknown = await browser.newPage();
  await openWithFake(unknown, { availability: "mystery" });
  await expect(unknown.locator("#error-message")).toContainText("Unsupported LanguageModel availability state: mystery");
  await unknown.locator("#prepare-session").click();
  await expect(unknown.locator("#error-message")).toContainText("Unsupported LanguageModel availability state: mystery");
  expect(await unknown.evaluate(() => window.__languageModelAudit.creates)).toHaveLength(0);
  await unknown.close();
});

test("all documented availability states are displayed", async ({ browser }) => {
  for (const availability of ["unavailable", "downloadable", "downloading", "available"]) {
    const page = await browser.newPage();
    await openWithFake(page, { availability });
    await expect(page.locator("#availability-status")).toHaveText(availability);
    await page.close();
  }
});

test("sessionStorage failure is visible", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = function () { throw new DOMException("Quota exceeded", "QuotaExceededError"); };
  });
  await page.addInitScript(fakeLanguageModel, {});
  await page.goto("/");
  await expect(page.locator("#error-message")).toContainText("Quota exceeded");
  await expect(page.locator("#status-message")).toContainText("状態を保存できなかった");
});

async function readDownload(download) {
  const stream = await download.createReadStream();
  let serialized = "";
  for await (const chunk of stream) serialized += chunk;
  return serialized;
}
