/* oxlint-disable no-await-in-loop -- gestures are sequences of events */
// End-to-end tests for the pare app, driven through the harness host with
// the production single-file build loaded via srcdoc. The harness shows what
// the model would see: the latest context update, and any chat messages.

import { test, expect, type FrameLocator, type Page } from "@playwright/test";

async function open(page: Page, fixture = "newsletters", extra = ""): Promise<FrameLocator> {
  await page.goto(`/harness.html?fixture=${fixture}&src=dist${extra}`);
  // Start from nothing: no browser cache, no seed.
  await page.getByTestId("restart").click();
  const app = page.frameLocator("[data-testid=app]");
  await expect(app.getByTestId("top-card")).toBeVisible();
  return app;
}

const top = (app: FrameLocator) => app.getByTestId("top-card");
const decided = (page: Page) => page.getByTestId("context-decided");
const inContext = (page: Page, id: string) =>
  page.getByTestId("context-list").locator(`[data-item-id="${id}"]`);

test("keyboard: decide, note, suggestion, undo, skip, and the model's context follows", async ({
  page,
}) => {
  const app = await open(page);
  await expect(app.getByTestId("note")).toBeFocused();

  await page.keyboard.press("ArrowRight");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-2");
  await expect(inContext(page, "nl-1")).toHaveAttribute("data-action", "keep");

  // Typing is commenting. With text in the note, bare arrows move the caret;
  // the modifier decides.
  await page.keyboard.type("only the Sunday edition");
  await expect(app.getByTestId("note")).toHaveValue("only the Sunday edition");
  await page.keyboard.press("ArrowLeft");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-2");
  await page.keyboard.press("Control+ArrowLeft");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-3");
  await expect(inContext(page, "nl-2")).toHaveAttribute("data-action", "dispose");
  await expect(inContext(page, "nl-2")).toContainText("only the Sunday edition");
  await expect(app.getByTestId("note")).toHaveValue("");
  await expect(app.getByTestId("note")).toBeFocused();

  // Enter always keeps, whatever the card suggests. nl-3 suggests dispose, so
  // the sparkle sits on the dispose action.
  await expect(app.getByTestId("action-dispose").getByTestId("suggested")).toBeVisible();
  await expect(app.getByTestId("action-keep").getByTestId("suggested")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-4");
  await expect(inContext(page, "nl-3")).toHaveAttribute("data-action", "keep");

  await page.keyboard.press("Control+z");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-3");
  await expect(inContext(page, "nl-3")).toHaveCount(0);
  await expect(decided(page)).toContainText("2 of 12");

  // Later moves the card to the bottom of the deck.
  await page.keyboard.press("ArrowDown");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-4");
  await expect(app.getByTestId("progress")).toContainText("2");

  // The text side of the context update tells the model how to reopen.
  const lastContext = page.getByTestId("log-context").last();
  await expect(lastContext).toContainText("2 of 12 decided");
  await expect(lastContext).toContainText("nl-2: dispose (note: only the Sunday edition)");
  await expect(lastContext).toContainText('session_id "harness-newsletters"');
});

test("mouse drag and trackpad wheel commit past the threshold and settle back before it", async ({
  page,
}) => {
  const app = await open(page);
  const box = await top(app).boundingBox();
  if (!box) throw new Error("no card");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // A short drag settles back.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 4, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-1");

  // A long drag to the right keeps.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 260, cy + 12, { steps: 12 });
  await page.mouse.up();
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-2");
  await expect(inContext(page, "nl-1")).toHaveAttribute("data-action", "keep");

  // Two-finger swipe left on a trackpad arrives as positive deltaX. A
  // trackpad never reports the fingers lifting, so a swipe has to travel far
  // enough to be deliberate: a partial push and a pull back decide nothing.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(30, 0);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(-30, 0);
  await page.waitForTimeout(400);
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-2");
  // Pushing the whole way commits as the line is crossed.
  for (let i = 0; i < 12; i++) await page.mouse.wheel(30, 0);
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-3");
  await expect(inContext(page, "nl-2")).toHaveAttribute("data-action", "dispose");

  // Vertical wheel does not decide.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 30);
  await page.waitForTimeout(300);
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-3");

  // The leaving card stays above the deck and never reaches the iframe edge.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 260, cy, { steps: 12 });
  await page.mouse.up();
  const ghost = app.locator(".pare-card--ghost").first();
  await expect(ghost).toBeVisible();
  const z = await ghost.evaluate((el) => getComputedStyle(el).zIndex);
  expect(Number(z)).toBeGreaterThan(10);
  await expect(ghost).toHaveCount(0, { timeout: 3000 });
});

test("extra actions by key, by button, and through a suggestion", async ({ page }) => {
  const app = await open(page, "tasks");
  await page.keyboard.press("1");
  await expect(top(app)).toHaveAttribute("data-item-id", "t-2");
  await expect(inContext(page, "t-1")).toHaveAttribute("data-action", "later");

  await app.getByTestId("action-delegate").click();
  await expect(top(app)).toHaveAttribute("data-item-id", "t-3");
  await expect(inContext(page, "t-2")).toHaveAttribute("data-action", "delegate");

  // t-3 suggests "later": the sparkle marks that action, and Enter still keeps.
  await expect(app.getByTestId("action-later").getByTestId("suggested")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(top(app)).toHaveAttribute("data-item-id", "t-4");
  await expect(inContext(page, "t-3")).toHaveAttribute("data-action", "keep");

  // Letters are text, never shortcuts; with text present a digit is text too,
  // and the modifier plus an arrow decides with the note attached.
  await page.keyboard.type("delegate to sam 1");
  await expect(top(app)).toHaveAttribute("data-item-id", "t-4");
  await expect(app.getByTestId("note")).toHaveValue("delegate to sam 1");
  await page.keyboard.press("Control+ArrowRight");
  await expect(inContext(page, "t-4")).toContainText("delegate to sam 1");
});

test("progress survives a remount from the cache, and a reopen from the model's context", async ({
  page,
}) => {
  const app = await open(page, "terse");
  await expect(app.getByTestId("note")).toHaveCount(0);
  await expect(app.getByTestId("pare")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(decided(page)).toContainText("2 of 3");

  // A host re-renders the app with the same tool input; the cache restores it.
  await page.getByTestId("remount").click();
  const again = page.frameLocator("[data-testid=app]");
  await expect(top(again)).toHaveAttribute("data-item-id", "q-3");
  await expect(again.getByTestId("progress")).toContainText("2");

  // A new conversation: the model calls pare-start with the decisions it saw.
  // The harness clears the cache first, so the seed alone restores progress.
  await page.getByTestId("reopen").click();
  const reopened = page.frameLocator("[data-testid=app]");
  await expect(top(reopened)).toHaveAttribute("data-item-id", "q-3");
  await expect(reopened.getByTestId("progress")).toContainText("2");
});

test("the summary sends results to the chat, and revisit reopens an item", async ({ page }) => {
  const app = await open(page, "terse");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(app.getByTestId("summary")).toBeVisible();
  await expect(app.getByTestId("summary")).toContainText("All 3 sorted");

  await app.getByTestId("send").click();
  await expect(page.getByTestId("log-message").last()).toContainText("Finished triaging");
  await expect(page.getByTestId("log-message").last()).toContainText("- First (id: q-1)");
  await expect(app.getByTestId("sent")).toBeVisible();
  await expect(decided(page)).toContainText("done");

  await app.getByRole("button", { name: "Revisit" }).first().click();
  await expect(top(app)).toBeVisible();
  await expect(decided(page)).toContainText("2 of 3");
  await expect(decided(page)).toContainText("open");
});

test("full screen is requested through the host", async ({ page }) => {
  const app = await open(page);
  await app.getByRole("button", { name: "Full screen" }).click();
  await expect(page.getByTestId("log-display").last()).toHaveText("fullscreen");
  await expect(app.getByTestId("pare")).toHaveClass(/pare--fullscreen/);
  await app.getByRole("button", { name: "Exit full screen" }).click();
  await expect(app.getByTestId("pare")).not.toHaveClass(/pare--fullscreen/);
});
