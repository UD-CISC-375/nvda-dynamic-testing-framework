import { readFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import {
  ANNOTATION_EVAL_ATTACHMENT,
  diffIntendedAndActual,
  parseDeveloperAnnotations,
  parseTriggerSelector,
  type ActualDomSnapshot,
  type ActualDomState,
  type AnnotationEvaluation,
  type DeveloperAnnotations,
  type EvaluationPhase,
} from "../../accessible-markdown-reporter";

export function annotationsFromTestFile(
  filePath: string,
): DeveloperAnnotations {
  return parseDeveloperAnnotations(readFileSync(filePath, "utf8"));
}

async function snapshotBySelector(
  page: Page,
  selector: string | undefined,
): Promise<ActualDomSnapshot | undefined> {
  if (!selector) {
    return undefined;
  }
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) {
    return { found: false, selector, attributes: {} };
  }
  return loc.evaluate((el, sel) => {
    const attributes: Record<string, string | null> = {};
    for (const attr of Array.from(el.attributes)) {
      attributes[attr.name] = attr.value;
    }
    return { found: true, selector: sel, attributes };
  }, selector);
}

export async function captureAccessibleState(
  page: Page,
  annotations: DeveloperAnnotations,
): Promise<ActualDomState> {
  let triggerSelector = parseTriggerSelector(annotations.triggerEvent);
  const targetSelector = annotations.selector;

  if (triggerSelector && (await page.locator(triggerSelector).count()) === 0) {
    if ((await page.getByTestId("trigger").count()) > 0) {
      triggerSelector = "[data-testid='trigger']";
    }
  }

  const trigger = await snapshotBySelector(page, triggerSelector);
  const target =
    targetSelector && targetSelector !== triggerSelector
      ? await snapshotBySelector(page, targetSelector)
      : trigger;

  const content = await page.evaluate(() => {
    const images = Array.from(document.querySelectorAll("img")).map((img) => ({
      alt: img.getAttribute("alt") ?? "",
      selector: img.id ? `#${img.id}` : undefined,
    }));
    return { images };
  });

  return { trigger, target, content };
}

export async function attachAnnotationEvaluation(
  page: Page,
  testInfo: TestInfo,
  options: { phase?: EvaluationPhase; annotations?: DeveloperAnnotations } = {},
): Promise<AnnotationEvaluation> {
  const phase: EvaluationPhase = options.phase ?? "after-trigger";
  const annotations =
    options.annotations ?? annotationsFromTestFile(testInfo.file);
  const actual = await captureAccessibleState(page, annotations);
  const diff = diffIntendedAndActual(annotations, actual, phase);
  const evaluation: AnnotationEvaluation = {
    annotations,
    actual,
    diff,
    phase,
  };

  await testInfo.attach(ANNOTATION_EVAL_ATTACHMENT, {
    body: Buffer.from(JSON.stringify(evaluation, null, 2), "utf8"),
    contentType: "application/json",
  });

  return evaluation;
}
