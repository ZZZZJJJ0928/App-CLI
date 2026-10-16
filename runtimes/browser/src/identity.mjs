import {randomBytes} from 'node:crypto';
import {requireCondition} from './protocol.mjs';

// Lifecycle 3.0 operation identities. The trusted product allocator issues
// `op3.<generation>.<epoch>.<nonce>` with a 128-bit random nonce, so restoring
// an old product database cannot reissue an identity. Scheduled occurrences are
// derived deterministically from their schedule identity and occurrence time.
const COUNTER = '(0|[1-9][0-9]{0,14})';
const NONCE = '([0-9a-f]{32})';
const OPERATION = new RegExp(`^op3\\.${COUNTER}\\.${COUNTER}\\.${NONCE}$`, 'u');
const SCHEDULE = new RegExp(`^sch3\\.${COUNTER}\\.${COUNTER}\\.${NONCE}\\.${COUNTER}\\.${COUNTER}$`, 'u');
const LEGACY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function counter(value) {
  const number = Number(value);
  requireCondition(Number.isSafeInteger(number), 'REQUEST_EPOCH_INVALID');
  return number;
}

export function parseIdentity(key) {
  requireCondition(typeof key === 'string' && LEGACY.test(key));
  let match = OPERATION.exec(key);
  if (match) return {kind: 'operation', generation: counter(match[1]), epoch: counter(match[2]), nonce: match[3]};
  match = SCHEDULE.exec(key);
  if (match) {
    return {kind: 'schedule', generation: counter(match[1]), epoch: counter(match[2]), nonce: match[3],
      schedule_id: `s3.${match[1]}.${match[2]}.${match[3]}`, revision: counter(match[4]), occurrence_ms: counter(match[5])};
  }
  requireCondition(!/^(op|sch)[0-9]*\./u.test(key), 'REQUEST_EPOCH_INVALID');
  return {kind: 'legacy'};
}

export function operationIdentity({generation, epoch}, nonce = randomBytes(16).toString('hex')) {
  requireCondition(Number.isSafeInteger(generation) && generation > 0 && Number.isSafeInteger(epoch) && epoch > 0 &&
    /^[0-9a-f]{32}$/u.test(nonce), 'REQUEST_EPOCH_INVALID');
  return `op3.${generation}.${epoch}.${nonce}`;
}

export function scheduleIdentity({generation, epoch}, nonce = randomBytes(16).toString('hex')) {
  requireCondition(Number.isSafeInteger(generation) && generation > 0 && Number.isSafeInteger(epoch) && epoch > 0 &&
    /^[0-9a-f]{32}$/u.test(nonce), 'REQUEST_EPOCH_INVALID');
  return `s3.${generation}.${epoch}.${nonce}`;
}

export function occurrenceIdentity(scheduleID, revision, occurrenceMs) {
  const match = /^s3\.(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})\.([0-9a-f]{32})$/u.exec(scheduleID);
  requireCondition(match && Number.isSafeInteger(revision) && revision > 0 && Number.isSafeInteger(occurrenceMs) && occurrenceMs >= 0,
    'REQUEST_EPOCH_INVALID');
  return `sch3.${match[1]}.${match[2]}.${match[3]}.${revision}.${occurrenceMs}`;
}
