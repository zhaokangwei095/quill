/**
 * Browser-side entry for the real-page probe.
 *
 * `scanPage` normally runs inside the content script, where its result is
 * turned into a plan by the service worker. For calibration we only want the
 * scan itself: how many fields were found, what label each one came from, and
 * what canonical key the classifier assigned. Returning a plain object keeps
 * the result serialisable across the DevTools boundary (the scan's live element
 * map is deliberately dropped).
 *
 * Bundled by `scripts/probe.mjs` into an IIFE and injected after the saved page
 * has loaded with scripts disabled, so the DOM under test is the DOM that was
 * saved rather than whatever the page's own JavaScript would have rebuilt.
 */

import { detectCompany, detectPageRole, scanPage } from "../extension/src/content/scan.js";

interface ProbeField {
  ref: string;
  kind: string;
  label: string;
  labelSource: string;
  hint: string;
  groupHeading: string;
  name: string;
  placeholder: string;
  key: string;
  confidence: number;
  section: string;
  required: boolean;
  disabled: boolean;
  framework: string;
  optionCount: number;
}

interface ProbeResult {
  url: string;
  title: string;
  siteKey: string;
  ats: string;
  pageRole: string;
  company: string;
  fields: ProbeField[];
}

interface ProbeWindow extends Window {
  __quillProbe?: () => ProbeResult;
}

(globalThis as unknown as ProbeWindow).__quillProbe = (): ProbeResult => {
  const { scan } = scanPage();
  return {
    url: scan.url,
    title: scan.title,
    siteKey: scan.siteKey,
    ats: scan.ats ?? "",
    pageRole: detectPageRole(),
    company: detectCompany(),
    fields: scan.fields.map((field) => ({
      ref: field.ref,
      kind: field.kind,
      label: field.label,
      labelSource: field.labelSource,
      hint: field.hint ?? "",
      groupHeading: field.groupHeading ?? "",
      name: field.name ?? "",
      placeholder: field.placeholder ?? "",
      key: field.key ?? "unknown",
      confidence: field.keyConfidence ?? 0,
      section: field.section,
      required: field.required,
      disabled: field.disabled,
      framework: field.framework ?? "native",
      optionCount: field.options?.length ?? 0,
    })),
  };
};
