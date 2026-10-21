// Only operations that leave mailbox interaction state unchanged may share
// the receive page. Sends and mark-read always have their own task page.
export const isReceiveRead = operation =>
  ['probe', 'read', 'discover', 'capture', 'enumerate_thread', 'collect_page'].includes(operation);

export function mailAccount(input) {
  return (input.account_address ?? input.discovery?.account_address ?? input.target?.account_address ??
    input.thread?.account_address ?? '').toLowerCase();
}
