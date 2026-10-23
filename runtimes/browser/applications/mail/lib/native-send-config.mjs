// Release configuration of the network-native send. A value changes only with
// a paired release; there is no environment override. The response-ID receipt
// stays off until a live check proves that the provider's response identifier
// is the Sent row's identifier (QQ: mailid == emailid).
import {QQ_NATIVE_SEND} from './qq-native-send.mjs';

export const NATIVE_SEND_RELEASE = Object.freeze({
  qq_mail: Object.freeze({enabled: true, receipt_provider_message_id: false}),
});

// Provider modules implement the provider-specific parts. Gmail and Outlook
// keep the DOM flow until each has its own maintained template.
const MODULES = Object.freeze({qq_mail: QQ_NATIVE_SEND});

export const nativeSendModule = provider => MODULES[provider] ?? null;

export function nativeSendProvider(provider, release = NATIVE_SEND_RELEASE) {
  const module = nativeSendModule(provider), config = release?.[provider];
  return module && config?.enabled === true ? {...module, receipt_provider_message_id: config.receipt_provider_message_id === true} : null;
}

// Providers whose send checks the account inside the page declare it, so the
// Gateway admits them from persisted state instead of a pre-send probe.
export const sendAdmission = provider => nativeSendProvider(provider) ? 'in_page' : undefined;
