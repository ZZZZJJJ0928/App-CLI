#!/usr/bin/env node

import {
  OutlookCliError,
  PROBE_EXPRESSION,
  classifyProbeEvidence,
  hasExactKeys,
  parseProbeEvidence,
  validateInvocationId,
  withOwnedOutlookTab,
} from "./outlook-browser.mjs";

const INPUT_KEYS = [
  "account",
  "invocation_id",
  "operation",
  "provider",
  "schema_version",
];

export async function probeOutlookLogin(rawInput, runtime = {}) {
  const input = validateInput(rawInput);
  const timeoutMs = runtime.timeoutMs ?? 10_000;
  return await withOwnedOutlookTab({
    invocationId: input.invocation_id,
    operation: "probe",
    timeoutMs,
    runtime,
  }, async (tab) => {
    const evidence = parseProbeEvidence(await tab.inspect(PROBE_EXPRESSION));
    return classifyProbeEvidence(evidence);
  });
}

function validateInput(input) {
  if (!hasExactKeys(input, INPUT_KEYS)) throw new OutlookCliError("invalid_request");
  if (
    input.schema_version !== 1 || input.operation !== "probe" ||
    input.provider !== "outlook" || input.account !== "default"
  ) {
    throw new OutlookCliError("invalid_request");
  }
  validateInvocationId(input.invocation_id);
  return input;
}
