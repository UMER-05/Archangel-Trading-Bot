export default async function run(page, ui) {
  await page.waitForTimeout(1500);
  const before = await ui.snapshot();

  // Find any row/link that looks like a token click target
  const rowMatch = before.match(/@(e\d+) row(?: "[^"]*")?/i) ||
    before.match(/@(e\d+) (?:button|link|cell)[^\n]*"[A-Za-z0-9]+"/);

  if (!rowMatch) {
    return { error: "no clickable token row found in snapshot", snapshot: before };
  }

  const ref = "@" + rowMatch[1];
  const urlBefore = page.url();
  await ui.click(ref);
  await page.waitForTimeout(1000);

  // Wait for URL to change to /trading/<mint>
  try {
    await page.waitForFunction(
      (prevUrl) => window.location.href !== prevUrl && /\/trading\/[A-Za-z0-9]+/.test(window.location.pathname),
      urlBefore,
      { timeout: 8000 }
    );
  } catch (e) {
    return {
      error: "URL did not change to /trading/<mint> after click",
      urlBefore,
      urlAfter: page.url(),
      clickedRef: ref,
    };
  }

  const urlAfter = page.url();

  // Wait for the page to resolve out of the loading state (either real data or an error message)
  let finalText = "";
  try {
    await page.waitForFunction(
      () => !document.body.innerText.includes("Loading token details"),
      { timeout: 15000 }
    );
    finalText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  } catch (e) {
    finalText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    return {
      stuckLoading: true,
      urlAfter,
      bodyTextAfterTimeout: finalText,
    };
  }

  const screenshotPath = "C:/Users/VP/AppData/Local/Temp/claude/c--Users-VP-ArchAngel-Bot/163ec78c-a703-4e2d-a7bd-e48c013bbc13/scratchpad/coin-detail.png";
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return {
    urlBefore,
    urlAfter,
    stuckLoading: false,
    bodyText: finalText,
    screenshot: screenshotPath,
  };
}
