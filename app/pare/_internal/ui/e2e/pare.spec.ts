/* oxlint-disable no-await-in-loop -- gestures are sequences of events */
// End-to-end tests for the pare app, driven through the harness host with
// the production single-file build loaded via srcdoc.

import { test, expect, type FrameLocator, type Page } from "@playwright/test";

async function open(page: Page, fixture = "newsletters", extra = ""): Promise<FrameLocator> {
  await page.goto(`/harness.html?fixture=${fixture}&src=dist${extra}`);
  // Start from an empty store every time; the harness persists sessions in
  // sessionStorage so the remount test can prove decisions survive.
  await page.getByTestId("restart").click();
  const app = page.frameLocator("[data-testid=app]");
  await expect(app.getByTestId("top-card")).toBeVisible();
  await expect(page.getByTestId("store-decided")).toContainText("0 of");
  return app;
}

const top = (app: FrameLocator) => app.getByTestId("top-card");
const decided = (page: Page) => page.getByTestId("store-decided");
const stored = (page: Page, id: string) =>
  page.getByTestId("store-list").locator(`[data-item-id="${id}"]`);

test("keyboard: decide, note, suggestion, undo, skip, and every change is saved", async ({
  page,
}) => {
  const app = await open(page);
  await expect(app.getByTestId("note")).toBeFocused();

  await page.keyboard.press("ArrowRight");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-2");
  await expect(stored(page, "nl-1")).toHaveAttribute("data-action", "keep");

  // With text in the note, bare arrows move the caret; the modifier decides.
  await page.keyboard.type("only the Sunday edition");
  await page.keyboard.press("ArrowLeft");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-2");
  await page.keyboard.press("Control+ArrowLeft");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-3");
  await expect(stored(page, "nl-2")).toHaveAttribute("data-action", "dispose");
  await expect(stored(page, "nl-2")).toContainText("only the Sunday edition");
  await expect(app.getByTestId("note")).toHaveValue("");

  // Enter takes the card's suggestion (nl-3 suggests dispose).
  await page.keyboard.press("Enter");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-4");
  await expect(stored(page, "nl-3")).toHaveAttribute("data-action", "dispose");

  await page.keyboard.press("Control+z");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-3");
  await expect(stored(page, "nl-3")).toHaveCount(0);
  await expect(decided(page)).toContainText("2 of 12");

  // Later moves the card to the bottom of the deck, and the order is saved.
  await page.keyboard.press("ArrowDown");
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-4");
  await expect(page.getByTestId("store-queue")).toHaveText(/nl-3$/);
  await expect(app.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  await expect(page.getByTestId("log-context").last()).toContainText("2 of 12 decided");
  await expect(app.getByTestId("progress")).toContainText("2");
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
  await expect(stored(page, "nl-1")).toHaveAttribute("data-action", "keep");

  // Two-finger swipe left on a trackpad arrives as positive deltaX.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(30, 0);
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-3");
  await expect(stored(page, "nl-2")).toHaveAttribute("data-action", "dispose");

  // Vertical wheel does not decide.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 30);
  await page.waitForTimeout(300);
  await expect(top(app)).toHaveAttribute("data-item-id", "nl-3");
});

test("extra actions by key, by button, and through a suggestion", async ({ page }) => {
  const app = await open(page, "tasks");
  await page.keyboard.press("s");
  await expect(top(app)).toHaveAttribute("data-item-id", "t-2");
  await expect(stored(page, "t-1")).toHaveAttribute("data-action", "later");

  await app.getByTestId("action-delegate").click();
  await expect(top(app)).toHaveAttribute("data-item-id", "t-3");
  await expect(stored(page, "t-2")).toHaveAttribute("data-action", "delegate");

  // t-3 suggests "later"; Enter follows the suggestion.
  await expect(app.getByTestId("note")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(top(app)).toHaveAttribute("data-item-id", "t-4");
  await expect(stored(page, "t-3")).toHaveAttribute("data-action", "later");

  // Letters typed into a note are text, not shortcuts.
  await page.keyboard.type("ask sam");
  await expect(top(app)).toHaveAttribute("data-item-id", "t-4");
  await expect(app.getByTestId("note")).toHaveValue("ask sam");
});

test("progress survives a remount, the summary sends results, and revisit reopens", async ({
  page,
}) => {
  const app = await open(page, "terse");
  await expect(app.getByTestId("note")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(decided(page)).toContainText("2 of 3");

  // A host re-renders the app with the same tool result; saved decisions come back.
  await page.getByTestId("remount").click();
  const again = page.frameLocator("[data-testid=app]");
  await expect(top(again)).toHaveAttribute("data-item-id", "q-3");
  await expect(again.getByTestId("progress")).toContainText("2");

  await page.keyboard.press("ArrowRight");
  await expect(again.getByTestId("summary")).toBeVisible();
  await expect(again.getByTestId("summary")).toContainText("All 3 sorted");

  await again.getByTestId("send").click();
  await expect(page.getByTestId("log-message").last()).toContainText("Finished triaging");
  await expect(page.getByTestId("log-message").last()).toContainText("- First (id: q-1)");
  await expect(again.getByTestId("sent")).toBeVisible();
  await expect(decided(page)).toContainText("done");

  await again.getByRole("button", { name: "Revisit" }).first().click();
  await expect(top(again)).toBeVisible();
  await expect(decided(page)).toContainText("2 of 3");
  await expect(decided(page)).toContainText("open");
});

test("a failed save is retried until the host accepts it", async ({ page }) => {
  const app = await open(page, "terse", "&fail=1");
  await page.keyboard.press("ArrowRight");
  await expect(top(app)).toHaveAttribute("data-item-id", "q-2");
  await expect(app.getByTestId("save-state")).toHaveAttribute("data-state", "error");
  await expect(decided(page)).toContainText("0 of 3");

  await page.getByTestId("fail-saves").uncheck();
  await expect(app.getByTestId("save-state")).toHaveAttribute("data-state", "saved", {
    timeout: 8000,
  });
  await expect(stored(page, "q-1")).toHaveAttribute("data-action", "keep");
});

test("full screen is requested through the host", async ({ page }) => {
  const app = await open(page);
  await app.getByRole("button", { name: "Full screen" }).click();
  await expect(page.getByTestId("log-display").last()).toHaveText("fullscreen");
  await expect(app.getByTestId("pare")).toHaveClass(/pare--fullscreen/);
  await app.getByRole("button", { name: "Exit full screen" }).click();
  await expect(app.getByTestId("pare")).not.toHaveClass(/pare--fullscreen/);
});
